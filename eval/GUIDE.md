# Evaluation Guide

This guide explains how to prepare test data for the memory system evaluation and how to read the results.

---

## What we're testing

The memory system reads conversations and organises them into topics — like a filing system for dialogue. It then retrieves the right topics when asked a question.

We want to know:
- Does it correctly identify and separate different topics within a conversation?
- Does it connect related content across multiple separate sessions?
- Does it retrieve the right information when queried?

Your job is to provide realistic conversation data and a set of queries that should retrieve specific parts of it.

---

## How to write conversation files

Create plain text files. Each file represents one conversation session.

**Format:**

```
User: message from the user goes here
Assistant: response from the assistant goes here
User: follow-up message
Assistant: follow-up response
```

**Rules:**
- Lines must start with `User:` or `Assistant:` (capitalisation doesn't matter)
- One message per line
- Blank lines are fine — they're ignored
- Lines starting with `#` are treated as comments and ignored
- You can add timestamps if you have them: `[2024-03-01T10:00:00Z] User: message`

**File naming:**

Name your files so they sort in the order the sessions happened:

```
session-01.txt   ← first conversation
session-02.txt   ← second conversation, a few days later
session-03.txt   ← third conversation
```

Or use dates:

```
2024-03-01.txt
2024-03-15.txt
2024-04-02.txt
```

The files are processed in alphabetical order, so the naming just needs to sort correctly.

**Multiple topics in one file:**

Real conversations jump between topics — that's fine and actually good test data. No need to separate topics into different files.

**Example file (`session-01.txt`):**

```
User: I've been thinking about the database migration. Should we move to SQLite for local dev?
Assistant: It would simplify setup. The main risk is if you're using Postgres-specific features like jsonb operators.
User: We use jsonb pretty heavily. Would that be a problem?
Assistant: You'd need to audit your queries. SQLite has JSON support but different syntax.

User: Different topic — what's the status of the onboarding redesign?
Assistant: Design review is Thursday. Main open question is whether email verification is optional for SSO users.
User: It should be optional — the identity provider already verified the email.
Assistant: Agreed. Worth documenting the reasoning so it doesn't get re-litigated.
```

---

## How to write queries

Create a file called `queries.txt` in the same folder as your session files.

One query per line. Write them as you would ask them naturally:

```
# Database questions
what did we decide about the database migration?
what are the risks of switching to SQLite?

# Onboarding questions
what is the status of the onboarding redesign?
does SSO bypass email verification?

# This should return nothing
what is the weather like in Paris?
```

Lines starting with `#` and blank lines are ignored.

**Tips for good queries:**
- Include queries that should clearly match specific topics
- Include at least one query that should return nothing — this tests that the system doesn't over-retrieve
- Phrase them naturally, not as keyword searches
- Try paraphrases of things discussed — "database migration" and "switching to SQLite" should both find the same content

---

## What you'll get back

After running, the `output/` folder will contain:

### `summary.md`

An overview of what the system found. Shows a table of all topics it identified, with labels, tags, and rough sizes. This is the first thing to look at — if a topic is missing or mislabelled, note it.

### `topics/<topic-name>.md`

One file per topic. Shows the full conversation history the system stored for that topic, chunk by chunk. This lets you verify:
- Are the right messages grouped together?
- Is anything missing or incorrectly included?
- Does the topic label make sense?

### `retrieval.md`

Results for each query from your `queries.txt`. For each query, shows which topic(s) were returned and the actual conversation chunks retrieved. This lets you verify:
- Did the right topic come back for each query?
- Did irrelevant topics come back when they shouldn't have?
- Did the "should return nothing" query return nothing?

---

## Tips for good test data

**Cover multiple topics in one session.** The most useful test is a realistic conversation that jumps between subjects — that's what the system needs to handle.

**Revisit topics across sessions.** If session-01 introduces a project and session-03 follows up on it, the system should connect them into the same topic. This is one of the key things we're testing.

**Use natural language.** Don't write stilted or simplified dialogue. The more it reflects real conversation — including tangents, follow-ups, and topic switches — the more useful the test.

**Vary the topic types.** Good test data might include: a technical decision, a project status discussion, a personal preference or habit, a factual exchange, and a one-off question. Mixing types stress-tests the topic classifier.

**Don't clean up the data.** Messy conversations with filler, repetition, and casual language are valuable. The archival step is specifically designed to handle that, and testing it requires messy input.

---

## Sending results back

Share the entire `output/` folder. The three files (`summary.md`, `retrieval.md`, and the `topics/` directory) together give a complete picture of what the system did with your data.

If you notice anything unexpected — a topic that should have been created but wasn't, a retrieval result that's wrong, topics that should have been merged but weren't — note it alongside the output files. That feedback directly informs prompt improvements.
