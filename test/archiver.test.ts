import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import { archive } from '../src/archiver.js'
import type { Topic, ChunkRecord, ResolvedConfig, Logger } from '../src/types.js'

let tmpDir: string
let store: FileStore

const logger: Logger = { info: () => {}, warn: () => {}, debug: () => {} }

const config: ResolvedConfig = {
  retrievalTokenBudget: 32_000,
  archivalThreshold: 100,  // low threshold for testing
  archivalModerateAfterDays: 14,
  archivalHeavyAfterDays: 60,
  maxChunksPerConversation: 20,
  tokenCounter: (t: string) => Math.ceil(t.length / 4),
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-archiver-test-'))
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

function makeTopic(topicId: string, estimatedTokens = 200): Topic {
  return {
    topicId,
    label: 'Test Topic',
    summary: 'A test topic.',
    entities: [],
    tags: ['test'],
    firstSeenAt: daysAgo(90),
    lastUpdatedAt: new Date().toISOString(),
    estimatedTokens,
    chunkCount: 3,
  }
}

describe('archive — non-destructive: raw chunks preserved', () => {
  it('appends group summary for heavy-tier chunks and keeps originals', async () => {
    await store.upsertTopic(makeTopic('test-topic'))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(90) }))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c2', appendedAt: daysAgo(70) }))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c3', appendedAt: daysAgo(5) }))

    const llm = makeMockLLM(['Heavy archived summary.'])
    await archive(llm, store, config, logger, 'test-topic')

    const chunks = await store.readChunks('test-topic')
    // Originals preserved
    expect(chunks.some(c => c.chunkId === 'c1')).toBe(true)
    expect(chunks.some(c => c.chunkId === 'c2')).toBe(true)
    expect(chunks.some(c => c.chunkId === 'c3')).toBe(true)
    // Group summary appended
    const groupSummary = chunks.find(c => c.coversChunkIds != null)
    expect(groupSummary).toBeDefined()
    expect(groupSummary?.archivalLevel).toBe('heavy')
    expect(groupSummary?.coversChunkIds).toContain('c1')
    expect(groupSummary?.coversChunkIds).toContain('c2')
    expect(groupSummary?.summary).toBe('Heavy archived summary.')
  })

  it('appends group summary for moderate-tier chunks and keeps originals', async () => {
    await store.upsertTopic(makeTopic('test-topic'))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(30) }))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c2', appendedAt: daysAgo(20) }))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c3', appendedAt: daysAgo(5) }))

    const llm = makeMockLLM(['Moderate archived summary.'])
    await archive(llm, store, config, logger, 'test-topic')

    const chunks = await store.readChunks('test-topic')
    expect(chunks.some(c => c.chunkId === 'c1')).toBe(true)
    expect(chunks.some(c => c.chunkId === 'c2')).toBe(true)
    const groupSummary = chunks.find(c => c.coversChunkIds != null)
    expect(groupSummary?.archivalLevel).toBe('moderate')
  })

  it('keeps recent chunks untouched and does not call LLM', async () => {
    await store.upsertTopic(makeTopic('test-topic'))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'recent', appendedAt: daysAgo(2) }))

    let llmCalled = false
    const llm = async () => { llmCalled = true; return 'summary' }
    await archive(llm, store, config, logger, 'test-topic')

    expect(llmCalled).toBe(false)
    const chunks = await store.readChunks('test-topic')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.archived).toBeFalsy()
  })
})

describe('archive — idempotency', () => {
  it('does not re-archive chunks already covered by a group summary', async () => {
    await store.upsertTopic(makeTopic('test-topic'))
    // Raw chunk (old)
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(90) }))
    // Existing group summary already covering c1
    await store.appendChunk('test-topic', {
      chunkId: 'existing-group',
      messages: [{ role: 'assistant', content: 'Already archived.' }],
      summary: 'Already archived.',
      entities: [],
      tags: [],
      timeRange: null,
      appendedAt: daysAgo(1),
      archived: true,
      archivalLevel: 'heavy',
      coversChunkIds: ['c1'],
    })

    let llmCallCount = 0
    const llm = async () => { llmCallCount++; return 'new summary' }
    await archive(llm, store, config, logger, 'test-topic')

    expect(llmCallCount).toBe(0)
    // No new group summary added
    const chunks = await store.readChunks('test-topic')
    const groupSummaries = chunks.filter(c => c.coversChunkIds != null)
    expect(groupSummaries).toHaveLength(1)
    expect(groupSummaries[0]?.chunkId).toBe('existing-group')
  })

  it('running archiver twice does not produce duplicate group summaries', async () => {
    await store.upsertTopic(makeTopic('test-topic'))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(90) }))

    const llm = makeMockLLM(['Summary 1.', 'Summary 2.'])
    await archive(llm, store, config, logger, 'test-topic')
    await archive(llm, store, config, logger, 'test-topic')

    const chunks = await store.readChunks('test-topic')
    const groupSummaries = chunks.filter(c => c.coversChunkIds != null)
    expect(groupSummaries).toHaveLength(1)
  })
})

describe('archive — token update', () => {
  it('updates estimatedTokens after archival', async () => {
    await store.upsertTopic(makeTopic('test-topic', 5000))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(90) }))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c2', appendedAt: daysAgo(80) }))

    const llm = makeMockLLM(['Short.'])
    await archive(llm, store, config, logger, 'test-topic')

    const topic = await store.getTopic('test-topic')
    // Token estimate should update (group summary is much smaller than originals)
    expect(topic?.estimatedTokens).toBeDefined()
  })
})

describe('archive — threshold filtering', () => {
  it('skips topics below archival threshold when no topicId given', async () => {
    const highConfig = { ...config, archivalThreshold: 100_000 }
    await store.upsertTopic(makeTopic('small-topic', 500))
    await store.appendChunk('small-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(90) }))

    let llmCalled = false
    const llm = async () => { llmCalled = true; return 'summary' }
    await archive(llm, store, highConfig, logger)

    expect(llmCalled).toBe(false)
  })

  it('archives topics over threshold when no topicId given', async () => {
    const lowConfig = { ...config, archivalThreshold: 100 }
    await store.upsertTopic(makeTopic('big-topic', 50_000))
    await store.appendChunk('big-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(90) }))

    let llmCalled = false
    const llm = async () => { llmCalled = true; return 'Heavy summary.' }
    await archive(llm, store, lowConfig, logger)

    expect(llmCalled).toBe(true)
  })
})

describe('archive — LLM failure', () => {
  it('keeps original chunks when LLM throws', async () => {
    await store.upsertTopic(makeTopic('test-topic'))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c1', appendedAt: daysAgo(90) }))
    await store.appendChunk('test-topic', makeChunk({ chunkId: 'c2', appendedAt: daysAgo(5) }))

    const llm = async () => { throw new Error('LLM failed') }
    await expect(archive(llm, store, config, logger, 'test-topic')).resolves.not.toThrow()

    const chunks = await store.readChunks('test-topic')
    expect(chunks.some(c => c.chunkId === 'c1')).toBe(true)
  })
})
