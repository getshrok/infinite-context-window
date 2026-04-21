import type { LLMFunction, ResolvedConfig, RetrieveResult, TieredChunk, RouterLLMOutput, TokenCounter, Store, Logger, ChunkRecord, PromptOverrides, GraphStore } from './types.js'
import { buildRouterPrompt } from './prompts.js'

function parseRouterResponse(raw: string): RouterLLMOutput {
  const cleaned = raw
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim()
  const parsed: unknown = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) return []
  return (parsed as unknown[]).filter((x): x is string => typeof x === 'string')
}

// ─── Shared budget-filling logic ─────────────────────────────────────────────

export function fillBudget(
  allChunks: ChunkRecord[],
  budget: number,
  tokenCounter: TokenCounter,
  startingTokens = 0,
): { tiered: TieredChunk[]; tokensUsed: number } {
  // Build set of raw chunk IDs covered by group summaries
  const coveredIds = new Set<string>()
  for (const c of allChunks) {
    if (c.coversChunkIds) c.coversChunkIds.forEach(id => coveredIds.add(id))
  }

  // Group summaries + uncovered raw chunks, sorted newest → oldest for budget fill
  const candidates = allChunks
    .filter(c => c.coversChunkIds != null || !coveredIds.has(c.chunkId))
    .sort((a, b) => b.appendedAt.localeCompare(a.appendedAt))

  let tokensUsed = startingTokens
  const tiered: TieredChunk[] = []

  for (const chunk of candidates) {
    const rawCost = tokenCounter(chunk.messages.map(m => m.content).join('\n'))
    const sumCost = tokenCounter(chunk.summary)

    if (tokensUsed + rawCost <= budget) {
      tiered.push({ chunkId: chunk.chunkId, messages: chunk.messages, summary: chunk.summary, tags: chunk.tags, raw: true, timeRange: chunk.timeRange })
      tokensUsed += rawCost
    } else if (tokensUsed + sumCost <= budget) {
      tiered.push({ chunkId: chunk.chunkId, messages: [], summary: chunk.summary, tags: chunk.tags, raw: false, timeRange: chunk.timeRange })
      tokensUsed += sumCost
    }
    // else: budget exhausted for this chunk
  }

  tiered.reverse() // back to chronological order
  return { tiered, tokensUsed }
}

// ─── Graph hint extraction ───────────────────────────────────────────────────

