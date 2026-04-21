import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Topic, ChunkRecord, Logger, Store } from './types.js'

// ─── FileStore ────────────────────────────────────────────────────────────────

export class FileStore implements Store {
  private topics: Map<string, Topic> = new Map()
  private readonly indexPath: string

  constructor(
    private storagePath: string,
    private logger: Logger = { info: () => {}, warn: () => {}, debug: () => {} },
  ) {
    this.indexPath = path.join(storagePath, 'topics.json')
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.storagePath, 'topics'), { recursive: true })
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8')
      const arr = JSON.parse(raw) as Topic[]
      for (const t of arr) this.topics.set(t.topicId, t)
    } catch {
      // File doesn't exist yet — start empty
    }
  }

  // ─── Persist ────────────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    const arr = Array.from(this.topics.values())
    const tmp = this.indexPath + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(arr, null, 2), 'utf8')
    await fs.rename(tmp, this.indexPath)
  }

  // ─── Metadata CRUD ──────────────────────────────────────────────────────────

  async getAllTopics(): Promise<Topic[]> {
    return Array.from(this.topics.values())
  }

  async getTopic(topicId: string): Promise<Topic | null> {
    return this.topics.get(topicId) ?? null
  }

  async upsertTopic(topic: Topic): Promise<void> {
    this.topics.set(topic.topicId, topic)
    await this.persist()
  }

  async upsertTopics(topics: Topic[]): Promise<void> {
    for (const t of topics) this.topics.set(t.topicId, t)
    await this.persist()
  }

  async deleteTopic(topicId: string): Promise<void> {
    this.topics.delete(topicId)
    await this.persist()
    const dir = path.join(this.storagePath, 'topics', topicId)
    await fs.rm(dir, { recursive: true, force: true })
  }

  // ─── History JSONL ──────────────────────────────────────────────────────────

  private topicDir(topicId: string): string {
    return path.join(this.storagePath, 'topics', topicId)
  }

  private historyPath(topicId: string): string {
    return path.join(this.topicDir(topicId), 'history.jsonl')
  }

  async appendChunk(topicId: string, chunk: ChunkRecord): Promise<void> {
    await fs.mkdir(this.topicDir(topicId), { recursive: true })
    await fs.appendFile(this.historyPath(topicId), JSON.stringify(chunk) + '\n', 'utf8')
  }

  async readChunks(topicId: string): Promise<ChunkRecord[]> {
    const filePath = this.historyPath(topicId)
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch {
      return []
    }
    const chunks: ChunkRecord[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        chunks.push(JSON.parse(trimmed) as ChunkRecord)
      } catch {
        this.logger.warn(`[store] malformed JSONL line in ${topicId}/history.jsonl — skipping`)
      }
    }
    return chunks
  }

  async writeChunks(topicId: string, chunks: ChunkRecord[]): Promise<void> {
    await fs.mkdir(this.topicDir(topicId), { recursive: true })
    const tmpPath = this.historyPath(topicId) + '.tmp'
    const content = chunks.map(c => JSON.stringify(c)).join('\n') + (chunks.length > 0 ? '\n' : '')
    await fs.writeFile(tmpPath, content, 'utf8')
    await fs.rename(tmpPath, this.historyPath(topicId))
  }

  // ─── Slug generation ────────────────────────────────────────────────────────

  async generateTopicId(label: string): Promise<string> {
    const base = toSlug(label) || 'topic'
    if (!this.topics.has(base)) return base
    // Collision: append random suffix
    let candidate = `${base}-${randomSuffix()}`
    while (this.topics.has(candidate)) {
      candidate = `${base}-${randomSuffix()}`
    }
    return candidate
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6)
}
