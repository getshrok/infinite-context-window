import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import { retrieve } from '../src/retriever.js'
import type { Topic, ChunkRecord, ResolvedConfig, Logger } from '../src/types.js'

let tmpDir: string
let store: FileStore

const logger: Logger = { info: () => {}, warn: () => {}, debug: () => {} }

const config: ResolvedConfig = {
  retrievalTokenBudget: 32_000,
  archivalThreshold: 50_000,
  archivalModerateAfterDays: 14,
  archivalHeavyAfterDays: 60,
  maxChunksPerConversation: 20,
  tokenCounter: (t: string) => Math.ceil(t.length / 4),
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-retrieval-budget-test-'))
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

// ─── Scenario 5 — Retrieval Under Budget Pressure ────────────────────────────

describe('Scenario 5 — Retrieval Under Budget Pressure', () => {
  it('ranks most-relevant topic first and stays within budget per topic', async () => {
    // Create 3 topics.
    const spainId = 'spain-trip'
    const alphaId = 'project-alpha'
    const groceryId = 'grocery-shopping'

    await store.upsertTopic(makeTopic({
      topicId: spainId,
      label: 'Spain Trip',
      summary: 'Planning a vacation trip to Spain, visiting Barcelona and Madrid.',
    }))
    await store.upsertTopic(makeTopic({
      topicId: alphaId,
      label: 'Work Project Alpha',
      summary: 'Project Alpha is a new internal tool for the engineering team.',
    }))
    await store.upsertTopic(makeTopic({
      topicId: groceryId,
      label: 'Grocery Shopping',
      summary: 'Weekly grocery list and meal planning notes.',
    }))

    await store.appendChunk(spainId, makeChunk(spainId, 'Looking at flights and hotels in Barcelona for the Spain vacation.'))
    await store.appendChunk(alphaId, makeChunk(alphaId, 'Project Alpha sprint planning for Q2.'))
    await store.appendChunk(groceryId, makeChunk(groceryId, 'Buy milk, eggs, and bread this week.'))

    // Router returns topics ordered by relevance: Spain Trip first.
    const routerResponse = JSON.stringify([spainId, alphaId, groceryId])

    // Tiny budget: only enough for the Spain Trip chunk as raw (~17 tokens for the content).
    // The Spain Trip chunk content is "Looking at flights and hotels in Barcelona for the Spain vacation."
    // = 65 chars ≈ 17 tokens. Budget of 20 fits Spain Trip raw, then exhausted for the rest.
    const tinyBudgetConfig: ResolvedConfig = { ...config, retrievalTokenBudget: 20 }
    const llm = makeMockLLM([routerResponse])

    const results = await retrieve('vacation plans to Spain', llm, store, tinyBudgetConfig, logger)

    // All 3 topics are returned (the retriever always includes every routed topic).
    expect(results).toHaveLength(3)

    // Spain Trip must be first — it is the most relevant topic per the router response.
    expect(results[0]?.topicId).toBe(spainId)
    expect(results[0]?.label).toBe('Spain Trip')

    // Topic summary (the floor) is always present regardless of budget.
    expect(results[0]?.summary).toContain('Spain')

    // Spain Trip chunk fits as raw in the budget.
    expect(results[0]?.chunks[0]?.raw).toBe(true)

    // After the Spain Trip chunk consumes the budget, subsequent topics get empty chunks.
    // (Their topic summaries are still present as the floor.)
    expect(results[1]?.topicId).toBe(alphaId)
    expect(results[1]?.summary).toBeTruthy()
    expect(results[2]?.topicId).toBe(groceryId)
    expect(results[2]?.summary).toBeTruthy()

    // Total token cost of all raw chunks stays within the budget.
    let totalTokens = 0
    for (const result of results) {
      for (const c of result.chunks) {
        totalTokens += c.raw
          ? tinyBudgetConfig.tokenCounter(c.messages.map(m => m.content).join('\n'))
          : tinyBudgetConfig.tokenCounter(c.summary)
      }
    }
    expect(totalTokens).toBeLessThanOrEqual(20)
  })

  it('returns most-relevant topic first even when less-relevant topics sort earlier alphabetically', async () => {
    // "A Topic" sorts alphabetically before "Spain Trip" — routing order must win.
    const spainId = 'spain-trip'
    const earlyAlphaId = 'a-topic'

    await store.upsertTopic(makeTopic({
      topicId: spainId,
      label: 'Spain Trip',
      summary: 'Vacation plans to Spain.',
    }))
    await store.upsertTopic(makeTopic({
      topicId: earlyAlphaId,
      label: 'A Topic',
      summary: 'Unrelated topic that sorts first alphabetically.',
    }))

    await store.appendChunk(spainId, makeChunk(spainId, 'Spain holiday flights booked.'))
    await store.appendChunk(earlyAlphaId, makeChunk(earlyAlphaId, 'Unrelated content here.'))

    // Router ranks Spain Trip first.
    const routerResponse = JSON.stringify([spainId, earlyAlphaId])
    const llm = makeMockLLM([routerResponse])

    const results = await retrieve('vacation plans to Spain', llm, store, config, logger)

    // Both topics returned, but Spain Trip is first (routing order preserved).
    expect(results).toHaveLength(2)
    expect(results[0]?.topicId).toBe(spainId)
    expect(results[1]?.topicId).toBe(earlyAlphaId)
  })
})

// ─── Scenario 15b — Budget Overflow ──────────────────────────────────────────

describe('Scenario 15b — Budget Overflow', () => {
  it('returns topic summary floor and does not crash when budget is 1 token', async () => {
    const topicId = 'large-topic'
    await store.upsertTopic(makeTopic({
      topicId,
      label: 'Large Topic',
      summary: 'A topic with lots of content that cannot fit in a tiny budget.',
    }))

    // Add 5 chunks with substantial content.
    for (let i = 0; i < 5; i++) {
      await store.appendChunk(topicId, makeChunk(
        topicId,
        `This is chunk number ${i + 1} with a substantial amount of content. It contains important details about the subject matter that would normally be retrieved, but the budget is too small.`,
        { chunkId: `big-chunk-${i}` },
      ))
    }

    const routerResponse = JSON.stringify([topicId])
    // Budget of 1: nothing fits as raw or summary (each chunk's content is 100+ tokens).
    const microBudgetConfig: ResolvedConfig = { ...config, retrievalTokenBudget: 1 }
    const llm = makeMockLLM([routerResponse])

    // Must not throw.
    const results = await retrieve('large topic', llm, store, microBudgetConfig, logger)

    // The topic was found — it is always in results once the router selects it.
    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe(topicId)

    // Topic-level summary is the guaranteed floor — always present.
    expect(results[0]?.summary).toBe('A topic with lots of content that cannot fit in a tiny budget.')

    // No chunks fit: budget exhausted before any chunk could be added.
    expect(results[0]?.chunks).toHaveLength(0)
  })

  it('returns topic summary floor and raw=false chunks when only summaries fit', async () => {
    const topicId = 'medium-topic'
    await store.upsertTopic(makeTopic({
      topicId,
      label: 'Medium Topic',
      summary: 'Topic with moderate content.',
    }))

    // Two chunks: messages are large, summaries are small.
    await store.appendChunk(topicId, {
      chunkId: 'big-msg-1',
      messages: [{ role: 'user', content: 'A'.repeat(200) }],  // 200 chars = 50 tokens
      summary: 'Old.',                                            // 4 chars = 1 token
      entities: [],
      tags: [],
      timeRange: null,
      appendedAt: new Date(Date.now() - 10_000).toISOString(),
    })
    await store.appendChunk(topicId, {
      chunkId: 'big-msg-2',
      messages: [{ role: 'user', content: 'B'.repeat(200) }],  // 200 chars = 50 tokens
      summary: 'New.',                                            // 4 chars = 1 token
      entities: [],
      tags: [],
      timeRange: null,
      appendedAt: new Date().toISOString(),
    })

    const routerResponse = JSON.stringify([topicId])
    // Budget allows summaries (1 token each) but not raw messages (50 tokens each).
    const summaryOnlyBudget: ResolvedConfig = { ...config, retrievalTokenBudget: 3 }
    const llm = makeMockLLM([routerResponse])

    const results = await retrieve('medium topic', llm, store, summaryOnlyBudget, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe(topicId)

    // Topic summary always present.
    expect(results[0]?.summary).toBe('Topic with moderate content.')

    const chunks = results[0]?.chunks ?? []
    // At least one chunk was included as summary-only.
    expect(chunks.length).toBeGreaterThan(0)
    // All returned chunks must be summary-only (raw = false), not raw.
    const rawChunks = chunks.filter(c => c.raw)
    expect(rawChunks).toHaveLength(0)
    // Summary-only chunks have empty messages arrays.
    for (const c of chunks) {
      expect(c.messages).toHaveLength(0)
      expect(c.summary).toBeTruthy()
    }
  })
})
