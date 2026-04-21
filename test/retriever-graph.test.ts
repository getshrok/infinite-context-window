import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import { FileGraphStore } from '../src/graph-store.js'
import { retrieve, retrieveByEntity } from '../src/retriever.js'
import type { Topic, ChunkRecord, ResolvedConfig, Logger, Relation } from '../src/types.js'

let tmpDir: string
let store: FileStore
let graphStore: FileGraphStore

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-retriever-graph-test-'))
  store = new FileStore(tmpDir)
  await store.initialize()
  graphStore = new FileGraphStore(tmpDir)
  await graphStore.initialize()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

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

describe('retrieve with graph hints', () => {
  it('includes graph hints in the router prompt when graph store has matching entities', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'team-topic', label: 'Team', summary: 'Team info' }))
    await store.appendChunk('team-topic', makeChunk('team-topic', 'Alice leads the team.'))

    // Add a relation so "Alice" is a known entity linked to "team-topic"
    await graphStore.upsertRelations([{
      source: 'Alice',
      relation: 'leads',
      target: 'Team',
      topicIds: ['team-topic'],
      chunkIds: ['chunk-1'],
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-01T00:00:00.000Z',
    }])

    let capturedUser = ''
    const llm = async (_sys: string, user: string): Promise<string> => {
      capturedUser = user
      return JSON.stringify(['team-topic'])
    }

    await retrieve('Tell me about Alice', llm, store, config, logger, undefined, undefined, graphStore)

    // The user prompt should contain graph hints
    expect(capturedUser).toContain('GRAPH HINTS')
    expect(capturedUser).toContain('team-topic')
  })

  it('works identically when graph store is not provided', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Content'))

    const llm = async () => JSON.stringify(['topic-a'])
    const results = await retrieve('query', llm, store, config, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe('topic-a')
  })

  it('does not include graph hints when no entities match the query', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'Content'))

    await graphStore.upsertRelations([{
      source: 'Bob',
      relation: 'works-at',
      target: 'Acme',
      topicIds: ['topic-a'],
      chunkIds: ['chunk-1'],
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-01T00:00:00.000Z',
    }])

    let capturedUser = ''
    const llm = async (_sys: string, user: string): Promise<string> => {
      capturedUser = user
      return JSON.stringify(['topic-a'])
    }

    // Query doesn't mention Bob or Acme
    await retrieve('Tell me about the weather', llm, store, config, logger, undefined, undefined, graphStore)

    expect(capturedUser).not.toContain('GRAPH HINTS')
  })
})

describe('retrieveByEntity', () => {
  it('returns topics for a directly connected entity', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'project-atlas', label: 'Project Atlas', summary: 'Atlas project details' }))
    await store.appendChunk('project-atlas', makeChunk('project-atlas', 'Alice leads Atlas.'))

    await graphStore.upsertRelations([{
      source: 'Alice',
      relation: 'leads',
      target: 'Project Atlas',
      topicIds: ['project-atlas'],
      chunkIds: ['chunk-1'],
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-01T00:00:00.000Z',
    }])

    const results = await retrieveByEntity('Alice', store, graphStore, config.tokenCounter, 10_000, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.topicId).toBe('project-atlas')
    expect(results[0]?.chunks[0]?.raw).toBe(true)
  })

  it('includes 1-hop related topics', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'alice-topic', label: 'Alice Work', summary: 'Alice projects' }))
    await store.upsertTopic(makeTopic({ topicId: 'atlas-topic', label: 'Atlas Details', summary: 'Atlas info' }))
    await store.appendChunk('alice-topic', makeChunk('alice-topic', 'Alice is the lead.'))
    await store.appendChunk('atlas-topic', makeChunk('atlas-topic', 'Atlas launched in Q1.'))

    // Alice → leads → Project Atlas (in alice-topic)
    // Project Atlas → launched-in → Q1 (in atlas-topic)
    await graphStore.upsertRelations([
      {
        source: 'Alice',
        relation: 'leads',
        target: 'Project Atlas',
        topicIds: ['alice-topic'],
        chunkIds: ['chunk-1'],
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-01T00:00:00.000Z',
      },
      {
        source: 'Project Atlas',
        relation: 'launched in',
        target: 'Q1',
        topicIds: ['atlas-topic'],
        chunkIds: ['chunk-2'],
        firstSeen: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-01T00:00:00.000Z',
      },
    ])

    const results = await retrieveByEntity('Alice', store, graphStore, config.tokenCounter, 10_000, logger)

    // Should get both: alice-topic (direct) and atlas-topic (1-hop via Project Atlas)
    const topicIds = results.map(r => r.topicId)
    expect(topicIds).toContain('alice-topic')
    expect(topicIds).toContain('atlas-topic')
    // Direct should come first
    expect(topicIds[0]).toBe('alice-topic')
  })

  it('respects token budget', async () => {
    await store.upsertTopic(makeTopic({ topicId: 'topic-a', label: 'A' }))
    await store.appendChunk('topic-a', makeChunk('topic-a', 'A'.repeat(200))) // 50 tokens

    await graphStore.upsertRelations([{
      source: 'Alice',
      relation: 'owns',
      target: 'Something',
      topicIds: ['topic-a'],
      chunkIds: ['chunk-1'],
      firstSeen: '2024-01-01T00:00:00.000Z',
      lastSeen: '2024-01-01T00:00:00.000Z',
    }])

    // Budget of 1 — nothing fits as raw
    const results = await retrieveByEntity('Alice', store, graphStore, config.tokenCounter, 1, logger)

    expect(results).toHaveLength(1)
    expect(results[0]?.chunks).toHaveLength(0) // nothing fits
    expect(results[0]?.summary).toBeTruthy()   // topic summary is the floor
  })

  it('returns empty results for unknown entity', async () => {
    const results = await retrieveByEntity('Nobody', store, graphStore, config.tokenCounter, 10_000, logger)
    expect(results).toHaveLength(0)
  })
})
