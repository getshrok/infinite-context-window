/**
 * Smoke test for @getsaturday/memory — uses a real LLM (Anthropic) to verify
 * end-to-end behavior before integrating with Saturday.
 *
 * Usage:
 *   npm run smoke
 *   npm run smoke -- --force-compact
 *
 * API key is loaded from .env automatically.
 */

import Anthropic from '@anthropic-ai/sdk'
import * as os from 'node:os'
import * as path from 'node:path'
import { Memory } from '../src/index.js'
import type { Message } from '../src/index.js'

// ─── Setup ────────────────────────────────────────────────────────────────────

const apiKey = process.env['ANTHROPIC_API_KEY']
if (!apiKey) {
  console.error('Error: ANTHROPIC_API_KEY environment variable is not set.')
  process.exit(1)
}

const forceCompact = process.argv.includes('--force-compact')
const storagePath = path.join(os.tmpdir(), `memory-smoke-${Date.now()}`)

console.log(`\nStorage: ${storagePath}`)
console.log(`Model:   claude-haiku-4-5-20251001`)
if (forceCompact) console.log(`Mode:    --force-compact (archivalThreshold = 0)`)
console.log()

// ─── LLM function ─────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey })

async function llm(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })
  const block = response.content[0]
  if (!block || block.type !== 'text') throw new Error('Unexpected response format')
  return block.text
}

// ─── Conversation fixture ─────────────────────────────────────────────────────
// ~20 messages across 3 distinct topics, interleaved as a real conversation would be.

const T = (offsetMinutes: number) =>
  new Date(new Date('2024-03-01T09:00:00Z').getTime() + offsetMinutes * 60_000).toISOString()

const CONVERSATION: Message[] = [
  // Portugal trip
  { role: 'user',      content: "I'm planning a trip to Portugal in late April. Thinking Lisbon and Porto — maybe 10 days total.", timestamp: T(0) },
  { role: 'assistant', content: "Great timing — late April is ideal before the summer crowds. Typically 4-5 days each works well. Lisbon first since most flights land there, then train to Porto.", timestamp: T(1) },
  { role: 'user',      content: "Which neighborhood should I stay in Lisbon? I want to walk everywhere and not deal with taxis.", timestamp: T(2) },
  { role: 'assistant', content: "Príncipe Real or Chiado are the best walkable bases. Alfama is charming but hilly — tiring if you're out all day. Príncipe Real puts you close to good restaurants without the tourist density of Baixa.", timestamp: T(3) },

  // Switching to TypeScript project
  { role: 'user',      content: "Okay switching gears — I need to refactor the auth middleware in Saturday. Right now it's a giant function in auth.ts, needs to be broken up.", timestamp: T(5) },
  { role: 'assistant', content: "Makes sense to split it into three responsibilities: token validation, session lookup, and permission checking. Each gets its own file under src/auth/. The main middleware becomes a thin orchestrator.", timestamp: T(6) },
  { role: 'user',      content: "Should the session lookup be async or can I keep it sync with the SQLite driver?", timestamp: T(7) },
  { role: 'assistant', content: "Keep it sync — the node:sqlite driver supports synchronous reads and it avoids promise chains in middleware. Just make sure the session table has an index on token or queries will be slow under load.", timestamp: T(8) },
  { role: 'user',      content: "Good call. I'll create token-validator.ts, session-store.ts, and permission-checker.ts. The existing AuthMiddleware class stays as the public interface.", timestamp: T(9) },
  { role: 'assistant', content: "Exactly. Export AuthMiddleware from src/auth/index.ts so callers don't need to change their imports. The internal split is invisible to the rest of the codebase.", timestamp: T(10) },

  // Morning routine
  { role: 'user',      content: "I've been trying to fix my sleep schedule. I want to wake up at 6am consistently but keep hitting snooze until 7:30.", timestamp: T(12) },
  { role: 'assistant', content: "The snooze problem usually means bedtime is too late. What time are you actually falling asleep?", timestamp: T(13) },
  { role: 'user',      content: "Probably 1am most nights. I know that's the issue but the evenings are when I get my best coding done.", timestamp: T(14) },
  { role: 'assistant', content: "You have two real options: shift the target wake time to 8am to match your actual sleep window, or hard-stop coding at 11pm for two weeks and let your schedule adjust. Half-measures don't usually work here.", timestamp: T(15) },
  { role: 'user',      content: "I'll try the 11pm hard stop. Put the laptop in another room. The 6am goal is non-negotiable because of an 8am meeting I have three days a week.", timestamp: T(16) },
  { role: 'assistant', content: "That's the right call. Physical separation from the laptop is more reliable than willpower. Set two alarms — one at 10:45 as a warning, one at 11 as the actual cutoff.", timestamp: T(17) },

  // Back to Portugal briefly
  { role: 'user',      content: "One more Portugal thing — any specific restaurants I should book ahead in Lisbon?", timestamp: T(19) },
  { role: 'assistant', content: "Belcanto if budget isn't a concern — José Avillez's flagship, needs weeks of advance booking. For something more casual, Solar dos Presuntos in Baixa is excellent and easier to get into. Tasca do Chico in Madragoa for fado dinners, book at least a week out.", timestamp: T(20) },
  { role: 'user',      content: "Perfect. Belcanto is too fancy for this trip but the other two I'll look up.", timestamp: T(21) },

  // Auth refactor follow-up
  { role: 'user',      content: "Actually for the auth refactor — should I write tests before or after splitting the files?", timestamp: T(23) },
  { role: 'assistant', content: "After, but only because the current auth.ts probably has poor testability anyway. Split first so each unit is small enough to test, then write tests for the three new files. Don't bother testing the orchestrator middleware directly — integration tests cover that.", timestamp: T(24) },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sep(label: string) {
  const line = `─── ${label} `
  console.log('\n' + line + '─'.repeat(Math.max(0, 60 - line.length)))
}

function printTopics(topics: Awaited<ReturnType<Memory['getTopics']>>) {
  if (topics.length === 0) {
    console.log('  (no topics created)')
    return
  }
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i]!
    console.log(`\n  ${i + 1}. ${t.topicId}`)
    console.log(`     Label:   "${t.label}"`)
    console.log(`     Summary: ${t.summary.slice(0, 120)}${t.summary.length > 120 ? '…' : ''}`)
    console.log(`     Tokens:  ~${t.estimatedTokens}`)
    console.log(`     Tags:    ${t.tags.join(', ') || '(none)'}`)
    if (t.entities.length > 0) {
      console.log(`     Entities: ${t.entities.map(e => e.name).join(', ')}`)
    }
    console.log(`     Chunks:  ${t.chunkCount}`)
  }
}

