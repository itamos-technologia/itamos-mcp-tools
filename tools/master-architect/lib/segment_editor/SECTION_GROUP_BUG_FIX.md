# Section-group child-edit silent commit failure — FIXED 2026-05-08

## Status

**FIXED.** This document records what the bug was, why it stayed hidden, and what was changed, so the same class of mistake can be recognised quickly in the future.

## Symptom

When editing a child segment of a `section_group` (or any other parent segment with `children`), the segment editor's commit operation reported success — `committed: true, edits_applied: N, bytes_written: X` — but the disk file content remained unchanged. md5 before commit and md5 after commit were identical.

This affected only files containing banner-style section comments (`// === SECTION ===`) which the segmenter promotes to `section_group` parents. Most files in the project don't have these and so worked fine. `read_file.js` is one of the few that does.

The bug was reported empirically by Sonnet during testing before being root-caused this session.

## Root cause

Three pieces of the buffer machinery had non-recursive (single-level) walks that became inconsistent once `section_group` parents existed:

1. **`Buffer constructor`** stored `segmentText` for each segment from `allSegmentsFlat(segments)` — but `allSegmentsFlat` itself was non-recursive (see #3). For a section_group, the parent's full byte-slice (banner text plus all child code) was stored as one entry. Children's individual text entries existed only one level deep.

2. **`assembleText`** iterated only `this.segments` (top level). For an unedited buffer, this worked because each top-level section_group's segmentText was its full slice — concatenation reproduced the file. **But when a child's segmentText was mutated by `replace`, that mutation never made it into the output**, because assembleText emitted the parent's stale full-slice text instead of recursing into children.

3. **`allSegmentsFlat`** descended exactly one level (`for s of segs: out.push(s); if (s.children) out.push(...s.children)`). For `section_group > class_declaration > method_definition` (three levels), the methods were missing from the flat view. They appeared in the skeleton (which has its own recursive `segmentToSummary`) but were invisible to commit/dirty-check/diff machinery.

### Why the bug was silent

- `dirty` returned `true` correctly because `isDirty` walks `allSegmentsFlat` (one level), which still detected the direct-child mutation.
- Commit proceeded normally and wrote the buffer's `assembleText()` result to a tempfile, then atomic-renamed.
- The write was real (file mtime updated) but the content was the original byte-for-byte (since the parent's stale slice masked the child edit).
- The success reply contained no signal that anything was wrong — `bytes_written` matched the unedited length, which "looked plausible".

The combination is the worst-case shape: dirty-check fires, commit runs, write succeeds, mtime updates, return value reports success, but disk is unchanged. The caller has no reason to disbelieve the success message.

## Fix

Three coordinated changes in `read_file.js`:

1. **Recursive `allSegmentsFlat`** — descends into all children at any depth via internal `recurse(list)` walker, pre-order.

2. **Recursive `Buffer constructor`** — for parents with children, stores only the PREFIX text (segment start to first child start) in `segmentText`/`originalText`, plus a SUFFIX (last child end to segment end) in two new maps `parentSuffix`/`originalParentSuffix`. Then recurses into children to record their text. Leaves are unchanged. Round-trip identity preserved: prefix + child texts (concatenated) + suffix = original parent slice = original full text.

3. **Recursive `assembleText`** — emits parent prefix, recurses into children (each emitting their text or, if also a parent, recursing further), then emits parent suffix.

After the fix:
- `assembleText()` of an unedited buffer still equals `originalFullText` (verified via `diff` op showing "buffer matches disk — clean").
- Editing a child segment of a section_group produces a different `assembleText()` output, which commit writes to disk correctly.
- Files without section_groups behave identically to before (no parents-with-children → no prefix/suffix special case → same code path as before).

## Lessons

- Round-trip identity (`assembleText()` on an unedited buffer must equal the input) is the correctness invariant; any change to the buffer machinery must preserve it. The `diff` op is the unit test: it should report "clean" for any freshly-opened unedited buffer.
- One-level walks in tree-shaped data are a recurring source of bugs once nesting depth grows beyond what was anticipated. `allSegmentsFlat` was originally written when banner promotion was the only nesting case (depth 2). Class-body decomposition added depth 3 silently, exposing the bug.
- Success messages from write-via-tempfile-and-rename pipelines must not be trusted without a roundtrip read-and-compare. mtime updating is not the same as content changing.

## Other one-level walks worth auditing

A grep for `seg.children` and `s.children` flagged one more:

- `opDelete` line ~1185: `if (seg.children) for (const ch of seg.children) prevChildren.set(...)` — captures children one level deep when deleting. Grand-children of a deleted parent aren't preserved in the undo entry. Edge case, low priority, but worth fixing if structural undo across deeply-nested deletions is ever needed.

## Verification

End-to-end test through live MCP after fix landed:

1. Edit `EXT_TO_LANGUAGE` (a child of `CONSTANTS` section_group) via `replace`
2. `verify=1` → OK
3. `commit: true` → `committed: true, bytes_written: 67291`
4. `grep` on disk → canary text present, count=1
5. `md5sum` → changed from before-commit to after-commit
6. Reverse edit + commit → canary removed, file returns to expected state

Both add-content and remove-content paths confirmed working through the live segment editor.
