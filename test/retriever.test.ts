import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import { retrieve, retrieveByTopicIds } from '../src/retriever.js'
import type { Topic, ChunkRecord, ResolvedConfig, Logger } from '../src/types.js'

let tmpDir: string
let store: FileStore

const logger: Logger = { info: () => {}, warn: () => {}, debug: () => {} }

const config: ResolvedConfig = {
  retrievalTokenBudget: 10_000,
  archivalThreshold: 50_000,
  archivalModerateAfterDays: 14,
  archivalHeavyAfterDays: 60,
  maxChunksPerConversation: 20,
  tokenCounter: (t: string) => Math.ceil(t.length / 4),
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-retriever-test-'))
  store = new FileStore(tmpDir)
  await store.initialize()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeMockLLM(responses: string[]) {
  const queue = [...responses]
  return async (_sys: string, _user: string): Promise<string> => queue.shift() ?? ''
}

function makeTopic(overrides: Partial<Topic> & { topicId: string; label: string }): Topic {
  return {
    summary: 'A topic.',
    entities: [],
    tags: [],
    firstSeenAt: '2024-01-01T00:00:00.000Z',
    lastUpdatedAt: '2024-01-01T00:00:00.000Z',
    estimatedTokens: 1000,
    chunkCount: 1,
    ...overrides,
  }
}

function makeChunk(topicId: string, content: string, overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    chunkId: `chunk_${topicId}_${Math.random().toString(36).slice(2, 6)}`,
    messages: [{ role: 'user', content }],
    summary: `Summary: ${content}`,
    entities: [],
    tags: [],
    timeRange: null,
    appendedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('retrieve — basic behavior', () => {
  it('returns empty array when no topics exist', async () => {
    const llm = makeMockLLM(['[]'])
    const results = await retrieve('test query', llm, store, config, logger)
    expect(results).toEqual([])
  })

  it('returns topics in ranked order with topic summary always present', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'Topic A', summary: 'Summary A' }))
    await store.upsertTopic(makeTopic({ topicId: 'topic-b', label: 'Topic B', summary: 'Summary B' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Content A'))
    await store.appendChunk('topic-b', makeChunk('topic-b', 'Content B'))

    const llm = makeMockLLM([JSON.stringify(['topic-b', 'topic-a'])])
    const results = await retrieve('query', llm, store, config, logger)

    expect(results).toHaveLength(2)
    expect(results[0]?.topicId).toBe('topic-b')
    expect(results[1]?.topicId).toBe('topic-a')
    expect(results[0]?.summary).toBe('Summary B')
    expect(results[1]?.summary).toBe('Summary A')
  })

  it('chunks within budget are returned as raw', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'Topic A' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Short content.'))

    const llm = makeMockLLM([JSON.stringify(['topic-a'])])
    const results = await retrieve('query', llm, store, config, logger)

    expect(results[0]?.chunks[0]?.raw).toBe(true)
    expect(results[0]?.chunks[0]?.messages).toHaveLength(1)
    expect(results[0]?.chunks[0]?.messages[0]?.content).toBe('Short content.')
  })

  it('filters out unknown topicIds from router response', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'real-topic', label: 'Real' }))
    await store.appendChunk('real-topic', makeChunk('real-topic', 'Real content'))

    const llm = makeMockLLM([JSON.stringify(['fake-topic', 'real-topic'])])
    const results = await retrieve('query', llm, store, config, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe('real-topic')
  })

  it('returns empty on LLM parse failure', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    const llm = makeMockLLM(['not json'])
    const results = await retrieve('query', llm, store, config, logger)
    expect(results).toEqual([])
  })

  it('returns empty when LLM returns empty array', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    const llm = makeMockLLM(['[]'])
    const results = await retrieve('query', llm, store, config, logger)
    expect(results).toEqual([])
  })
})

describe('retrieve — tiered budget', () => {
  it('falls back to summary for chunks that exceed budget', async () => {
    // Real char/4 counter. Budget=7 tokens.
    // Each chunk's messages = ~5 tokens, summary = ~1 token.
    // Newest chunk fits as raw (5 ≤ 7), older chunk raw would bring total to 10 (too much),
    // but its summary brings total to 6 (fits).
    const tightConfig = { ...config, retrievalTokenBudget: 7 }

    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    const now = new Date()

    await store.appendChunk('topic-a', {
      chunkId: 'older',
      messages: [{ role: 'user', content: 'Older message text.' }],  // 19 chars ≈ 5 tokens
      summary: 'Old.',                                                  // 4 chars = 1 token
      entities: [], tags: [], timeRange: null,
      appendedAt: new Date(now.getTime() - 10000).toISOString(),
    })
    await store.appendChunk('topic-a', {
      chunkId: 'newer',
      messages: [{ role: 'user', content: 'Newer message text.' }],  // 19 chars ≈ 5 tokens
      summary: 'New.',                                                  // 4 chars = 1 token
      entities: [], tags: [], timeRange: null,
      appendedAt: now.toISOString(),
    })

    const llm = makeMockLLM([JSON.stringify(['topic-a'])])
    const results = await retrieve('query', llm, store, tightConfig, logger)

    const chunks = results[0]?.chunks ?? []
    expect(chunks.length).toBe(2)
    const rawChunks = chunks.filter(c => c.raw)
    const summaryChunks = chunks.filter(c => !c.raw)
    expect(rawChunks.length).toBe(1)
    expect(summaryChunks.length).toBe(1)
    expect(summaryChunks[0]?.messages).toHaveLength(0)
    expect(summaryChunks[0]?.summary).toBeTruthy()
  })

  it('topic summary always present even when budget is fully exhausted', async () => {
    // Budget so tiny nothing fits
    const zeroBudget = { ...config, retrievalTokenBudget: 0 }

    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A', summary: 'Always here.' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Content that does not fit.'))

    const llm = makeMockLLM([JSON.stringify(['topic-a'])])
    const results = await retrieve('query', llm, store, zeroBudget, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.summary).toBe('Always here.')
    // No chunks fit — chunks array is empty, topic summary is the floor
    expect(results[0]?.chunks).toHaveLength(0)
  })

  it('overrides budget with tokenBudget parameter', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Short.'))

    const llm = makeMockLLM([JSON.stringify(['topic-a'])])
    // Override with large budget
    const results = await retrieve('query', llm, store, config, logger, 100_000)
    expect(results[0]?.chunks[0]?.raw).toBe(true)
  })
})

