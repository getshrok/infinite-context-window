// ─── Core message type ────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string  // ISO 8601 — optional
}

// ─── Named entity ─────────────────────────────────────────────────────────────

export interface Entity {
  name: string
  type: 'person' | 'project' | 'place' | 'organization' | 'other'
}

// ─── Storage types ────────────────────────────────────────────────────────────

/** One record in a topic's history.jsonl file. */
export interface ChunkRecord {
  chunkId: string
  messages: Message[]
  summary: string                    // 1-2 sentence description; used as fallback when raw doesn't fit budget
  entities: Entity[]
  tags: string[]
  timeRange: { start: string; end: string } | null
  appendedAt: string
  archived?: boolean
  archivalLevel?: 'moderate' | 'heavy'
  coversChunkIds?: string[]          // present only on group summary records produced by archival
}

/** A topic stored in the in-memory index (topics.json on disk). */
export interface Topic {
  topicId: string
  label: string
  summary: string
  entities: Entity[]
  tags: string[]
  firstSeenAt: string
  lastUpdatedAt: string
  estimatedTokens: number
  chunkCount: number
}

// ─── Config ────────────────────────────────────────────────────────────────────

export type TokenCounter = (text: string) => number

export interface Logger {
  info(message: string): void
  warn(message: string): void
  debug(message: string): void
}

export interface Config {
  retrievalTokenBudget?: number          // default: 32_000
  archivalThreshold?: number             // default: 50_000
  archivalModerateAfterDays?: number     // default: 14
  archivalHeavyAfterDays?: number        // default: 60
  maxChunksPerConversation?: number      // default: 20
  tokenCounter?: TokenCounter            // default: chars/4
}

/** Fully resolved config with defaults applied — internal use only. */
export interface ResolvedConfig {
  retrievalTokenBudget: number
  archivalThreshold: number
  archivalModerateAfterDays: number
  archivalHeavyAfterDays: number
  maxChunksPerConversation: number
  tokenCounter: TokenCounter
}

// ─── LLM function type ────────────────────────────────────────────────────────

export type LLMFunction = (systemPrompt: string, userPrompt: string) => Promise<string>

// ─── Prompt overrides ─────────────────────────────────────────────────────────

export interface PromptOverrides {
  chunker?: string
  router?: string
  archiver?: string
  summaryUpdate?: string
}

// ─── Knowledge graph types ────────────────────────────────────────────────────

/** An entity-to-entity relationship extracted from conversation. */
export interface Relation {
  source: string
  relation: string
  target: string
  topicIds: string[]
  chunkIds: string[]
  firstSeen: string
  lastSeen: string
}

/** Storage backend for the knowledge graph. Opt-in — not required for basic usage. */
export interface GraphStore {
  initialize(): Promise<void>
  upsertRelations(relations: Relation[]): Promise<void>
  getRelationsForEntity(entityName: string): Promise<Relation[]>
  getEntitiesForTopic(topicId: string): Promise<string[]>
  getTopicsForEntity(entityName: string): Promise<string[]>
  removeTopicReferences(topicId: string): Promise<void>
  getAllEntities(): Promise<string[]>
}

// ─── Store interface ──────────────────────────────────────────────────────────

/** Storage backend for topics and chunk records. */
export interface Store {
  initialize(): Promise<void>
  getAllTopics(): Promise<Topic[]>
  getTopic(topicId: string): Promise<Topic | null>
  upsertTopic(topic: Topic): Promise<void>
  deleteTopic(topicId: string): Promise<void>
  appendChunk(topicId: string, chunk: ChunkRecord): Promise<void>
  readChunks(topicId: string): Promise<ChunkRecord[]>
  writeChunks(topicId: string, chunks: ChunkRecord[]): Promise<void>
  generateTopicId(label: string): Promise<string>
  /** Batch upsert multiple topics in a single persistence call. Optional — falls back to individual upsertTopic calls. */
  upsertTopics?(topics: Topic[]): Promise<void>
}

// ─── Init options ─────────────────────────────────────────────────────────────

export interface MemoryOptions {
  llm: LLMFunction
  /** Override for chunking (topic segmentation, labeling, entity extraction). Runs on every `chunk()` call. Falls back to `archivalLlm`, then `llm`. */
  chunkingLlm?: LLMFunction
  /** Override for archival compression — aging chunks into dense summaries via `compact()`. Rarer than chunking. Falls back to `llm`. */
  archivalLlm?: LLMFunction
  /** Override for topic routing during retrieval. Falls back to `llm`. */
  retrievalLlm?: LLMFunction
  /** Custom store implementation. When provided, `storagePath` is not required. */
  store?: Store
  /** Path for the default FileStore. Required when `store` is not provided. */
  storagePath?: string
  /** Custom graph store implementation for knowledge graph features. */
  graphStore?: GraphStore
  /** Shorthand: true = use FileGraphStore at storagePath. Requires storagePath. */
  graph?: boolean
  config?: Config
  prompts?: PromptOverrides
  logger?: Logger
  debug?: boolean
}

// ─── Public API return types ──────────────────────────────────────────────────

/** One chunk's representation in a retrieve result — raw or summary-only. */
export interface TieredChunk {
  chunkId: string
  messages: Message[]   // empty array when raw === false
  summary: string
  tags: string[]
  raw: boolean          // true = full messages returned; false = summary only (budget exhausted)
  timeRange: { start: string; end: string } | null
}

export interface RetrieveResult {
  topicId: string
  label: string
  summary: string       // topic-level summary — always present, the floor
  chunks: TieredChunk[]
}

// ─── Internal LLM response shapes (validated at runtime) ─────────────────────

export interface ChunkerChunkOutput {
  matchedTopicId: string | null
  suggestedLabel: string
  summary: string
  entities: Entity[]
  tags: string[]
  timeRange: { start: string; end: string } | null
  messageIndices: number[]
  /** Entity-to-entity relations extracted when graph is enabled. */
  relations?: Array<{ source: string; relation: string; target: string }>
}

export type ChunkerLLMOutput = ChunkerChunkOutput[]

export type RouterLLMOutput = string[]  // ordered topicIds
