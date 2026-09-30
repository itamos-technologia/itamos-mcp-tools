# Bug Recorder — SPEC, NOT YET IMPLEMENTED

Created late-night 2026-05-07 as a placeholder so this doesn't get forgotten before launch. Build first thing the morning of 2026-05-08, before the audit run.

## Why this exists

Once customers start using the system there's no way to retroactively learn what's failing for them. The bug recorder needs to be in place BEFORE first customer use, not after.

## The big design insight (added 2026-05-07 ~midnight)

**Don't build a custom bug-recording protocol. Use the segment editor we already have.** Bugs are recorded to markdown files where each bug is one segment. The LLM reviews/triages bugs by opening the file with `read_file` and using the standard verify+commit lifecycle.

Zero new MCP actions to design or learn. Zero new storage infrastructure. Triage workflow IS the existing read_file workflow.

## The two-file separation (added later 2026-05-07)

System writes and LLM edits MUST go to different files to avoid concurrent-write conflicts. If the system appended to the same file the LLM was triaging, either the LLM's commit would clobber new entries or fail on hash mismatch. Two files with distinct roles:

### `bugs/incoming.md` — system-owned, append-only

The bug recorder appends new entries here directly via filesystem write. Fire-and-forget, never throws, never blocks the user-facing call. The LLM **never edits** this file in normal triage flow — it only reads it to see what's pending. The system can append to it freely at any moment without conflicting with anything the LLM is doing.

### `bugs/triaged.md` — LLM-owned, edited via read_file

The LLM's working file. The LLM moves segments from incoming → triaged when triaging, optionally adding narrative/classification fields along the way. Standard segment editor: delete from incoming, insert into triaged (or use a single move-across-files op if we add one).

### Why this works

- System writes never conflict with LLM edits — separate files, separate buffer namespaces.
- `incoming.md` size = pending triage queue. Empty = caught up. Visual signal for free.
- The system never needs to coordinate with the LLM's buffer state.
- The LLM's verify+commit lifecycle on triaged.md is normal — no special handling needed.

### Triage workflow

1. LLM opens `incoming.md` → sees skeleton with one segment per pending bug
2. LLM reads each segment, decides classification (real bug / known limitation / not a bug)
3. For each: LLM uses `read_file` to delete the segment from `incoming.md` AND insert it (with annotations) into `triaged.md`. Two read_file calls, both verified+committed normally.
4. After triage, `incoming.md` is empty (or contains only un-reviewed entries). `triaged.md` accumulates the historical record.

## Bug segment format (markdown)

Same in both files. Each bug = one top-level `##` heading + metadata fields:

```markdown
## bug_<date>_<short_hash> — <category> — <one_line_summary>

- **ts:** 2026-05-08T09:14:33Z
- **category:** hard_error | soft_failure | perf_anomaly | llm_flagged
- **tool:** read_file | master_architect | adapter:<type> | parser:<lang>
- **action:** <tool action>
- **file_hash:** sha256:abc123... (path stays out for privacy)
- **project_id:** 4
- **error_message:** no such column: username
- **error_type:** SqliteError
- **error_stack:** |
    truncated to ~10 lines
- **context:** |
    category-specific extras
- **instance_id:** user_12
- **narrative:** [LLM fills in when triaging]
- **classification:** [tool_bug | code_bug | expected_limitation | unsure]
- **status:** new | triaged | fixed | wont_fix
```

Mechanical capture sets ts/category/tool/action/file_hash/project_id/error_*/context/instance_id and leaves narrative/classification/status empty. LLM fills the empty fields when moving from incoming to triaged.

## Categories that trigger automatic recording

1. **Hard errors** — adapters/parsers throw, dispatcher fails, tool entry points crash. Trigger: try/catch wrappers around tool entry points and adapter `check()` calls.
2. **Soft failures** — "no DB inferred", "connection refused", "parser miss". Trigger: explicit `recordSoftFailure()` calls. Dedup: only first occurrence per (file_hash, failure_type) per day to avoid spam.
3. **Performance anomalies** — verify took N× longer than rolling baseline. Probe timed out. Trigger: timing wrapper.
4. **LLM-flagged "result looks wrong"** — LLM noticed a tool returned plausibly-formed but actually-wrong output. Trigger: LLM appends a new segment to `incoming.md` manually using read_file (no special action needed — just an edit).

