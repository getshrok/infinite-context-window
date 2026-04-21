import { FileStore } from './store.js'
import { FileGraphStore } from './graph-store.js'
import { chunk as doChunk } from './chunker.js'
import { retrieve as doRetrieve, retrieveByTopicIds as doRetrieveByTopicIds, retrieveByEntity as doRetrieveByEntity } from './retriever.js'
import { archive as doArchive } from './archiver.js'
import type {
  Message,
  Config,
  Logger,
  ResolvedConfig,
  Topic,
  RetrieveResult,
  MemoryOptions,
  LLMFunction,
  Store,
  PromptOverrides,
  GraphStore,
} from './types.js'

export type {
  Message,
  Config,
  Logger,
  Topic,
  RetrieveResult,
  MemoryOptions,
  LLMFunction,
  Store,
  PromptOverrides,
  Relation,
  GraphStore,
} from './types.js'
export type { Entity, ChunkRecord, TieredChunk } from './types.js'
export { FileStore } from './store.js'
export { FileGraphStore } from './graph-store.js'

// ─── Defaults ─────────────────────────────────────────────────────────────────

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
}

// ─── Config resolution ────────────────────────────────────────────────────────

function resolveConfig(config: Config): ResolvedConfig {
  return {
    retrievalTokenBudget: config.retrievalTokenBudget ?? 32_000,
    archivalThreshold: config.archivalThreshold ?? 50_000,
    archivalModerateAfterDays: config.archivalModerateAfterDays ?? 14,
    archivalHeavyAfterDays: config.archivalHeavyAfterDays ?? 60,
    maxChunksPerConversation: config.maxChunksPerConversation ?? 20,
    tokenCounter: config.tokenCounter ?? ((text: string) => Math.ceil(text.length / 4)),
  }
}

// ─── Debug LLM wrapper ────────────────────────────────────────────────────────

let debugCallCount = 0

function wrapDebug(llm: LLMFunction): LLMFunction {
  return async (system: string, user: string): Promise<string> => {
    const n = ++debugCallCount
    const label = system.split('\n')[0] ?? 'llm'
    process.stderr.write(
      `\n[memory debug #${n}] ── ${label}\n` +
      `${'─'.repeat(60)}\n` +
      `SYSTEM:\n${system}\n\n` +
      `USER:\n${user}\n` +
      `${'─'.repeat(60)}\n`,
    )
    const response = await llm(system, user)
    process.stderr.write(
      `[memory debug #${n}] RESPONSE:\n${response}\n` +
      `${'─'.repeat(60)}\n`,
    )
    return response
  }
}

// ─── Memory class ─────────────────────────────────────────────────────────────

export class Memory {
  private store: Store
  private logger: Logger
  private chunkingLlm: LLMFunction
  private archivalLlm: LLMFunction
  private retrievalLlm: LLMFunction
  private config: ResolvedConfig
  private prompts?: PromptOverrides | undefined
  private graphStore?: GraphStore | undefined
  private initialized = false

  constructor(options: MemoryOptions) {
    this.logger = options.logger ?? NOOP_LOGGER
    if (options.store) {
      this.store = options.store
    } else if (options.storagePath) {
      this.store = new FileStore(options.storagePath, this.logger)
    } else {
      throw new Error('Either store or storagePath must be provided')
    }
    const wrap = options.debug ? wrapDebug : (fn: LLMFunction) => fn
    this.archivalLlm = wrap(options.archivalLlm ?? options.llm)
    this.chunkingLlm = wrap(options.chunkingLlm ?? options.archivalLlm ?? options.llm)
    this.retrievalLlm = wrap(options.retrievalLlm ?? options.llm)
    this.config = resolveConfig(options.config ?? {})
    this.prompts = options.prompts

    // Graph store setup
    if (options.graphStore) {
      this.graphStore = options.graphStore
    } else if (options.graph) {
      if (!options.storagePath) {
        throw new Error('graph: true requires storagePath')
      }
      this.graphStore = new FileGraphStore(options.storagePath, this.logger)
    }
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.store.initialize()
      if (this.graphStore) {
        await this.graphStore.initialize()
      }
      this.initialized = true
    }
  }

  async chunk(conversation: Message[]): Promise<void> {
    await this.ensureInit()
    await doChunk(conversation, this.chunkingLlm, this.store, this.config, this.logger, this.prompts, this.graphStore)
  }

  async retrieve(query: string, tokenBudget?: number): Promise<RetrieveResult[]> {
    await this.ensureInit()
    return doRetrieve(query, this.retrievalLlm, this.store, this.config, this.logger, tokenBudget, this.prompts, this.graphStore)
  }

  async retrieveByEntity(entityName: string, tokenBudget?: number): Promise<RetrieveResult[]> {
    await this.ensureInit()
    if (!this.graphStore) {
      throw new Error('retrieveByEntity requires a graph store — pass graphStore or graph: true in MemoryOptions')
    }
    return doRetrieveByEntity(entityName, this.store, this.graphStore, this.config.tokenCounter, tokenBudget ?? this.config.retrievalTokenBudget, this.logger)
  }

  async retrieveByIds(requests: Array<{ topicId: string; budgetTokens: number }>): Promise<RetrieveResult[]> {
    await this.ensureInit()
    return doRetrieveByTopicIds(requests, this.store, this.config.tokenCounter)
  }

  async compact(topicId?: string): Promise<void> {
    await this.ensureInit()
    await doArchive(this.archivalLlm, this.store, this.config, this.logger, topicId, this.prompts)
  }

  async getTopics(): Promise<Topic[]> {
    await this.ensureInit()
    return this.store.getAllTopics()
  }

  async deleteTopic(topicId: string): Promise<void> {
    await this.ensureInit()
    await this.store.deleteTopic(topicId)
    if (this.graphStore) {
      await this.graphStore.removeTopicReferences(topicId)
    }
  }
}
