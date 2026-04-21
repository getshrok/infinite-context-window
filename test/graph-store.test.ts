import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FileGraphStore, normalizeEntity } from '../src/graph-store.js'
import type { Relation } from '../src/types.js'

let tmpDir: string
let graph: FileGraphStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-graph-test-'))
  graph = new FileGraphStore(tmpDir)
  await graph.initialize()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeRelation(overrides: Partial<Relation> = {}): Relation {
  return {
    source: 'Alice',
    relation: 'leads',
    target: 'Project Atlas',
    topicIds: ['topic-1'],
    chunkIds: ['chunk-1'],
    firstSeen: '2024-01-01T00:00:00.000Z',
    lastSeen: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('normalizeEntity', () => {
  it('lowercases and trims', () => {
    expect(normalizeEntity(' Alice ')).toBe('alice')
    expect(normalizeEntity('PROJECT ATLAS')).toBe('project atlas')
  })
})

describe('upsertRelations', () => {
  it('inserts a new relation', async () => {
    await graph.upsertRelations([makeRelation()])

    const rels = await graph.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(1)
    expect(rels[0]?.source).toBe('Alice')
    expect(rels[0]?.target).toBe('Project Atlas')
    expect(rels[0]?.relation).toBe('leads')
  })

  it('stores bidirectionally — both source and target are queryable', async () => {
    await graph.upsertRelations([makeRelation()])

    const bySource = await graph.getRelationsForEntity('Alice')
    const byTarget = await graph.getRelationsForEntity('Project Atlas')
    expect(bySource).toHaveLength(1)
    expect(byTarget).toHaveLength(1)
    expect(bySource[0]?.source).toBe('Alice')
    expect(byTarget[0]?.source).toBe('Alice')
  })

  it('merges duplicate relations — unions topicIds and chunkIds', async () => {
    await graph.upsertRelations([makeRelation()])
    await graph.upsertRelations([makeRelation({
      topicIds: ['topic-2'],
      chunkIds: ['chunk-2'],
      lastSeen: '2024-06-01T00:00:00.000Z',
    })])

    const rels = await graph.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(1)
    expect(rels[0]?.topicIds).toContain('topic-1')
    expect(rels[0]?.topicIds).toContain('topic-2')
    expect(rels[0]?.chunkIds).toContain('chunk-1')
    expect(rels[0]?.chunkIds).toContain('chunk-2')
    expect(rels[0]?.lastSeen).toBe('2024-06-01T00:00:00.000Z')
  })

  it('does not create duplicates for the same triple', async () => {
    await graph.upsertRelations([makeRelation()])
    await graph.upsertRelations([makeRelation()])

    const rels = await graph.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(1)
  })

  it('treats different relations between same entities as separate', async () => {
    await graph.upsertRelations([
      makeRelation({ relation: 'leads' }),
      makeRelation({ relation: 'founded' }),
    ])

    const rels = await graph.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(2)
    const relations = rels.map(r => r.relation).sort()
    expect(relations).toEqual(['founded', 'leads'])
  })
})

describe('entity normalization in queries', () => {
  it('"Alice" and "alice" resolve to the same entity', async () => {
    await graph.upsertRelations([makeRelation()])

    const lower = await graph.getRelationsForEntity('alice')
    const upper = await graph.getRelationsForEntity('ALICE')
    expect(lower).toHaveLength(1)
    expect(upper).toHaveLength(1)
  })
})

describe('getEntitiesForTopic', () => {
  it('returns entity names associated with a topic', async () => {
    await graph.upsertRelations([
      makeRelation({ topicIds: ['topic-1'] }),
      makeRelation({ source: 'Bob', target: 'Acme', topicIds: ['topic-2'] }),
    ])

    const entities = await graph.getEntitiesForTopic('topic-1')
    expect(entities).toContain('alice')
    expect(entities).toContain('project atlas')
    expect(entities).not.toContain('bob')
  })
})

describe('getTopicsForEntity', () => {
  it('returns topic IDs for an entity', async () => {
    await graph.upsertRelations([
      makeRelation({ topicIds: ['topic-1'] }),
      makeRelation({ source: 'Alice', target: 'Acme', relation: 'works-at', topicIds: ['topic-2'] }),
    ])

    const topics = await graph.getTopicsForEntity('Alice')
    expect(topics).toContain('topic-1')
    expect(topics).toContain('topic-2')
  })

  it('returns empty for unknown entity', async () => {
    const topics = await graph.getTopicsForEntity('Nobody')
    expect(topics).toHaveLength(0)
  })
})

describe('removeTopicReferences', () => {
  it('removes topicId from all relations', async () => {
    await graph.upsertRelations([
      makeRelation({ topicIds: ['topic-1', 'topic-2'] }),
    ])

    await graph.removeTopicReferences('topic-1')

    const rels = await graph.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(1)
    expect(rels[0]?.topicIds).toEqual(['topic-2'])
  })

  it('removes relations with no remaining topicIds', async () => {
    await graph.upsertRelations([
      makeRelation({ topicIds: ['topic-1'] }),
    ])

    await graph.removeTopicReferences('topic-1')

    const rels = await graph.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(0)
  })

  it('removes entity entries with no remaining relations', async () => {
    await graph.upsertRelations([
      makeRelation({ topicIds: ['topic-1'] }),
    ])

    await graph.removeTopicReferences('topic-1')

    const entities = await graph.getAllEntities()
    expect(entities).toHaveLength(0)
  })
})

describe('getAllEntities', () => {
  it('returns all known entity names', async () => {
    await graph.upsertRelations([
      makeRelation(),
      makeRelation({ source: 'Bob', target: 'Acme', relation: 'works-at' }),
    ])

    const entities = await graph.getAllEntities()
    expect(entities).toContain('alice')
    expect(entities).toContain('project atlas')
    expect(entities).toContain('bob')
    expect(entities).toContain('acme')
  })
})

describe('persistence across instances', () => {
  it('writes and reads back graph data', async () => {
    await graph.upsertRelations([makeRelation()])

    // Create a new instance pointing at the same directory
    const graph2 = new FileGraphStore(tmpDir)
    await graph2.initialize()

    const rels = await graph2.getRelationsForEntity('Alice')
    expect(rels).toHaveLength(1)
    expect(rels[0]?.source).toBe('Alice')
    expect(rels[0]?.target).toBe('Project Atlas')
  })

  it('leaves no .tmp file after write', async () => {
    await graph.upsertRelations([makeRelation()])

    const tmpExists = await fs.stat(path.join(tmpDir, 'graph.json.tmp')).catch(() => null)
    expect(tmpExists).toBeNull()
  })
})