## Privacy and sanitization

File paths get hashed (sha256). Connection passwords scrubbed via regex (`password:` patterns → `[REDACTED]`). SQL string literals kept (useful for diagnosis), connection strings scrubbed. Multi-tenant: each instance's `bugs/` dir lives in its own per-user directory.

## Implementation order

1. Create `lib/bug_recorder/append.js` — exports `recordBug({...})` (fire-and-forget async, never throws). Generates context_id, sanitizes, formats as markdown segment, appends to `bugs/incoming.md`. Creates the file if missing with a header explaining the convention.
2. Create `lib/bug_recorder/sanitize.js` — strips creds, hashes paths, truncates large fields.
3. Wrap adapter `check()` calls in dispatcher with try/catch → `recordBug` on hard error.
4. Add `recordSoftFailure()` calls at known fall-through points. Dedup via in-memory Set keyed on (file_hash, failure_type, date).
5. Initialize `bugs/triaged.md` with a header documenting the triage workflow (so any LLM opening it knows the convention).
6. Add a README in `bugs/` explaining the two-file model and triage workflow for future-LLM and future-human.
7. (v2, additive) timing wrapper with rolling-baseline outlier detection.

## What we DON'T need to build

- ❌ Custom MCP action `read_file action=report_bug` — replaced by "edit triaged.md"
- ❌ Custom MCP action `read_file action=flag_result` — replaced by "append to incoming.md"
- ❌ Custom JSONL → SQLite importer — markdown files ARE the storage
- ❌ Custom rotation logic — eventually split bugs/triaged.md by month if too big, normal file ops
- ❌ Custom narrative attachment via context_id — narrative is just a field in the segment, joined by living in the same segment
- ❌ Concurrent-write coordination between system and LLM — separate files, no conflict possible

Saves ~2-3 hours of build work + ongoing maintenance.

## Effort estimate

~1-1.5 hours for steps 1-6. Step 7 is additive.

## When to build

First thing morning of 2026-05-08, BEFORE the audit run. The audit then becomes the first real test of the recorder.


## Constraints discovered late (2026-05-07 ~midnight)

### The segment editor doesn't support markdown yet

Verified by attempting to open this very spec file via the live segment editor — got "Unsupported file type: .md. Supported: .py, .js, .mjs, .cjs, .jsx".

This breaks the design above as written: `incoming.md` and `triaged.md` cannot be edited via the segment editor. Two options to resolve before implementing:

**Option A: Bug files as .js modules** — each bug is an exported object in a JS file. Less human-readable but works with the existing tool.

**Option B: Extend the segment editor to handle markdown** — add a markdown parser (tree-sitter-markdown exists). Sections become segments naturally. Larger scope but unlocks markdown editing for all kinds of doc work, not just bugs.

**Option C: Use a hybrid** — the system writes bugs as JSON-Lines (one bug per line, machine-readable, no parser needed), and the LLM reads/triages via run_cmd or a small custom action. Loses the segment-editor-uniformity benefit.

Recommendation: **Option B is the right long-term answer** but is a separate piece of work. For initial bug recorder implementation, use Option A (bug files as .js) so the segment editor works. When markdown support lands, migrate the format.

### Multi-buffer support is load-bearing for the triage workflow

The two-file separation (incoming + triaged) was designed assuming the LLM can have both files open simultaneously and move segments between them. This depends on the segment editor supporting multiple open buffers per session.

Per user observation 2026-05-07: sonnet was using multi-buffer cross-referencing successfully in earlier sessions. Whether this is intentional behavior or emergent from buffer-keyed-on-path is unclear, but it WORKS and the triage workflow assumes it. Spec needs to:

1. Document multi-buffer use as a supported, intended capability of read_file
2. Verify the buffer cache doesn't evict opened buffers prematurely
3. Consider buffer-aging policy (drop buffers untouched for N turns) as a future improvement to avoid context bloat in long sessions

Add a stub for "buffer-aging policy" in the planned-improvements list elsewhere in the architect.