async function extractGraphHints(query: string, graphStore: GraphStore, logger: Logger): Promise<string[]> {
  const allEntities = await graphStore.getAllEntities()
  if (allEntities.length === 0) return []

  const queryLower = query.toLowerCase()
  const matchedEntities: string[] = []

  for (const entity of allEntities) {
    // Word-boundary check to reduce false positives for short entity names
    const pattern = new RegExp(`\\b${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (pattern.test(queryLower)) {
      matchedEntities.push(entity)
    }
  }

  if (matchedEntities.length === 0) return []

  const hintTopics = new Set<string>()
  for (const entity of matchedEntities) {
    const topics = await graphStore.getTopicsForEntity(entity)
    for (const t of topics) hintTopics.add(t)
  }

  logger.debug(`[retriever] graph hints: entities=[${matchedEntities.join(', ')}] → ${hintTopics.size} topic(s)`)
  return [...hintTopics]
}

// ─── Main retrieval ──────────────────────────────────────────────────────────

export async function retrieve(
  query: string,
  llm: LLMFunction,
  store: Store,
  config: ResolvedConfig,
  logger: Logger,
  tokenBudget?: number,
  prompts?: PromptOverrides | undefined,
  graphStore?: GraphStore | undefined,
): Promise<RetrieveResult[]> {
  const topics = await store.getAllTopics()
  if (topics.length === 0) {
    logger.debug('[retriever] no topics in index — returning empty')
    return []
  }

  logger.debug(`[retriever] routing query across ${topics.length} topic(s): "${query}"`)

  // Extract graph hints if graph store is available
  let graphHints: string[] | undefined
  if (graphStore) {
    graphHints = await extractGraphHints(query, graphStore, logger)
  }

  const { system, user } = buildRouterPrompt(query, topics, {
    systemPromptOverride: prompts?.router,
    graphHints,
  })

  let rankedIds: RouterLLMOutput
  try {
    const raw = await llm(system, user)
    rankedIds = parseRouterResponse(raw)
  } catch (err) {
    logger.warn(`[retriever] failed to get or parse router response — ${(err as Error).message}`)
    return []
  }

  const topicIdSet = new Set(topics.map(t => t.topicId))
  const unknownIds = rankedIds.filter(id => !topicIdSet.has(id))
  if (unknownIds.length > 0) {
    logger.warn(`[retriever] router returned unknown topicIds (filtered out): ${unknownIds.join(', ')}`)
  }
  const validIds = rankedIds.filter(id => topicIdSet.has(id))

  logger.debug(`[retriever] router selected ${validIds.length}/${topics.length} topic(s): ${validIds.join(', ') || '(none)'}`)

  const budget = tokenBudget ?? config.retrievalTokenBudget
  const results: RetrieveResult[] = []
  let totalTokens = 0

  for (const topicId of validIds) {
    const topic = topics.find(t => t.topicId === topicId)
    if (!topic) continue

    const allChunks = await store.readChunks(topicId)
    const { tiered, tokensUsed } = fillBudget(allChunks, budget, config.tokenCounter, totalTokens)
    totalTokens = tokensUsed

    results.push({ topicId, label: topic.label, summary: topic.summary, chunks: tiered })
    logger.debug(`[retriever] included "${topicId}" — ${tiered.filter(c => c.raw).length} raw, ${tiered.filter(c => !c.raw).length} summary-only chunk(s)`)
  }

  logger.info(`[retriever] returned ${results.length} topic(s), ~${totalTokens} tokens`)
  return results
}

// ─── Retrieve by entity (graph traversal, no LLM) ───────────────────────────

export async function retrieveByEntity(
  entityName: string,
  store: Store,
  graphStore: GraphStore,
  tokenCounter: TokenCounter,
  tokenBudget: number,
  logger: Logger,
): Promise<RetrieveResult[]> {
  // Direct topics for this entity
  const directTopics = await graphStore.getTopicsForEntity(entityName)

  // 1-hop: related entities → their topics
  const relations = await graphStore.getRelationsForEntity(entityName)
  const relatedEntities = new Set<string>()
  for (const rel of relations) {
    relatedEntities.add(rel.source.toLowerCase())
    relatedEntities.add(rel.target.toLowerCase())
  }
  relatedEntities.delete(entityName.trim().toLowerCase()) // remove self

  const hopTopics = new Set<string>()
  for (const related of relatedEntities) {
    const topics = await graphStore.getTopicsForEntity(related)
    for (const t of topics) hopTopics.add(t)
  }

  // Combine: direct first, then 1-hop (deduped)
  const directSet = new Set(directTopics)
  const orderedTopicIds = [...directTopics]
  for (const t of hopTopics) {
    if (!directSet.has(t)) orderedTopicIds.push(t)
  }

  if (orderedTopicIds.length === 0) {
    logger.debug(`[retriever] retrieveByEntity: no topics found for entity "${entityName}"`)
    return []
  }

  logger.debug(`[retriever] retrieveByEntity: "${entityName}" → ${orderedTopicIds.length} topic(s) (${directTopics.length} direct, ${hopTopics.size} 1-hop)`)

  const results: RetrieveResult[] = []
  let totalTokens = 0

  for (const topicId of orderedTopicIds) {
    const topic = await store.getTopic(topicId)
    if (!topic) continue

    const allChunks = await store.readChunks(topicId)
    const { tiered, tokensUsed } = fillBudget(allChunks, tokenBudget, tokenCounter, totalTokens)
    totalTokens = tokensUsed

    results.push({ topicId, label: topic.label, summary: topic.summary, chunks: tiered })
  }

  logger.info(`[retriever] retrieveByEntity: returned ${results.length} topic(s), ~${totalTokens} tokens`)
  return results
}

export async function retrieveByTopicIds(
  requests: Array<{ topicId: string; budgetTokens: number }>,
  store: Store,
  tokenCounter: TokenCounter,
): Promise<RetrieveResult[]> {
  const results: RetrieveResult[] = []

  for (const { topicId, budgetTokens } of requests) {
    const topic = await store.getTopic(topicId)
    if (!topic) continue

    const allChunks = await store.readChunks(topicId)
    const { tiered } = fillBudget(allChunks, budgetTokens, tokenCounter)

    results.push({ topicId, label: topic.label, summary: topic.summary, chunks: tiered })
  }

  return results
}
