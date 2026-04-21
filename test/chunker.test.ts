import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import { chunk } from '../src/chunker.js'
import type { Message, ResolvedConfig, Logger } from '../src/types.js'

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-chunker-test-'))
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

const conversation: Message[] = [
  { role: 'user', content: 'I want to plan a trip to Lisbon.' },
  { role: 'assistant', content: 'Lisbon is great! When are you thinking?' },
  { role: 'user', content: 'Maybe March. Also, can you help with my React project?' },
  { role: 'assistant', content: 'Sure, what do you need for the React project?' },
]

const newTopicResponse = JSON.stringify([
  {
    matchedTopicId: null,
    suggestedLabel: 'Portugal Trip',
    summary: 'User is planning a trip to Lisbon.',
    entities: [{ name: 'Lisbon', type: 'place' }],
    tags: ['travel', 'event'],
    timeRange: null,
    messageIndices: [0, 1],
  },
])

const summaryResponse = 'User is planning a trip to Lisbon in March.'

describe('chunk — new topic creation', () => {
  it('creates a new topic and appends chunk', async () => {
    const llm = makeMockLLM([newTopicResponse, summaryResponse])
    await chunk(conversation, llm, store, config, logger)

    const topics = await store.getAllTopics()
    expect(topics).toHaveLength(1)
    expect(topics[0]?.label).toBe('Portugal Trip')

    const chunks = await store.readChunks(topics[0]!.topicId)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.messages).toHaveLength(2)
    expect(chunks[0]?.messages[0]?.content).toBe('I want to plan a trip to Lisbon.')
    expect(chunks[0]?.summary).toBe('User is planning a trip to Lisbon.')
  })

  it('updates summary after chunking', async () => {
    const llm = makeMockLLM([newTopicResponse, summaryResponse])
    await chunk(conversation, llm, store, config, logger)

    const topics = await store.getAllTopics()
    expect(topics[0]?.summary).toBe('User is planning a trip to Lisbon in March.')
  })
})

describe('chunk — continuation', () => {
  it('appends to existing topic when matchedTopicId is provided', async () => {
    // First chunk call: create the topic
    const llm1 = makeMockLLM([newTopicResponse, summaryResponse])
    await chunk(conversation.slice(0, 2), llm1, store, config, logger)

    const topics = await store.getAllTopics()
    const topicId = topics[0]!.topicId

    // Second chunk call: continuation
    const continuationResponse = JSON.stringify([
      {
        matchedTopicId: topicId,
        suggestedLabel: 'Portugal Trip',
        summary: 'Continued Lisbon trip planning.',
        entities: [],
        tags: ['travel'],
        timeRange: null,
        messageIndices: [0, 1],
      },
    ])
    const llm2 = makeMockLLM([continuationResponse, summaryResponse])
    await chunk(conversation.slice(0, 2), llm2, store, config, logger)

    const chunks = await store.readChunks(topicId)
    expect(chunks).toHaveLength(2)
  })
})

describe('chunk — graceful degradation', () => {
  it('is a no-op on invalid JSON response', async () => {
    const llm = makeMockLLM(['not valid json at all'])
    await expect(chunk(conversation, llm, store, config, logger)).resolves.not.toThrow()
    const topics = await store.getAllTopics()
    expect(topics).toHaveLength(0)
  })

  it('is a no-op on LLM throwing', async () => {
    const llm = async () => { throw new Error('API error') }
    await expect(chunk(conversation, llm, store, config, logger)).resolves.not.toThrow()
  })

  it('skips chunks with empty messageIndices', async () => {
    const response = JSON.stringify([
      {
        matchedTopicId: null,
        suggestedLabel: 'Empty Chunk',
        summary: 'Empty.',
        entities: [],
        tags: [],
        timeRange: null,
        messageIndices: [],
      },
    ])
    const llm = makeMockLLM([response])
    await chunk(conversation, llm, store, config, logger)
    expect(await store.getAllTopics()).toHaveLength(0)
  })

  it('clamps out-of-range messageIndices', async () => {
    const response = JSON.stringify([
      {
        matchedTopicId: null,
        suggestedLabel: 'Test Topic',
        summary: 'Test chunk.',
        entities: [],
        tags: [],
        timeRange: null,
        messageIndices: [0, 999, -1, 1],  // 999 and -1 are out of range
      },
    ])
    const llm = makeMockLLM([response, summaryResponse])
    await chunk(conversation, llm, store, config, logger)

    const topics = await store.getAllTopics()
    expect(topics).toHaveLength(1)
    const chunks = await store.readChunks(topics[0]!.topicId)
    expect(chunks[0]?.messages).toHaveLength(2)  // only indices 0 and 1
  })
})

describe('chunk — maxChunksPerConversation', () => {
  it('caps output at maxChunksPerConversation', async () => {
    const manyChunks = Array.from({ length: 5 }, (_, i) => ({
      matchedTopicId: null,
      suggestedLabel: `Topic ${i}`,
      summary: `Summary for topic ${i}.`,
      entities: [],
      tags: [],
      timeRange: null,
      messageIndices: [0],
    }))
    const llm = makeMockLLM([
      JSON.stringify(manyChunks),
      ...Array(5).fill(summaryResponse),
    ])
    const smallConfig = { ...config, maxChunksPerConversation: 3 }
    await chunk(conversation, llm, store, smallConfig, logger)

    const topics = await store.getAllTopics()
    expect(topics).toHaveLength(3)
  })
})

describe('chunk — empty conversation', () => {
  it('returns immediately without calling LLM', async () => {
    let called = false
    const llm = async () => { called = true; return '' }
    await chunk([], llm, store, config, logger)
    expect(called).toBe(false)
  })
})
