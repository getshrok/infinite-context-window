import type { ChunkRecord, Entity, LLMFunction, ResolvedConfig, Store, Logger, PromptOverrides } from './types.js'
import { buildArchiverPrompt } from './prompts.js'

function daysSince(isoDate: string): number {
  const ms = Date.now() - new Date(isoDate).getTime()
  return ms / (1000 * 60 * 60 * 24)
}

function mergeEntities(chunks: ChunkRecord[]): Entity[] {
  const seen = new Map<string, Entity>()
  for (const chunk of chunks) {
    for (const e of chunk.entities) {
      seen.set(e.name.toLowerCase(), e)
    }
  }
  return Array.from(seen.values())
}

function mergeTags(chunks: ChunkRecord[]): string[] {
  return [...new Set(chunks.flatMap(c => c.tags))]
}

function timeRangeOf(chunks: ChunkRecord[]): { start: string; end: string } | null {
  const starts = chunks.flatMap(c => c.timeRange ? [c.timeRange.start] : [])
  const ends = chunks.flatMap(c => c.timeRange ? [c.timeRange.end] : [])
  if (starts.length === 0 || ends.length === 0) return null
  return {
    start: starts.sort()[0] ?? starts[0] ?? '',
    end: ends.sort().at(-1) ?? ends[0] ?? '',
  }
}

async function archiveTopic(
  topicId: string,
  llm: LLMFunction,
  store: Store,
  config: ResolvedConfig,
  logger: Logger,
  prompts?: PromptOverrides | undefined,
): Promise<void> {
  const topic = await store.getTopic(topicId)
  if (!topic) return

  const allChunks = await store.readChunks(topicId)
  if (allChunks.length === 0) return

  const now = new Date().toISOString()

  // Build set of raw chunk IDs already covered by existing group summaries
  const alreadyCovered = new Set<string>()
  for (const c of allChunks) {
    if (c.coversChunkIds) c.coversChunkIds.forEach(id => alreadyCovered.add(id))
  }

  // Only consider raw chunks (no coversChunkIds) that aren't already covered
  const rawChunks = allChunks.filter(c => !c.coversChunkIds && !alreadyCovered.has(c.chunkId))

  const moderate: ChunkRecord[] = []
  const heavy: ChunkRecord[] = []

  for (const chunk of rawChunks) {
    const age = daysSince(chunk.appendedAt)
    if (age > config.archivalHeavyAfterDays) {
      heavy.push(chunk)
    } else if (age > config.archivalModerateAfterDays) {
      moderate.push(chunk)
    }
  }

  logger.info(`[archiver] "${topicId}" — heavy=${heavy.length} moderate=${moderate.length} uncovered raw (${allChunks.length} total records)`)

  if (heavy.length > 0) {
    const { system, user } = buildArchiverPrompt(topic.label, heavy, 'heavy', { systemPromptOverride: prompts?.archiver })
    let summary = ''
    try {
      summary = (await llm(system, user)).trim()
    } catch (err) {
      logger.warn(`[archiver] heavy archival failed for "${topicId}" — keeping originals (${(err as Error).message})`)
    }

    if (summary) {
      await store.appendChunk(topicId, {
        chunkId: `archival_${topicId}_heavy_${Date.now()}`,
        messages: [{ role: 'assistant', content: summary }],
        summary,
        entities: mergeEntities(heavy),
        tags: mergeTags(heavy),
        timeRange: timeRangeOf(heavy),
        appendedAt: now,
        archived: true,
        archivalLevel: 'heavy',
        coversChunkIds: heavy.map(c => c.chunkId),
      })
      logger.debug(`[archiver] heavy: ${heavy.length} raw chunks → group summary appended`)
    }
  }

  if (moderate.length > 0) {
    const { system, user } = buildArchiverPrompt(topic.label, moderate, 'moderate', { systemPromptOverride: prompts?.archiver })
    let summary = ''
    try {
      summary = (await llm(system, user)).trim()
    } catch (err) {
      logger.warn(`[archiver] moderate archival failed for "${topicId}" — keeping originals (${(err as Error).message})`)
    }

    if (summary) {
      await store.appendChunk(topicId, {
        chunkId: `archival_${topicId}_moderate_${Date.now()}`,
        messages: [{ role: 'assistant', content: summary }],
        summary,
        entities: mergeEntities(moderate),
        tags: mergeTags(moderate),
        timeRange: timeRangeOf(moderate),
        appendedAt: now,
        archived: true,
        archivalLevel: 'moderate',
        coversChunkIds: moderate.map(c => c.chunkId),
      })
      logger.debug(`[archiver] moderate: ${moderate.length} raw chunks → group summary appended`)
    }
  }

  if (heavy.length === 0 && moderate.length === 0) {
    logger.debug(`[archiver] "${topicId}" — nothing to archive`)
    return
  }

  // Update topic token estimate: count uncovered raw chunks + group summaries
  const updatedChunks = await store.readChunks(topicId)
  const newCovered = new Set<string>()
  for (const c of updatedChunks) {
    if (c.coversChunkIds) c.coversChunkIds.forEach(id => newCovered.add(id))
  }
  const effectiveChunks = updatedChunks.filter(c => !c.coversChunkIds || c.coversChunkIds.length > 0)
    .filter(c => !newCovered.has(c.chunkId))

  const tokenEst = config.tokenCounter(
    effectiveChunks.flatMap(c => c.messages).map(m => m.content).join('\n'),
  )

  await store.upsertTopic({
    ...topic,
    estimatedTokens: tokenEst,
    chunkCount: updatedChunks.length,
    lastUpdatedAt: now,
  })

  logger.info(`[archiver] "${topicId}" done — ${updatedChunks.length} total records, ~${tokenEst} effective tokens`)
}

export async function archive(
  llm: LLMFunction,
  store: Store,
  config: ResolvedConfig,
  logger: Logger,
  topicId?: string,
  prompts?: PromptOverrides | undefined,
): Promise<void> {
  if (topicId) {
    await archiveTopic(topicId, llm, store, config, logger, prompts)
    return
  }

  const topics = await store.getAllTopics()
  const eligible = topics.filter(t => t.estimatedTokens > config.archivalThreshold)
  logger.debug(`[archiver] scan: ${eligible.length}/${topics.length} topics over threshold (${config.archivalThreshold} tokens)`)

  for (const topic of eligible) {
    await archiveTopic(topic.topicId, llm, store, config, logger, prompts)
  }
}
