import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Memory } from '../src/index.js'
import type { Message } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-integration-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeMockLLM(responses: string[]) {
  const queue = [...responses]
  return async (_sys: string, _user: string): Promise<string> => queue.shift() ?? '[]'
}

const conversation: Message[] = [
  { role: 'user', content: 'I want to plan a trip to Lisbon, Portugal.', timestamp: '2024-03-01T10:00:00Z' },
  { role: 'assistant', content: 'Lisbon is wonderful! Spring is ideal.', timestamp: '2024-03-01T10:00:10Z' },
  { role: 'user', content: 'What neighborhoods should I stay in?', timestamp: '2024-03-01T10:01:00Z' },
  { role: 'assistant', content: 'Alfama and Bairro Alto are popular choices.', timestamp: '2024-03-01T10:01:10Z' },
]

describe('Scenario 1: full round-trip', () => {
  it('chunks a conversation, retrieves it, then deletes it', async () => {
    const topicId = 'portugal-trip'

    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Portugal Trip',
      summary: 'User planning a Lisbon trip, asking about neighborhoods.',
      entities: [{ name: 'Lisbon', type: 'place' }, { name: 'Portugal', type: 'place' }],
      tags: ['travel', 'event'],
      timeRange: { start: '2024-03-01T10:00:00Z', end: '2024-03-01T10:01:10Z' },
      messageIndices: [0, 1, 2, 3],
    }])
    const summaryResponse = 'User is planning a trip to Lisbon, Portugal, asking about neighborhoods like Alfama and Bairro Alto.'
    const routerResponse = JSON.stringify([topicId])

    const memory = new Memory({
      llm: makeMockLLM([chunkResponse, summaryResponse, routerResponse]),
      storagePath: tmpDir,
    })

    // 1. Chunk
    await memory.chunk(conversation)

    // 2. Verify topics
    const topics = await memory.getTopics()
    expect(topics).toHaveLength(1)
    expect(topics[0]?.label).toBe('Portugal Trip')
    expect(topics[0]?.summary).toBe(summaryResponse)

    // 3. Retrieve — chunk summary and topic summary both present
    const results = await memory.retrieve('Lisbon restaurants')
    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe(topics[0]?.topicId)
    expect(results[0]?.summary).toBe(summaryResponse)
    expect(results[0]?.chunks).toHaveLength(1)
    expect(results[0]?.chunks[0]?.raw).toBe(true)
    expect(results[0]?.chunks[0]?.messages).toHaveLength(4)
    expect(results[0]?.chunks[0]?.summary).toBe('User planning a Lisbon trip, asking about neighborhoods.')

    // 4. Delete
    await memory.deleteTopic(topics[0]!.topicId)
    const topicsAfter = await memory.getTopics()
    expect(topicsAfter).toHaveLength(0)
  })
})

describe('Scenario 2: continuation across two chunk() calls', () => {
  it('appends new chunks to an existing topic', async () => {
    const firstResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Portugal Trip',
      summary: 'Initial trip planning for Lisbon.',
      entities: [],
      tags: ['travel'],
      timeRange: null,
      messageIndices: [0, 1],
    }])
    const summary1 = 'Initial trip planning.'

    const memory = new Memory({
      llm: makeMockLLM([firstResponse, summary1]),
      storagePath: tmpDir,
    })

    await memory.chunk(conversation.slice(0, 2))
    const topics = await memory.getTopics()
    const topicId = topics[0]!.topicId

    // Second chunk call continues the topic
    const continuationResponse = JSON.stringify([{
      matchedTopicId: topicId,
      suggestedLabel: 'Portugal Trip',
      summary: 'Neighborhood recommendations for Lisbon.',
      entities: [],
      tags: ['travel'],
      timeRange: null,
      messageIndices: [0, 1],
    }])
    const summary2 = 'Planning Lisbon trip with neighborhood recommendations.'

    const memory2 = new Memory({
      llm: makeMockLLM([continuationResponse, summary2]),
      storagePath: tmpDir,
    })

    await memory2.chunk(conversation.slice(2))

    const allTopics = await memory2.getTopics()
    expect(allTopics).toHaveLength(1)

    const { FileStore } = await import('../src/store.js')
    const rawStore = new FileStore(tmpDir)
    await rawStore.initialize()
    const chunks = await rawStore.readChunks(topicId)
    expect(chunks).toHaveLength(2)
    // Both chunks have summaries
    expect(chunks[0]?.summary).toBeTruthy()
    expect(chunks[1]?.summary).toBeTruthy()
  })
})

describe('Scenario 3: non-destructive archival', () => {
  it('appends group summary and preserves all raw chunks', async () => {
    const { FileStore } = await import('../src/store.js')
    const store = new FileStore(tmpDir)
    await store.initialize()

    const now = new Date()
    const oldDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const newDate = now.toISOString()

    await store.upsertTopic({
      topicId: 'old-topic',
      label: 'Old Topic',
      summary: 'An old topic.',
      entities: [],
      tags: [],
      firstSeenAt: oldDate,
      lastUpdatedAt: newDate,
      estimatedTokens: 60_000,
      chunkCount: 4,
    })

    const oldChunkIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const chunkId = `old-${i}`
      oldChunkIds.push(chunkId)
      await store.appendChunk('old-topic', {
        chunkId,
        messages: [{ role: 'user', content: `Old message ${i} with some content here.` }],
        summary: `Summary of old message ${i}.`,
        entities: [],
        tags: [],
        timeRange: null,
        appendedAt: oldDate,
      })
    }
    await store.appendChunk('old-topic', {
      chunkId: 'recent-1',
      messages: [{ role: 'user', content: 'Recent message.' }],
      summary: 'Recent message summary.',
      entities: [],
      tags: [],
      timeRange: null,
      appendedAt: newDate,
    })

    const memory = new Memory({
      llm: makeMockLLM(['Compacted summary of old content.']),
      storagePath: tmpDir,
      config: { archivalThreshold: 50_000 },
    })

    await memory.compact('old-topic')

    const chunksAfter = await store.readChunks('old-topic')

    // All original raw chunks still present
    for (const id of oldChunkIds) {
      expect(chunksAfter.some(c => c.chunkId === id)).toBe(true)
    }
    expect(chunksAfter.some(c => c.chunkId === 'recent-1')).toBe(true)

    // Group summary appended
    const groupSummary = chunksAfter.find(c => c.coversChunkIds != null)
    expect(groupSummary).toBeDefined()
    expect(groupSummary?.archived).toBe(true)
    expect(groupSummary?.messages[0]?.content).toBe('Compacted summary of old content.')
    expect(groupSummary?.summary).toBe('Compacted summary of old content.')
    expect(groupSummary?.coversChunkIds).toEqual(expect.arrayContaining(oldChunkIds))

    // Total = 3 old raw + 1 recent + 1 group summary
    expect(chunksAfter.length).toBe(5)
  })
})
