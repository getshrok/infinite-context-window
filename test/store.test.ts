import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileStore } from '../src/store.js'
import type { Topic, ChunkRecord } from '../src/types.js'

let tmpDir: string
let store: FileStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-store-test-'))
  store = new FileStore(tmpDir)
  await store.initialize()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const sampleTopic: Topic = {
  topicId: 'portugal-trip',
  label: 'Portugal Trip Planning',
  summary: 'Planning a trip to Lisbon and Porto.',
  entities: [{ name: 'Lisbon', type: 'place' }],
  tags: ['travel', 'event'],
  firstSeenAt: '2024-01-01T00:00:00.000Z',
  lastUpdatedAt: '2024-01-02T00:00:00.000Z',
  estimatedTokens: 500,
  chunkCount: 1,
}

const sampleChunk: ChunkRecord = {
  chunkId: 'chunk_portugal-trip_001',
  messages: [
    { role: 'user', content: 'I want to visit Lisbon in March.' },
    { role: 'assistant', content: 'Great choice! Lisbon is lovely in spring.' },
  ],
  summary: 'User wants to visit Lisbon in March.',
  entities: [{ name: 'Lisbon', type: 'place' }],
  tags: ['travel'],
  timeRange: { start: '2024-01-01T10:00:00.000Z', end: '2024-01-01T10:05:00.000Z' },
  appendedAt: '2024-01-01T10:05:00.000Z',
}

describe('initialize', () => {
  it('creates topics directory', async () => {
    const topicsStat = await fs.stat(path.join(tmpDir, 'topics'))
    expect(topicsStat.isDirectory()).toBe(true)
  })

  it('persists and reloads topics across instances', async () => {
    await store.upsertTopic(sampleTopic)
    // Create a fresh store pointing at the same directory
    const store2 = new FileStore(tmpDir)
    await store2.initialize()
    const topic = await store2.getTopic('portugal-trip')
    expect(topic?.label).toBe('Portugal Trip Planning')
    expect(topic?.entities).toEqual([{ name: 'Lisbon', type: 'place' }])
  })
})

describe('getAllTopics', () => {
  it('returns empty array on fresh store', async () => {
    const topics = await store.getAllTopics()
    expect(topics).toEqual([])
  })
})

describe('upsertTopic / getTopic', () => {
  it('round-trips a topic', async () => {
    await store.upsertTopic(sampleTopic)
    const topic = await store.getTopic('portugal-trip')
    expect(topic?.topicId).toBe('portugal-trip')
    expect(topic?.label).toBe('Portugal Trip Planning')
    expect(topic?.entities).toEqual([{ name: 'Lisbon', type: 'place' }])
    expect(topic?.tags).toEqual(['travel', 'event'])
  })

  it('updates existing topic on re-upsert', async () => {
    await store.upsertTopic(sampleTopic)
    await store.upsertTopic({ ...sampleTopic, summary: 'Updated summary.' })
    const all = await store.getAllTopics()
    expect(all).toHaveLength(1)
    expect(all[0]?.summary).toBe('Updated summary.')
  })

  it('returns null for unknown topicId', async () => {
    const topic = await store.getTopic('nonexistent')
    expect(topic).toBeNull()
  })
})

describe('deleteTopic', () => {
  it('removes from index and filesystem', async () => {
    await store.upsertTopic(sampleTopic)
    await store.appendChunk('portugal-trip', sampleChunk)
    await store.deleteTopic('portugal-trip')

    expect(await store.getTopic('portugal-trip')).toBeNull()
    const exists = await fs.stat(path.join(tmpDir, 'topics', 'portugal-trip')).catch(() => null)
    expect(exists).toBeNull()
  })

  it('is a no-op for unknown topicId', async () => {
    await expect(store.deleteTopic('nonexistent')).resolves.not.toThrow()
  })
})

describe('appendChunk / readChunks', () => {
  it('round-trips a chunk through JSONL', async () => {
    await store.appendChunk('portugal-trip', sampleChunk)
    const chunks = await store.readChunks('portugal-trip')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunkId).toBe('chunk_portugal-trip_001')
    expect(chunks[0]?.messages).toHaveLength(2)
  })

  it('appends multiple chunks in order', async () => {
    const chunk2: ChunkRecord = { ...sampleChunk, chunkId: 'chunk_002' }
    await store.appendChunk('portugal-trip', sampleChunk)
    await store.appendChunk('portugal-trip', chunk2)
    const chunks = await store.readChunks('portugal-trip')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.chunkId).toBe('chunk_portugal-trip_001')
    expect(chunks[1]?.chunkId).toBe('chunk_002')
  })

  it('returns empty array for unknown topic', async () => {
    const chunks = await store.readChunks('nonexistent')
    expect(chunks).toEqual([])
  })
})

describe('writeChunks', () => {
  it('atomically replaces history', async () => {
    await store.appendChunk('portugal-trip', sampleChunk)
    const chunk2: ChunkRecord = { ...sampleChunk, chunkId: 'chunk_replaced' }
    await store.writeChunks('portugal-trip', [chunk2])
    const chunks = await store.readChunks('portugal-trip')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.chunkId).toBe('chunk_replaced')
  })

  it('handles empty array', async () => {
    await store.appendChunk('portugal-trip', sampleChunk)
    await store.writeChunks('portugal-trip', [])
    const chunks = await store.readChunks('portugal-trip')
    expect(chunks).toEqual([])
  })

  it('leaves no .tmp file after write', async () => {
    await store.writeChunks('portugal-trip', [sampleChunk])
    const tmpExists = await fs.stat(
      path.join(tmpDir, 'topics', 'portugal-trip', 'history.jsonl.tmp'),
    ).catch(() => null)
    expect(tmpExists).toBeNull()
  })
})

describe('generateTopicId', () => {
  it('slugifies a label', async () => {
    const id = await store.generateTopicId('Portugal Trip Planning')
    expect(id).toBe('portugal-trip-planning')
  })

  it('appends suffix on collision', async () => {
    await store.upsertTopic({ ...sampleTopic, topicId: 'portugal-trip-planning' })
    const id = await store.generateTopicId('Portugal Trip Planning')
    expect(id).toMatch(/^portugal-trip-planning-[a-z0-9]{4}$/)
    expect(id).not.toBe('portugal-trip-planning')
  })

  it('handles labels with special chars', async () => {
    const id = await store.generateTopicId('C++ / Rust Migration!!!')
    expect(id).toMatch(/^[a-z0-9-]+$/)
  })
})