function printRetrieveResults(query: string, results: Awaited<ReturnType<Memory['retrieve']>>) {
  console.log(`\n  Query: "${query}"`)
  if (results.length === 0) {
    console.log('    → (no results)')
    return
  }
  for (const r of results) {
    const totalMessages = r.chunks.reduce((n, c) => n + c.messages.length, 0)
    console.log(`    → ${r.topicId}  "${r.label}"  (${r.chunks.length} chunk${r.chunks.length !== 1 ? 's' : ''}, ${totalMessages} messages)`)
    const firstMsg = r.chunks[0]?.messages[0]
    if (firstMsg) {
      const preview = firstMsg.content.slice(0, 200)
      console.log(`       "${preview}${firstMsg.content.length > 200 ? '…' : ''}"`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const memory = new Memory({
  llm,
  storagePath,
  config: {
    archivalThreshold: forceCompact ? 0 : 50_000,
    archivalModerateAfterDays: forceCompact ? 0 : 14,
    archivalHeavyAfterDays: forceCompact ? 0 : 60,
  },
})

// Step 1: chunk
sep('STEP 1: chunk()')
console.log(`  Sending ${CONVERSATION.length} messages to chunker…`)
await memory.chunk(CONVERSATION)

const topics = await memory.getTopics()
sep(`Topics created (${topics.length})`)
printTopics(topics)

// Step 2: retrieve
sep('STEP 2: retrieve()')

const queries = [
  'what neighborhoods did we discuss in Lisbon?',
  'what was the decision on the auth middleware?',
  'what time do I wake up?',
  'meditation',
]

for (const query of queries) {
  const results = await memory.retrieve(query)
  printRetrieveResults(query, results)
}

// Step 3: compact
sep('STEP 3: compact()')

if (forceCompact) {
  const beforeChunks: Record<string, number> = {}
  for (const t of topics) beforeChunks[t.topicId] = t.chunkCount

  console.log('  Running compaction on all topics (--force-compact)…')
  await memory.compact()

  const afterTopics = await memory.getTopics()
  for (const t of afterTopics) {
    const before = beforeChunks[t.topicId] ?? '?'
    console.log(`\n  ${t.topicId}  ${before} chunks → ${t.chunkCount} chunks  (~${t.estimatedTokens} tokens)`)
    // Show the compacted summary if present
    const { TopicStore } = await import('../src/store.js')
    const store = new TopicStore(storagePath)
    await store.initialize()
    const chunks = await store.readChunks(t.topicId)
    const archived = chunks.filter(c => c.archived)
    for (const c of archived) {
      console.log(`     [${c.archivalLevel} archival] "${c.messages[0]?.content.slice(0, 300)}…"`)
    }
  }
} else {
  const overThreshold = topics.filter(t => t.estimatedTokens > 50_000)
  if (overThreshold.length === 0) {
    console.log('  All topics under threshold — nothing to compact.')
    console.log('  Re-run with --force-compact to test compaction.')
  } else {
    console.log(`  Compacting ${overThreshold.length} topic(s) over threshold…`)
    await memory.compact()
    console.log('  Done.')
  }
}

sep('Done')
console.log(`\nStorage: ${storagePath}`)
console.log(`Inspect: cat "${storagePath}/topics/"*/history.jsonl\n`)
