/**
 * Eval script for @getsaturday/memory
 *
 * Reads conversation files from eval/input/, runs the memory pipeline,
 * and writes human-readable output to eval/output/.
 *
 * Usage:
 *   npm run eval
 *   npm run eval -- --fresh        # wipe storage and output first
 *   npm run eval -- --no-archive   # skip archival
 *
 * API key is loaded from .env automatically.
 */

import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Memory } from '../src/index.js'
import type { Message, RetrieveResult, Topic } from '../src/index.js'

// ─── Config ───────────────────────────────────────────────────────────────────

const apiKey = process.env['ANTHROPIC_API_KEY']
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is not set.')
  process.exit(1)
}

const EVAL_DIR     = path.resolve('eval')
const INPUT_DIR    = path.join(EVAL_DIR, 'input')
const OUTPUT_DIR   = path.join(EVAL_DIR, 'output')
const STORAGE_PATH = path.join(EVAL_DIR, '.memory')
const MODEL        = 'claude-haiku-4-5-20251001'

const fresh      = process.argv.includes('--fresh')
const noArchive  = process.argv.includes('--no-archive')

// ─── LLM function ─────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey })

async function llm(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })
  const block = response.content[0]
  if (!block || block.type !== 'text') throw new Error('Unexpected LLM response format')
  return block.text
}

// ─── Conversation parser ──────────────────────────────────────────────────────

const MESSAGE_RE = /^(?:\[([^\]]+)\]\s+)?(user|assistant):\s*(.+)$/i

function parseConversationFile(content: string): Message[] {
  const messages: Message[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = MESSAGE_RE.exec(line)
    if (!match) continue
    messages.push({
      role: match[2]!.toLowerCase() === 'user' ? 'user' : 'assistant',
      content: match[3]!.trim(),
      ...(match[1] ? { timestamp: match[1] } : {}),
    })
  }
  return messages
}

function parseQueriesFile(content: string): string[] {
  return content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

// ─── Output writers ───────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return iso.slice(0, 10)
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
}

async function writeTopicFile(topic: Topic, chunkRecords: import('../src/types.js').ChunkRecord[]): Promise<void> {
  const lines: string[] = [
    `# ${topic.topicId} — ${topic.label}`,
    '',
    `**Summary:** ${topic.summary}`,
    `**Tags:** ${topic.tags.join(', ') || '(none)'}`,
    ...(topic.entities.length > 0 ? [`**Entities:** ${topic.entities.map(e => e.name).join(', ')}`] : []),
    `**Chunks:** ${topic.chunkCount}  |  ~${topic.estimatedTokens} tokens`,
    `**First seen:** ${formatDate(topic.firstSeenAt)}  |  **Last updated:** ${formatDate(topic.lastUpdatedAt)}`,
  ]

  for (let i = 0; i < chunkRecords.length; i++) {
    const chunk = chunkRecords[i]!
    lines.push('', '---', '')
    const label = chunk.archived
      ? `## Chunk ${i + 1} — [${chunk.archivalLevel} archival]`
      : `## Chunk ${i + 1} — ${formatDate(chunk.appendedAt)}`
    lines.push(label, '')
    if (chunk.summary && chunk.archived) {
      lines.push(`*${chunk.summary}*`, '')
    }
    for (const msg of chunk.messages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant'
      lines.push(`> **${role}:** ${msg.content}`)
    }
  }

  lines.push('')
  await fs.writeFile(path.join(OUTPUT_DIR, 'topics', `${topic.topicId}.md`), lines.join('\n'), 'utf8')
}

async function writeSummaryFile(
  sessionFiles: string[],
  totalMessages: number,
  topics: Topic[],
): Promise<void> {
  const now = new Date().toLocaleString()
  const lines: string[] = [
    `# Memory Eval — ${now}`,
    '',
    '## Run info',
    '',
    `- **Sessions processed:** ${sessionFiles.length} (${sessionFiles.join(', ')})`,
    `- **Total messages:** ${totalMessages}`,
    `- **Model:** ${MODEL}`,
    `- **Storage:** ${STORAGE_PATH}`,
    '',
    `## Topics (${topics.length} found)`,
    '',
  ]

  if (topics.length === 0) {
    lines.push('No topics were created.')
  } else {
    lines.push('| Topic ID | Label | Chunks | ~Tokens | Tags |')
    lines.push('|----------|-------|--------|---------|------|')
    for (const t of topics) {
      lines.push(`| ${t.topicId} | ${t.label} | ${t.chunkCount} | ${t.estimatedTokens} | ${t.tags.join(', ') || '—'} |`)
    }
    lines.push('')
    lines.push('See `topics/<topicId>.md` for full chunk history.')
  }

  lines.push('')
  await fs.writeFile(path.join(OUTPUT_DIR, 'summary.md'), lines.join('\n'), 'utf8')
}

