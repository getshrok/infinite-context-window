import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Memory } from '../src/index.js'
import { FileGraphStore } from '../src/graph-store.js'
import type { Message } from '../src/types.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-integration-graph-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeMockLLM(responses: string[]) {
  const queue = [...responses]
  return async (_sys: string, _user: string): Promise<string> => queue.shift() ?? ''
}

const conversation: Message[] = [
  { role: 'user', content: 'Alice leads the Project Atlas team at Acme Corp.' },
  { role: 'assistant', content: 'That sounds like a great team structure!' },
]

describe('full graph round-trip', () => {
  it('chunks with relations, retrieves by entity, and cleans up on delete', async () => {
    // ── Step 1: Chunk with graph enabled ────────────────────────────────────
    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Team Structure',
      summary: 'Alice leads Project Atlas at Acme.',
      entities: [
        { name: 'Alice', type: 'person' },
        { name: 'Project Atlas', type: 'project' },
        { name: 'Acme Corp', type: 'organization' },
      ],
      tags: ['project', 'person'],
      timeRange: null,
      messageIndices: [0, 1],
      relations: [
        { source: 'Alice', relation: 'leads', target: 'Project Atlas' },
        { source: 'Project Atlas', relation: 'at', target: 'Acme Corp' },
      ],
    }])
    const summaryResponse = 'Alice leads Project Atlas at Acme Corp.'
    const routerResponse = JSON.stringify(['team-structure'])

    const memory = new Memory({
      llm: makeMockLLM([chunkResponse, summaryResponse, routerResponse]),
      storagePath: tmpDir,
      graph: true,
    })

    await memory.chunk(conversation)

    // Verify topics were created
    const topics = await memory.getTopics()
    expect(topics).toHaveLength(1)
    expect(topics[0]?.label).toBe('Team Structure')

    // ── Step 2: Verify graph was populated ──────────────────────────────────
    // Read the graph store directly to verify
    const graphStore = new FileGraphStore(tmpDir)
    await graphStore.initialize()

    const aliceRels = await graphStore.getRelationsForEntity('Alice')
    expect(aliceRels.length).toBeGreaterThanOrEqual(1)
    expect(aliceRels.some(r => r.relation === 'leads')).toBe(true)

    const entities = await graphStore.getAllEntities()
    expect(entities).toContain('alice')
    expect(entities).toContain('project atlas')
    expect(entities).toContain('acme corp')

    // ── Step 3: Retrieve by entity ──────────────────────────────────────────
    const results = await memory.retrieveByEntity('Alice')
    expect(results).toHaveLength(1)
    expect(results[0]?.label).toBe('Team Structure')
    expect(results[0]?.chunks[0]?.raw).toBe(true)

    // ── Step 4: Delete topic and verify graph cleanup ────────────────────────
    const topicId = topics[0]!.topicId
    await memory.deleteTopic(topicId)

    // Refresh graph store from disk
    const graphStore2 = new FileGraphStore(tmpDir)
    await graphStore2.initialize()

    // Topic references should be removed
    const aliceTopics = await graphStore2.getTopicsForEntity('Alice')
    expect(aliceTopics).not.toContain(topicId)
  })
})

describe('Memory with graph: true shorthand', () => {
  it('creates FileGraphStore implicitly', async () => {
    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Test',
      summary: 'A test.',
      entities: [],
      tags: [],
      timeRange: null,
      messageIndices: [0, 1],
      relations: [{ source: 'Alice', relation: 'knows', target: 'Bob' }],
    }])
    const summaryResponse = 'A test.'

    const memory = new Memory({
      llm: makeMockLLM([chunkResponse, summaryResponse]),
      storagePath: tmpDir,
      graph: true,
    })

    await memory.chunk(conversation)

    // graph.json should exist
    const graphExists = await fs.stat(path.join(tmpDir, 'graph.json')).catch(() => null)
    expect(graphExists).not.toBeNull()
  })

  it('throws if graph: true without storagePath', () => {
    expect(() => new Memory({
      llm: async () => '',
      graph: true,
    })).toThrow('storagePath')
  })
})

describe('Memory without graph', () => {
  it('works identically to before — no graph.json created', async () => {
    const chunkResponse = JSON.stringify([{
      matchedTopicId: null,
      suggestedLabel: 'Test',
      summary: 'A test.',
      entities: [],
      tags: [],
      timeRange: null,
      messageIndices: [0, 1],
    }])
    const summaryResponse = 'A test.'
    const routerResponse = JSON.stringify(['test'])

    const memory = new Memory({
      llm: makeMockLLM([chunkResponse, summaryResponse, routerResponse]),
      storagePath: tmpDir,
    })

    await memory.chunk(conversation)

    const topics = await memory.getTopics()
    expect(topics).toHaveLength(1)

    // No graph.json should exist
    const graphExists = await fs.stat(path.join(tmpDir, 'graph.json')).catch(() => null)
    expect(graphExists).toBeNull()
  })

  it('throws when calling retrieveByEntity without graph', async () => {
    const memory = new Memory({
      llm: async () => '',
      storagePath: tmpDir,
    })

    await expect(memory.retrieveByEntity('Alice')).rejects.toThrow('graph store')
  })
})
