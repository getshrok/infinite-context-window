import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import { FileGraphStore } from '../src/graph-store.js'
import { chunk } from '../src/chunker.js'
import type { Message, ResolvedConfig, Logger } from '../src/types.js'

let tmpDir: string
let store: FileStore
let graphStore: FileGraphStore

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-chunker-graph-test-'))
  store = new FileStore(tmpDir)
  await store.initialize()
  graphStore = new FileGraphStore(tmpDir)
  await graphStore.initialize()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const conversation: Message[] = [
  { role: 'user', content: 'Alice leads the Project Atlas team.' },
  { role: 'assistant', content: 'That sounds like a great project!' },
]

describe('chunk with graph store', () => {
  it('upserts relations to graph store when LLM returns them', async () => {
    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Project Atlas',
      summary: 'Alice leads Project Atlas.',
      entities: [
        { name: 'Alice', type: 'person' },
        { name: 'Project Atlas', type: 'project' },
      ],
      tags: ['project'],
      timeRange: null,
      messageIndices: [0, 1],
      relations: [
        { source: 'Alice', relation: 'leads', target: 'Project Atlas' },
      ],
    }])
    const summaryResponse = 'Alice leads Project Atlas team.'

    const queue = [chunkResponse, summaryResponse]
    const llm = async () => queue.shift() ?? ''

    await chunk(conversation, llm, store, config, logger, undefined, graphStore)

    // Verify relations were persisted
    const rels = await graphStore.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(1)
    expect(rels[0]?.source).toBe('Alice')
    expect(rels[0]?.relation).toBe('leads')
    expect(rels[0]?.target).toBe('Project Atlas')
    expect(rels[0]?.topicIds).toHaveLength(1)
    expect(rels[0]?.chunkIds).toHaveLength(1)
  })

  it('handles LLM returning empty relations array', async () => {
    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Greeting',
      summary: 'A greeting.',
      entities: [],
      tags: [],
      timeRange: null,
      messageIndices: [0, 1],
      relations: [],
    }])
    const summaryResponse = 'A greeting.'

    const queue = [chunkResponse, summaryResponse]
    const llm = async () => queue.shift() ?? ''

    await chunk(conversation, llm, store, config, logger, undefined, graphStore)

    const entities = await graphStore.getAllEntities()
    expect(entities).toHaveLength(0)
  })

  it('handles LLM returning no relations field', async () => {
    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Greeting',
      summary: 'A greeting.',
      entities: [],
      tags: [],
      timeRange: null,
      messageIndices: [0, 1],
      // no relations field
    }])
    const summaryResponse = 'A greeting.'

    const queue = [chunkResponse, summaryResponse]
    const llm = async () => queue.shift() ?? ''

    await chunk(conversation, llm, store, config, logger, undefined, graphStore)

    const entities = await graphStore.getAllEntities()
    expect(entities).toHaveLength(0)
  })

  it('collects relations from multiple chunks in one conversation', async () => {
    const chunkResponse = JSON.stringify([
      {
        matchedTopicId: null,
        suggestedLabel: 'Team Structure',
        summary: 'Alice leads Atlas.',
        entities: [{ name: 'Alice', type: 'person' }],
        tags: [],
        timeRange: null,
        messageIndices: [0],
        relations: [{ source: 'Alice', relation: 'leads', target: 'Project Atlas' }],
      },
      {
        matchedTopicId: null,
        suggestedLabel: 'Bob at Acme',
        summary: 'Bob works at Acme.',
        entities: [{ name: 'Bob', type: 'person' }],
        tags: [],
        timeRange: null,
        messageIndices: [1],
        relations: [{ source: 'Bob', relation: 'works at', target: 'Acme Corp' }],
      },
    ])
    const summaryResponse1 = 'Team structure.'
    const summaryResponse2 = 'Bob at Acme.'

    const queue = [chunkResponse, summaryResponse1, summaryResponse2]
    const llm = async () => queue.shift() ?? ''

    await chunk(conversation, llm, store, config, logger, undefined, graphStore)

    const aliceRels = await graphStore.getRelationsForEntity('Alice')
    const bobRels = await graphStore.getRelationsForEntity('Bob')
    expect(aliceRels).toHaveLength(1)
    expect(bobRels).toHaveLength(1)
  })

  it('behaves identically when graph store is not provided (regression)', async () => {
    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Greeting',
      summary: 'A greeting.',
      entities: [],
      tags: [],
      timeRange: null,
      messageIndices: [0, 1],
    }])
    const summaryResponse = 'A greeting.'

    const queue = [chunkResponse, summaryResponse]
    const llm = async () => queue.shift() ?? ''

    // No graphStore passed — should work fine
    await chunk(conversation, llm, store, config, logger)

    const topics = await store.getAllTopics()
    expect(topics).toHaveLength(1)
  })
})