describe('retrieveByTopicIds', () => {
  it('returns RetrieveResult for a valid topicId with timeRange on chunks', async () => {
    const timeRange = { start: '2024-01-15T00:00:00.000Z', end: '2024-01-16T00:00:00.000Z' }
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'Topic A', summary: 'A summary.' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Hello world.', { timeRange }))

    const results = await retrieveByTopicIds(
      [{ topicId: 'topic-a', budgetTokens: 10_000 }],
      store,
      config.tokenCounter,
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe('topic-a')
    expect(results[0]?.summary).toBe('A summary.')
    expect(results[0]?.chunks[0]?.raw).toBe(true)
    expect(results[0]?.chunks[0]?.timeRange).toEqual(timeRange)
  })

  it('returns empty array for unknown topicIds', async () => {
    const results = await retrieveByTopicIds(
      [{ topicId: 'does-not-exist', budgetTokens: 10_000 }],
      store,
      config.tokenCounter,
    )
    expect(results).toHaveLength(0)
  })

  it('returns chunks in chronological order (oldest first)', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    const now = Date.now()
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Older.', {
      chunkId: 'older',
      appendedAt: new Date(now - 10000).toISOString(),
    }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Newer.', {
      chunkId: 'newer',
      appendedAt: new Date(now).toISOString(),
    }))

    const results = await retrieveByTopicIds(
      [{ topicId: 'topic-a', budgetTokens: 10_000 }],
      store,
      config.tokenCounter,
    )

    const ids = results[0]?.chunks.map(c => c.chunkId) ?? []
    expect(ids).toEqual(['older', 'newer'])
  })

  it('respects per-topic budgetTokens (raw → summary tiering)', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    const now = Date.now()

    // Two chunks; tight budget lets only 1 fit as raw
    await store.appendChunk('topic-a', {
      chunkId: 'older',
      messages: [{ role: 'user', content: 'Older message text.' }],  // ~5 tokens
      summary: 'Old.',
      entities: [], tags: [], timeRange: null,
      appendedAt: new Date(now - 10000).toISOString(),
    })
    await store.appendChunk('topic-a', {
      chunkId: 'newer',
      messages: [{ role: 'user', content: 'Newer message text.' }],  // ~5 tokens
      summary: 'New.',
      entities: [], tags: [], timeRange: null,
      appendedAt: new Date(now).toISOString(),
    })

    const results = await retrieveByTopicIds(
      [{ topicId: 'topic-a', budgetTokens: 7 }],  // tight — newest raw, older summary
      store,
      config.tokenCounter,
    )

    const chunks = results[0]?.chunks ?? []
    expect(chunks).toHaveLength(2)
    // Chronological: older first, newer last
    expect(chunks[0]?.chunkId).toBe('older')
    expect(chunks[0]?.raw).toBe(false)  // summary-only (budget exhausted after newer)
    expect(chunks[1]?.chunkId).toBe('newer')
    expect(chunks[1]?.raw).toBe(true)   // raw — newest gets budget first
  })

  it('handles multiple topic requests independently', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A', summary: 'Summary A' }))
    await store.upsertTopic(makeTopic({ topicId: 'topic-b', label: 'B', summary: 'Summary B' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Content A'))
    await store.appendChunk('topic-b', makeChunk('topic-b', 'Content B'))

    const results = await retrieveByTopicIds(
      [
        { topicId: 'topic-a', budgetTokens: 10_000 },
        { topicId: 'topic-b', budgetTokens: 10_000 },
      ],
      store,
      config.tokenCounter,
    )

    expect(results).toHaveLength(2)
    expect(results[0]?.topicId).toBe('topic-a')
    expect(results[1]?.topicId).toBe('topic-b')
  })
})

describe('retrieve — group summary records', () => {
  it('uses group summary in place of covered raw chunks', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))

    const coveredChunk = makeChunk('topic-a', 'Old raw content.', {
      chunkId: 'old-raw',
      appendedAt: new Date(Date.now() - 86400000).toISOString(),
    })
    await store.appendChunk('topic-a', coveredChunk)

    // Group summary covering the old chunk
    await store.appendChunk('topic-a', {
      chunkId: 'group-sum',
      messages: [{ role: 'assistant', content: 'Group summary of old content.' }],
      summary: 'Group summary of old content.',
      entities: [],
      tags: [],
      timeRange: null,
      appendedAt: new Date().toISOString(),
      archived: true,
      archivalLevel: 'heavy',
      coversChunkIds: ['old-raw'],
    })

    const llm = makeMockLLM([JSON.stringify(['topic-a'])])
    const results = await retrieve('query', llm, store, config, logger)

    const chunks = results[0]?.chunks ?? []
    // Should see the group summary, not the covered raw chunk
    const ids = chunks.map(c => c.chunkId)
    expect(ids).toContain('group-sum')
    expect(ids).not.toContain('old-raw')
  })
})
