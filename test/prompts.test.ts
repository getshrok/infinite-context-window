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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-prompts-test-'))
  store = new FileStore(tmpDir)
  await store.initialize()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const conversation: Message[] = [
  { role: 'user', content: 'Hello world.' },
  { role: 'assistant', content: 'Hi there!' },
]

describe('prompt overrides', () => {
  it('passes custom chunker prompt as the system prompt to the LLM', async () => {
    const capturedSystems: string[] = []
    const llm = async (sys: string, _user: string): Promise<string> => {
      capturedSystems.push(sys)
      // Return valid chunker response on first call, summary on second
      if (capturedSystems.length === 1) {
        return JSON.stringify([{
          matchedTopicId: null,
          suggestedLabel: 'Greeting',
          summary: 'A greeting.',
          entities: [],
          tags: [],
          timeRange: null,
          messageIndices: [0, 1],
        }])
      }
      return 'A greeting topic.'
    }

    const customChunker = 'You are a custom chunker. Do custom things.'
    await chunk(conversation, llm, store, config, logger, { chunker: customChunker })

    // First LLM call (chunker) should use the custom system prompt
    expect(capturedSystems[0]).toBe(customChunker)
    // Second LLM call (summary update) should use the default (not overridden)
    expect(capturedSystems[1]).not.toBe(customChunker)
  })

  it('passes custom summaryUpdate prompt as the system prompt', async () => {
    const capturedSystems: string[] = []
    const llm = async (sys: string, _user: string): Promise<string> => {
      capturedSystems.push(sys)
      if (capturedSystems.length === 1) {
        return JSON.stringify([{
          matchedTopicId: null,
          suggestedLabel: 'Greeting',
          summary: 'A greeting.',
          entities: [],
          tags: [],
          timeRange: null,
          messageIndices: [0, 1],
        }])
      }
      return 'Custom summary.'
    }

    const customSummary = 'You are a custom summary updater.'
    await chunk(conversation, llm, store, config, logger, { summaryUpdate: customSummary })

    // Second LLM call (summary update) should use the custom prompt
    expect(capturedSystems[1]).toBe(customSummary)
  })

  it('uses default prompts when no overrides are provided', async () => {
    const capturedSystems: string[] = []
    const llm = async (sys: string, _user: string): Promise<string> => {
      capturedSystems.push(sys)
      if (capturedSystems.length === 1) {
        return JSON.stringify([{
          matchedTopicId: null,
          suggestedLabel: 'Greeting',
          summary: 'A greeting.',
          entities: [],
          tags: [],
          timeRange: null,
          messageIndices: [0, 1],
        }])
      }
      return 'Default summary.'
    }

    await chunk(conversation, llm, store, config, logger)

    // Default chunker prompt starts with "You are a conversation memory chunker"
    expect(capturedSystems[0]).toContain('conversation memory chunker')
    // Default summary prompt starts with "You are a memory archivist"
    expect(capturedSystems[1]).toContain('memory archivist')
  })
})
