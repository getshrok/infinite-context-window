import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import { archive } from '../src/archiver.js'
import { retrieve } from '../src/retriever.js'
import { Memory } from '../src/index.js'
import type { Topic, ChunkRecord, ResolvedConfig, Message, Logger } from '../src/types.js'

let tmpDir: string
let store: FileStore

const logger: Logger = { info: () => {}, warn: () => {}, debug: () => {} }

const config: ResolvedConfig = {
  retrievalTokenBudget: 32_000,
  archivalThreshold: 200,
  archivalModerateAfterDays: 14,
  archivalHeavyAfterDays: 60,
  maxChunksPerConversation: 20,
  tokenCounter: (t: string) => Math.ceil(t.length / 4),
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-archival-scenarios-test-'))
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

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function makeChunk(overrides: Partial<ChunkRecord> & { chunkId: string; appendedAt: string }): ChunkRecord {
  return {
    messages: [{ role: 'user', content: 'Some content.' }],
    summary: 'A short summary.',
    entities: [],
    tags: ['test'],
    timeRange: null,
    ...overrides,
  }
}

function makeTopic(topicId: string, label = 'Test Topic', estimatedTokens = 500): Topic {
  return {
    topicId,
    label,
    summary: `Summary for ${label}.`,
    entities: [],
    tags: ['test'],
    firstSeenAt: daysAgo(90),
    lastUpdatedAt: new Date().toISOString(),
    estimatedTokens,
    chunkCount: 3,
  }
}

const KEY_FACT = 'Sarah approved the budget of $50,000 on March 15th'

// ─── Scenario 2 — Multi-Round Archival Fidelity ───────────────────────────────

describe('Scenario 2 — Multi-Round Archival Fidelity', () => {
  it('key fact survives three rounds of archival and is visible on retrieve', async () => {
    const topicId = 'budget-approval'
    await store.upsertTopic(makeTopic(topicId, 'Budget Approval', 500))

    // ── Round 1 ──────────────────────────────────────────────────────────────

    // Use Memory.chunk() to create the initial chunk with the key fact.
    // chunk() makes 2 LLM calls: (1) chunker JSON, (2) summary update plain text.
    const round1ChunkResponse = JSON.stringify([{
      matchedTopicId: topicId,
      suggestedLabel: 'Budget Approval',
      summary: `Key budget decision: ${KEY_FACT}.`,
      entities: [{ name: 'Sarah', type: 'person' }],
      tags: ['budget', 'finance'],
      timeRange: null,
      messageIndices: [0, 1],
    }])
    const round1SummaryResponse = `The team finalized the budget. ${KEY_FACT}. Finance team was notified.`

    const memory1 = new Memory({
      llm: makeMockLLM([round1ChunkResponse, round1SummaryResponse]),
      storagePath: tmpDir,
      config: { archivalThreshold: 200, archivalModerateAfterDays: 14, archivalHeavyAfterDays: 60 },
    })

    const conversation1: Message[] = [
      { role: 'user', content: 'Did Sarah approve the budget?' },
      { role: 'assistant', content: `Yes. ${KEY_FACT}.` },
    ]
    await memory1.chunk(conversation1)

    // Backdate the chunk to 65+ days ago so it's in the heavy tier.
    const chunks1 = await store.readChunks(topicId)
    for (const c of chunks1) {
      await store.appendChunk(topicId, { ...c, appendedAt: daysAgo(65) })
    }

    const round1ArchiveSummary = `Budget summary: ${KEY_FACT}. Approved by Finance.`
    const llm1 = makeMockLLM([round1ArchiveSummary])
    await archive(llm1, store, config, logger, topicId)

    const chunksAfterRound1 = await store.readChunks(topicId)
    const groupSummary1 = chunksAfterRound1.find(c => c.coversChunkIds != null)
    expect(groupSummary1).toBeDefined()
    expect(groupSummary1?.summary).toContain('Sarah')

    // ── Round 2 ──────────────────────────────────────────────────────────────

    await store.appendChunk(topicId, makeChunk({
      chunkId: 'r2-c1',
      appendedAt: daysAgo(65),
      messages: [{ role: 'user', content: 'Budget implementation is underway.' }],
      summary: 'Budget implementation is underway.',
    }))

    const round2ArchiveSummary = `${KEY_FACT}. Implementation is now underway.`
    const llm2 = makeMockLLM([round2ArchiveSummary])
    await archive(llm2, store, config, logger, topicId)

    const chunksAfterRound2 = await store.readChunks(topicId)
    const groupSummaries2 = chunksAfterRound2.filter(c => c.coversChunkIds != null)
    expect(groupSummaries2.length).toBeGreaterThanOrEqual(1)
    const allSummaryText2 = groupSummaries2.map(g => g.summary).join(' ')
    expect(allSummaryText2).toContain('Sarah')

    // ── Round 3 ──────────────────────────────────────────────────────────────

    await store.appendChunk(topicId, makeChunk({
      chunkId: 'r3-c1',
      appendedAt: daysAgo(65),
      messages: [{ role: 'user', content: 'Q2 financials have been reviewed.' }],
      summary: 'Q2 financials reviewed.',
    }))

    const round3ArchiveSummary = `${KEY_FACT}. Q2 financials reviewed post-approval.`
    const llm3 = makeMockLLM([round3ArchiveSummary])
    await archive(llm3, store, config, logger, topicId)

    // Retrieve and assert key fact is visible.
    const routerResponse = JSON.stringify([topicId])
    const llmRetrieve = makeMockLLM([routerResponse])
    const results = await retrieve('budget approval', llmRetrieve, store, config, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe(topicId)

    // Key fact must appear in topic summary or at least one chunk summary.
    const topicSummaryText = results[0]?.summary ?? ''
    const chunkSummaryText = (results[0]?.chunks ?? []).map(c => c.summary).join(' ')
    const allText = topicSummaryText + ' ' + chunkSummaryText
    expect(allText).toMatch(/sarah/i)
  })
})

// ─── Scenario 3 — Backdated Timestamps ───────────────────────────────────────

describe('Scenario 3 — Memory Lib Archival with Backdated Timestamps', () => {
  it('archives heavy/moderate chunks, leaves recent chunks alone, and retrieve returns topic summary', async () => {
    const topicId = 'backdated-topic'
    await store.upsertTopic(makeTopic(topicId, 'Backdated Topic', 500))

    const heavyChunk = makeChunk({
      chunkId: 'heavy-c1',
      appendedAt: daysAgo(70),
      messages: [{ role: 'user', content: 'Heavy tier content from long ago.' }],
      summary: 'Heavy tier summary.',
    })
    const moderateChunk = makeChunk({
      chunkId: 'moderate-c1',
      appendedAt: daysAgo(20),
      messages: [{ role: 'user', content: 'Moderate tier content from a few weeks ago.' }],
      summary: 'Moderate tier summary.',
    })
    const recentChunk = makeChunk({
      chunkId: 'recent-c1',
      appendedAt: daysAgo(2),
      messages: [{ role: 'user', content: 'Recent content, should not be archived.' }],
      summary: 'Recent summary.',
    })

    await store.appendChunk(topicId, heavyChunk)
    await store.appendChunk(topicId, moderateChunk)
    await store.appendChunk(topicId, recentChunk)

    const llm = makeMockLLM(['Group summary covering old and moderate content.'])
    await archive(llm, store, config, logger, topicId)

    const chunks = await store.readChunks(topicId)

    // All original raw chunks are preserved (non-destructive).
    expect(chunks.some(c => c.chunkId === 'heavy-c1')).toBe(true)
    expect(chunks.some(c => c.chunkId === 'moderate-c1')).toBe(true)
    expect(chunks.some(c => c.chunkId === 'recent-c1')).toBe(true)

    // A group summary chunk was created covering the old chunks.
    const groupSummary = chunks.find(c => c.coversChunkIds != null)
    expect(groupSummary).toBeDefined()
    expect(groupSummary?.coversChunkIds).toContain('heavy-c1')

    // Heavy-tier chunks are present, so archivalLevel must be 'heavy'.
    expect(groupSummary?.archivalLevel).toBe('heavy')

    // The recent chunk was NOT included in any group summary.
    expect(groupSummary?.coversChunkIds).not.toContain('recent-c1')

    // Retrieve returns the topic summary (the floor) even when budget is tight.
    const topic = await store.getTopic(topicId)
    expect(topic?.summary).toBeTruthy()

    const routerResponse = JSON.stringify([topicId])
    const llmRetrieve = makeMockLLM([routerResponse])
    const results = await retrieve('backdated content', llmRetrieve, store, config, logger)
    expect(results).toHaveLength(1)
    expect(results[0]?.summary).toBeTruthy()
    expect(results[0]?.topicId).toBe(topicId)
  })
})

// ─── Scenario 15 — Archival Under Pressure ───────────────────────────────────

describe('Scenario 15 — Archival Under Pressure', () => {
  it('preserves key fact through 3 archival rounds and surfaces it on retrieve', async () => {
    const DAVID_FACT = 'David joined the team on June 1st as the lead architect'
    const lowThresholdConfig: ResolvedConfig = {
      ...config,
      archivalThreshold: 50,
    }

    const topicId = 'team-architect'
    await store.upsertTopic(makeTopic(topicId, 'Team Updates', 500))

    // ── Establish initial chunk with key fact ────────────────────────────────
    await store.appendChunk(topicId, makeChunk({
      chunkId: 'initial-fact',
      appendedAt: daysAgo(65),
      messages: [
        { role: 'user', content: 'Who joined the team recently?' },
        { role: 'assistant', content: `${DAVID_FACT}.` },
      ],
      summary: `Key hire: ${DAVID_FACT}.`,
    }))

    // Round 1 archive.
    const summary1 = `Team composition update: ${DAVID_FACT}. Architecture work begins.`
    const llm1 = makeMockLLM([summary1])
    await archive(llm1, store, lowThresholdConfig, logger, topicId)

    const chunksR1 = await store.readChunks(topicId)
    const gs1 = chunksR1.find(c => c.coversChunkIds != null)
    expect(gs1).toBeDefined()
    expect(gs1?.summary).toContain('David')

    // ── Round 2 ─────────────────────────────────────────────────────────────
    await store.appendChunk(topicId, makeChunk({
      chunkId: 'r2-extra',
      appendedAt: daysAgo(65),
      messages: [{ role: 'user', content: 'David completed the first architecture review.' }],
      summary: 'David completed architecture review.',
    }))

    const summary2 = `${DAVID_FACT}. David has now completed the first architecture review.`
    const llm2 = makeMockLLM([summary2])
    await archive(llm2, store, lowThresholdConfig, logger, topicId)

    const chunksR2 = await store.readChunks(topicId)
    const groupSummaries2 = chunksR2.filter(c => c.coversChunkIds != null)
    expect(groupSummaries2.length).toBeGreaterThanOrEqual(1)
    const allText2 = groupSummaries2.map(g => g.summary).join(' ')
    expect(allText2).toContain('David')

    // ── Round 3 ─────────────────────────────────────────────────────────────
    await store.appendChunk(topicId, makeChunk({
      chunkId: 'r3-extra',
      appendedAt: daysAgo(65),
      messages: [{ role: 'user', content: 'Architecture roadmap presented to leadership.' }],
      summary: 'Architecture roadmap presented.',
    }))

    const summary3 = `${DAVID_FACT}. Architecture roadmap has been presented to leadership.`
    const llm3 = makeMockLLM([summary3])
    await archive(llm3, store, lowThresholdConfig, logger, topicId)

    // Retrieve and assert fact is visible.
    const routerResponse = JSON.stringify([topicId])
    const llmRetrieve = makeMockLLM([routerResponse])
    const results = await retrieve('team architect', llmRetrieve, store, lowThresholdConfig, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe(topicId)

    const topicSummaryText = results[0]?.summary ?? ''
    const chunkSummaryText = (results[0]?.chunks ?? []).map(c => c.summary).join(' ')
    const allReturnedText = topicSummaryText + ' ' + chunkSummaryText
    // Key fact components must be findable somewhere in the returned content.
    expect(allReturnedText).toMatch(/david/i)
    expect(allReturnedText).toMatch(/architect/i)
  })
})