async function writeRetrievalFile(results: { query: string; result: RetrieveResult[] }[]): Promise<void> {
  const lines: string[] = ['# Retrieval Results', '']

  for (const { query, result } of results) {
    lines.push(`## "${query}"`, '')
    if (result.length === 0) {
      lines.push('*No results.*', '')
    } else {
      for (const r of result) {
        const totalMessages = r.chunks.reduce((n, c) => n + c.messages.length, 0)
        lines.push(`**→ ${r.topicId}** — ${r.label}`)
        lines.push(`*(${r.chunks.length} chunk${r.chunks.length !== 1 ? 's' : ''}, ${totalMessages} messages)*`)
        lines.push('')
        // Show first chunk's messages as a preview
        const previewChunk = r.chunks[0]
        if (previewChunk) {
          for (const msg of previewChunk.messages.slice(0, 4)) {
            const role = msg.role === 'user' ? 'User' : 'Assistant'
            lines.push(`> **${role}:** ${msg.content}`)
          }
          if (previewChunk.messages.length > 4) {
            lines.push(`> *(${previewChunk.messages.length - 4} more messages in this chunk)*`)
          }
          if (r.chunks.length > 1) {
            lines.push(`> *(+ ${r.chunks.length - 1} more chunk${r.chunks.length > 2 ? 's' : ''} — see topics/${r.topicId}.md)*`)
          }
        }
        lines.push('')
      }
    }
    lines.push('---', '')
  }

  await fs.writeFile(path.join(OUTPUT_DIR, 'retrieval.md'), lines.join('\n'), 'utf8')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Validate input directory
try {
  await fs.access(INPUT_DIR)
} catch {
  console.error(`Error: eval/input/ directory not found. Expected at: ${INPUT_DIR}`)
  process.exit(1)
}

// --fresh: wipe storage and output
if (fresh) {
  console.log('--fresh: wiping storage and output...')
  await fs.rm(STORAGE_PATH, { recursive: true, force: true })
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true })
}

// Set up output directories
await fs.mkdir(path.join(OUTPUT_DIR, 'topics'), { recursive: true })

// Find session files (all .txt except queries.txt), sorted alphabetically
const allTxt = (await fs.readdir(INPUT_DIR))
  .filter(f => f.endsWith('.txt') && f !== 'queries.txt')
  .sort()

if (allTxt.length === 0) {
  console.warn('Warning: no conversation files found in eval/input/ (looking for *.txt, excluding queries.txt)')
}

// Init memory
const memory = new Memory({
  llm,
  storagePath: STORAGE_PATH,
  logger: console,
})

// Process sessions
let totalMessages = 0
for (const filename of allTxt) {
  const content = await fs.readFile(path.join(INPUT_DIR, filename), 'utf8')
  const messages = parseConversationFile(content)
  if (messages.length === 0) {
    console.warn(`Warning: no messages parsed from ${filename} — check format`)
    continue
  }
  console.log(`\nProcessing ${filename} (${messages.length} messages)...`)
  await memory.chunk(messages)
  totalMessages += messages.length
}

// Archive
if (!noArchive) {
  console.log('\nRunning archival...')
  await memory.compact()
} else {
  console.log('\nSkipping archival (--no-archive)')
}

// Load final topics
const topics = await memory.getTopics()
console.log(`\nTopics: ${topics.length} found`)

// Run queries
const queryResults: { query: string; result: RetrieveResult[] }[] = []
const queriesPath = path.join(INPUT_DIR, 'queries.txt')
let hasQueries = false
try {
  await fs.access(queriesPath)
  hasQueries = true
} catch { /* no queries file */ }

if (hasQueries) {
  const queriesContent = await fs.readFile(queriesPath, 'utf8')
  const queries = parseQueriesFile(queriesContent)
  console.log(`\nRunning ${queries.length} retrieval queries...`)
  for (const query of queries) {
    console.log(`  "${query}"`)
    const result = await memory.retrieve(query)
    queryResults.push({ query, result })
  }
}

// Write output files
console.log('\nWriting output files...')

await writeSummaryFile(allTxt, totalMessages, topics)
console.log('  eval/output/summary.md')

// Write per-topic files
const { TopicStore } = await import('../src/store.js')
const store = new TopicStore(STORAGE_PATH)
await store.initialize()

for (const topic of topics) {
  const chunks = await store.readChunks(topic.topicId)
  await writeTopicFile(topic, chunks)
  console.log(`  eval/output/topics/${topic.topicId}.md`)
}

if (queryResults.length > 0) {
  await writeRetrievalFile(queryResults)
  console.log('  eval/output/retrieval.md')
}

console.log(`\nDone. Output written to: ${OUTPUT_DIR}\n`)
