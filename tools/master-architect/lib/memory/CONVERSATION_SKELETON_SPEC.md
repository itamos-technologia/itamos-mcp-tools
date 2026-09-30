# Conversation Skeleton — Memory System Component (PLANNED)

## The idea (per user 2026-05-08, post-launch-prep session)

Apply the segment-editor's skeleton concept to stored conversations. When a conversation ends (or at quiet points), an LLM-driven curator analyzes the transcript and produces a hierarchical skeleton: titled segments describing what was DONE in each region (decisions made, things built, problems solved), not just topic tags.

Opening an old chat, the user (or another LLM) first sees the skeleton — a navigable outline of the session. Specific regions can be expanded on demand. Same eye-model as code: peripheral skeleton, foveal segment, detail on request.

## Why this is better than current solutions

Current "search past chats" and "recent chats" tools work by full-text or chronological retrieval. Both require loading conversation content to find what you want. For multi-hour sessions producing 100K+ tokens, this is unworkable — you can't grep your way to "what did we decide about X" without reloading the conversation.

Skeleton storage solves this:
- Skeleton itself is tiny (a few KB even for hours-long sessions)
- Loads instantly, gives the structure of what was accomplished
- Specific segments load on demand, only when actually needed
- Scales to arbitrary conversation length without context bloat

## Sharp version (what makes it work)

- **Segments are semantically derived, not message-count derived.** Curator model reads spans of conversation and produces titles describing what happened there.
- **Segments record OUTCOMES** ("decided X", "built Y", "abandoned Z"), not just topics ("discussed X"). Outcomes are what users navigate to.
- **Hierarchical structure** mirrors how code files work — major topics with sub-segments. A 4-hour session might be 10-15 top-level segments, each with 2-5 sub-segments.
- **Generation runs out-of-band** — at conversation end or at quiet points, not in-line during the conversation. Doesn't slow down active dialogue.

## Two-table storage model (added 2026-05-08, per user)

The spec uses TWO complementary tables, both indexed by the same skeleton structure:

### Table 1: Raw chat + titles

Full message-by-message transcript. Each segment has its title attached (one-to-many: one title, many messages within its message_range). Faithful record. Heavy but ground truth.

Use cases:
- Recovering exact wording or code that was discussed inline
- Settling "did we actually decide that or just discuss it"
- Auditing what was actually said when something matters
- The fallback for any case where summary fidelity is insufficient

### Table 2: Summarized chunks + titles

Same skeleton, same titles, but bodies are LLM-summarized rather than raw. Compressed. Captures what was meaningfully accomplished in each segment in fewer tokens.

Use cases:
- Routine retrieval — load this segment's content into context efficiently
- Cross-session search where loading raw bodies would blow the budget
- Quick context refresh at session start
- The default tier for almost all queries

### Three-tier retrieval pattern

The two tables enable three distinct cost/fidelity tradeoffs:

1. **Skeleton only** — titles + outcomes. Tiny. "What did we work on in this session" answered in a few hundred tokens.

2. **Summary chunks** (Table 2) — skeleton + summarized bodies. Medium-detail context. "What did we decide about X and why" answered in 2-3K tokens for a multi-hour session.

3. **Raw chunks** (Table 1) — skeleton + raw bodies. Heavy but ground-truth. "Show me the exact discussion of dispatcher design" answered with actual messages.

Retrieval progresses through tiers based on what the query needs. Most queries terminate at tier 2. Tier 3 only when something specific is being investigated.

### Why this beats one-table-with-summaries-only

Summaries are lossy by design. Sometimes you NEED the raw to recover an exact quote, a code snippet discussed inline, or to verify what was actually said. Storing only summaries means deleting ground truth for the convenience of compression. Two tables keep both, costed appropriately by access frequency.

## Why one-table is also wrong

The naive alternative — one table with raw bodies, summarize on the fly when needed — has its own failure mode. Summarization is non-trivial work; doing it at query time means every retrieval pays the summarization cost, which makes routine retrieval slow. Pre-computed summaries amortize that cost across all future reads.

## Storage shape

```
conversations/
├── <conversation_id>/
│   ├── skeleton.json        (hierarchical segment structure with titles + outcomes + msg_ranges)
│   ├── messages.db          (Table 1: raw messages, indexed by timestamp + segment_id)
│   ├── summaries.db         (Table 2: per-segment summaries, indexed by segment_id)
│   └── embeddings.idx       (per-segment embeddings for semantic search; can index either table)
```

Skeleton points into both DBs by segment_id. Reading at tier 2 = pull summary for segment X from summaries.db. Reading at tier 3 = pull messages in segment X's range from messages.db.

## Skeleton format (sketch)

```json
{
  "conversation_id": "20260507_unification",
  "ts_start": "2026-05-07T13:24:00Z",
  "ts_end": "2026-05-08T07:15:00Z",
  "segments": [
    {
      "id": "seg_001",
      "title": "Postgres adapter: scan + extract + check",
      "outcome": "shipped end-to-end",
      "msg_range": [145, 280],
      "summary_id": "sum_001",
      "children": [
        {
          "id": "seg_001_1",
          "title": "Recognition for new Pool({...})",
          "outcome": "shipped",
          "msg_range": [145, 198],
          "summary_id": "sum_001_1"
        }
      ]
    }
  ]
}
```

## What's hard

The curator must understand conversation flow well enough to know where topic regions begin and end. This is judgment, not heuristic — requires a capable model, not a small one.

Cost considerations:
- **Skeleton generation**: ~1 LLM pass over the whole transcript (or chunked passes). Done once per conversation at ingestion.
- **Summary generation**: 1 LLM call per segment. For a 15-segment conversation, 15 summarization calls. Affordable on a local Haiku-class model; adds up if calling external APIs.

Recommended approach:
- Default: local curator model (Haiku-class running on Monster) handles both skeleton and summaries
- Optional upgrade: external API (Sonnet+) for higher-quality summaries when the conversation is important
- The raw table is always preserved either way, so summary quality is a recoverable concern (regenerate later if needed)

## Connection to broader memory rebuild

The curator model that generates skeletons is the same one that handles memory retrieval relevance judgment. Skeleton generation is one of its standing jobs. Summaries similarly serve dual purpose — they're the searchable/retrievable form of the conversation, indexed alongside other memory entries.

## Extensions that fall out naturally

1. **Cross-session skeleton search** — search across all conversations' skeletons (small, fast, semantic). "Find every session where we discussed adapter architecture" returns segments across many chats.

2. **Segment-level decision extraction** — titles feed into a "decisions log" queryable independently. "What did we decide about X" becomes a real query.

3. **Skeleton diffs over time** — same topic across multiple sessions, skeletons let you see thinking evolve without reading transcripts.

4. **Selective context loading** — at new-session start, load "skeletons of recent chats + summaries of segments tagged relevant to current topic." Same token budget, much higher signal than "last N tokens."

5. **Tier-2 summaries become cross-conversation memory** — summaries from many conversations form the searchable knowledge base. The system "remembers" what was discussed without holding raw transcripts of every session.

## When to build

After the coding suite stabilizes (post-launch). This is part of the memory-system rebuild, which is the next big project after the verifier / read_file / adapters work is solid. Captured here so it doesn't get lost in transcript.

## Effort estimate

Genuine work — probably ~25-50 hours for a real implementation:
- Curator integration (the model that generates skeletons + summaries)
- Two-table storage schema + DBs
- Skeleton + summary generation pipelines (background jobs)
- Three-tier retrieval API
- Cross-session search
- Integration with the memory rebuild (this is a component, not standalone)

Not a weekend project. Worth doing properly when the time comes.
