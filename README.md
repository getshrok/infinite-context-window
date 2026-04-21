# infinite-context-window

Persistent, topic-organized memory for LLMs. Conversations go in, chunked and indexed by topic — then retrieved later by semantic query, entity lookup, or topic ID. An optional knowledge graph tracks entities and their relationships across conversations, enabling relational queries.

## Install

```
npm install infinitecontextwindow
```

## Usage

```ts
import { Memory } from 'infinitecontextwindow'

const memory = new Memory({
  storagePath: './memory-data',
  llm: async (system, user) => callYourLLM(system, user),
  graph: true, // enable entity/relationship tracking
})

// Store a conversation
await memory.chunk([
  { role: 'user', content: 'Tell me about the migration plan' },
  { role: 'assistant', content: 'We are migrating to Postgres next quarter...' },
])

// Retrieve relevant memories
const results = await memory.retrieve('database migration')

// Or look up by entity (requires graph: true)
const entityResults = await memory.retrieveByEntity('Postgres')
```

## API

- **`chunk(conversation)`** — Extract and store topics from a conversation
- **`retrieve(query, tokenBudget?)`** — Semantic search across stored memories
- **`retrieveByEntity(name, tokenBudget?)`** — Look up memories by entity (requires `graph: true`)
- **`retrieveByIds(requests)`** — Fetch specific topics by ID
- **`compact(topicId?)`** — Archive and compress old memories
- **`getTopics()`** — List all stored topics
- **`deleteTopic(topicId)`** — Remove a topic

## Using different models per role

The library makes three kinds of LLM calls, each with different cost and quality characteristics:

- **Chunking** — topic segmentation, labels, entity extraction. Runs on every `chunk()` call and shapes how memory is organized. Errors here degrade retrieval quality long-term.
- **Archival compression** — dense prose summaries of aged chunks. Runs rarely (only when a topic exceeds its threshold) and is more forgiving.
- **Retrieval routing** — topic relevance ranking per query. Runs on every `retrieve()` call.

Each can point at a different model:

```ts
const memory = new Memory({
  storagePath: './memory-data',
  llm: fallbackLlm,              // default for any unspecified role
  chunkingLlm: capableModel,     // shapes memory forever — wants quality
  archivalLlm: cheapModel,       // forgiving
  retrievalLlm: standardModel,   // runs every query
})
```

Fallback chain: `chunkingLlm ?? archivalLlm ?? llm`, `archivalLlm ?? llm`, `retrievalLlm ?? llm`. Pass only `llm` and all three share it.

## How chunking and retrieval work

**Chunking.** On `chunk()`, the chunker LLM receives the raw conversation plus a list of existing topics and emits a JSON array of chunk objects (`matchedTopicId`, `suggestedLabel`, `summary`, `entities`, `tags`, `messageIndices`). A message can appear in multiple chunks when it bridges topics. The chunker also respects continuation hints: if the conversation contains a message matching `[Archival note: the preceding conversation was discussing the following topics: ...]`, the chunker treats those topics as strong priors so continuations get appended to the right existing topic rather than spawning a new one.

**Retrieval.** On `retrieve(query)`, a router LLM picks which stored topics are relevant to the query and returns them ranked. The retriever then fills a token budget (default 32K) starting from the highest-ranked topic — preferring raw chunks, falling back to summary-only form when raw doesn't fit. The router biases toward recently-updated topics on ambiguous deictic queries ("these two", "it", "the other one") so references to topics that rolled out of live conversation history still resolve correctly.

**Archival compression.** When `compact(topicId?)` is called (or implicitly during large `chunk()` runs), chunks older than a threshold get replaced with dense prose summaries. Two tiers: moderate (14+ days by default) and heavy (60+ days). This keeps topic size bounded over long-running use.

**Knowledge graph** (when `graph: true`). The chunker extracts entity mentions and relationships, which get stored separately so `retrieveByEntity()` can find all topics involving a specific person, project, or place — including one-hop relational lookups (topics involving anything connected to the entity).

## Prompt overrides

Every LLM call uses a default prompt shipped with the library. You can override any of them via `MemoryOptions.prompts`:

```ts
const memory = new Memory({
  storagePath: './memory-data',
  llm,
  prompts: {
    chunker: '...your chunker system prompt...',
    router: '...your router system prompt...',
    archiver: '...your archival compression prompt...',
    summaryUpdate: '...your topic summary update prompt...',
  },
})
```

Defaults live in `src/prompts/*.md` in this repo. Start by reading those — they document expected input/output contracts in their own text. Overriding is useful for domain-specific vocabulary, non-English conversations, or customizing what the chunker considers "one topic."

## Configuration

Pass a `config` object to `Memory`:

| Option | Default | Description |
|---|---|---|
| `retrievalTokenBudget` | 32,000 | Max tokens returned per retrieval. Acts as a ceiling — the router pulls only what's relevant, so actual returns are typically well below this. |
| `archivalThreshold` | 50,000 | Topic size in tokens triggering compression during `compact()`. |
| `archivalModerateAfterDays` | 14 | Chunks older than this get moderately compressed. |
| `archivalHeavyAfterDays` | 60 | Chunks older than this get heavily compressed. |
| `maxChunksPerConversation` | 20 | Safety cap on chunks produced from a single `chunk()` call. Protects against an over-segmenting LLM. |
| `tokenCounter` | `chars/4` | Function to estimate tokens. Replace with a proper tokenizer (e.g. tiktoken) for production accuracy. |

## Storage layout

When using `storagePath` with the default file store, data is laid out as:

```
<storagePath>/
├── topics.json                   # topic index: id, label, summary, entities, tags, lastUpdatedAt, estimatedTokens
├── topics/
│   └── <topicId>/
│       └── history.jsonl         # append-only chunk records for this topic
└── graph.json                    # entity-relationship graph (when graph: true)
```

The layout is plain files with no DB dependency. You can inspect, back up, or hand-edit if needed. For custom backends, pass your own `store` and/or `graphStore` implementations instead of `storagePath`.

## License

Apache 2.0
