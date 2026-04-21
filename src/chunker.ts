import type { Message, ChunkerLLMOutput, LLMFunction, ResolvedConfig, Store, Logger, PromptOverrides, Topic, GraphStore, Relation } from './types.js'
import { buildChunkerPrompt, buildSummaryUpdatePrompt } from './prompts.js'

function parseChunkerResponse(raw: string): ChunkerLLMOutput {
  const cleaned = raw
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) return []
  return parsed as ChunkerLLMOutput
}

function estimateTokens(counter: ResolvedConfig['tokenCounter'], messages: Message[]): number {
  return counter(messages.map(m => m.content).join('\n'))
}

export async function chunk(
  conversation: Message[],
  llm: LLMFunction,
  store: Store,
  config: ResolvedConfig,
  logger: Logger,
  prompts?: PromptOverrides | undefined,
  graphStore?: GraphStore | undefined,
): Promise<void> {
  if (conversation.length === 0) return

  const existingTopics = await store.getAllTopics()
  const existingTopicIds = new Set(existingTopics.map(t => t.topicId))

  logger.debug(`[chunker] processing ${conversation.length} messages against ${existingTopics.length} existing topics`)

  const { system, user } = buildChunkerPrompt(
    conversation,
    existingTopics.map(t => ({ topicId: t.topicId, label: t.label, summary: t.summary, tags: t.tags })),
    { systemPromptOverride: prompts?.chunker, graphEnabled: !!graphStore },
  )

  let chunkOutputs: ChunkerLLMOutput
  try {
    const raw = await llm(system, user)
    chunkOutputs = parseChunkerResponse(raw)
  } catch (err) {
    logger.warn(`[chunker] failed to get or parse LLM response — ${(err as Error).message}`)
    return
  }

  const before = chunkOutputs.length
  chunkOutputs = chunkOutputs.slice(0, config.maxChunksPerConversation)
  if (chunkOutputs.length < before) {
    logger.warn(`[chunker] truncated ${before} chunks to maxChunksPerConversation (${config.maxChunksPerConversation})`)
  }

  logger.debug(`[chunker] LLM returned ${chunkOutputs.length} chunk(s)`)

  const now = new Date().toISOString()
  const touchedTopics = new Set<string>()
  const pendingTopics = new Map<string, Topic>()
  const graphRelations: Relation[] = []

  for (const output of chunkOutputs) {
    const validIndices = (output.messageIndices ?? []).filter(
      i => typeof i === 'number' && i >= 0 && i < conversation.length,
    )
    if (validIndices.length === 0) {
      logger.warn(`[chunker] chunk "${output.suggestedLabel}" has no valid messageIndices — skipping`)
      continue
    }

    const messages = validIndices.map(i => conversation[i]).filter((m): m is Message => m !== undefined)

    let topicId: string
    const isNewTopic = !output.matchedTopicId || !existingTopicIds.has(output.matchedTopicId)

    if (isNewTopic) {
      topicId = await store.generateTopicId(output.suggestedLabel || 'topic')
      logger.info(`[chunker] created topic "${topicId}" — "${output.suggestedLabel}" (${messages.length} messages)`)
    } else {
      topicId = output.matchedTopicId as string
      logger.info(`[chunker] appended to topic "${topicId}" — "${output.suggestedLabel}" (${messages.length} messages)`)
    }

    const chunkRecord = {
      chunkId: `chunk_${topicId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      messages,
      summary: output.summary ?? '',
      entities: Array.isArray(output.entities) ? output.entities : [],
      tags: Array.isArray(output.tags) ? output.tags : [],
      timeRange: output.timeRange ?? null,
      appendedAt: now,
    }

    await store.appendChunk(topicId, chunkRecord)
    touchedTopics.add(topicId)

    if (isNewTopic) {
      existingTopicIds.add(topicId)
      const tokenEst = estimateTokens(config.tokenCounter, messages)
      pendingTopics.set(topicId, {
        topicId,
        label: output.suggestedLabel || 'Untitled',
        summary: '',
        entities: Array.isArray(output.entities) ? output.entities : [],
        tags: Array.isArray(output.tags) ? output.tags : [],
        firstSeenAt: messages[0]?.timestamp ?? now,
        lastUpdatedAt: now,
        estimatedTokens: tokenEst,
        chunkCount: 1,
      })
    }

    // Collect relations for graph if present
    if (graphStore && Array.isArray(output.relations)) {
      for (const rel of output.relations) {
        if (rel.source && rel.relation && rel.target) {
          graphRelations.push({
            source: rel.source,
            relation: rel.relation,
            target: rel.target,
            topicIds: [topicId],
            chunkIds: [chunkRecord.chunkId],
            firstSeen: now,
            lastSeen: now,
          })
        }
      }
    }
  }

  for (const topicId of touchedTopics) {
    const topic = pendingTopics.get(topicId) ?? await store.getTopic(topicId)
    if (!topic) continue

    const allChunks = await store.readChunks(topicId)
    const { system: sSys, user: sUser } = buildSummaryUpdatePrompt(topic.label, allChunks, { systemPromptOverride: prompts?.summaryUpdate })

    let newSummary = topic.summary
    try {
      newSummary = (await llm(sSys, sUser)).trim()
      logger.debug(`[chunker] updated summary for "${topicId}"`)
    } catch (err) {
      logger.warn(`[chunker] failed to update summary for "${topicId}" — ${(err as Error).message}`)
    }

    const tokenEst = estimateTokens(
      config.tokenCounter,
      allChunks.flatMap(c => c.messages),
    )

    pendingTopics.set(topicId, {
      ...topic,
      summary: newSummary,
      estimatedTokens: tokenEst,
      chunkCount: allChunks.length,
      lastUpdatedAt: now,
    })
  }

  // Flush all pending topic upserts in a single batch
  if (pendingTopics.size > 0) {
    const batch = Array.from(pendingTopics.values())
    if (store.upsertTopics) {
      await store.upsertTopics(batch)
    } else {
      for (const t of batch) await store.upsertTopic(t)
    }
  }

  // Upsert graph relations if any were collected
  if (graphStore && graphRelations.length > 0) {
    await graphStore.upsertRelations(graphRelations)
    logger.debug(`[chunker] upserted ${graphRelations.length} relation(s) to graph`)
  }

  logger.debug(`[chunker] done — ${touchedTopics.size} topic(s) updated`)
}
