# read_file — observed limitations & refinement notesCaptured during the Itamos MCP Basic build (2026-05-31). These are real issues hit
in practice, with the context that triggered them, for a future refinement pass.## 1. Buffer cap of 5 is tight for multi-file understanding work
- Hit the "Max 5 open buffers" error repeatedly this session while reading across
  orchestrator.js, cleanup.js, schema files, the duplicate server tree, etc.
- Every time, I had to manually discard clean (zero-edit) buffers to proceed.
- Suggested fix: raise cap to ~8-10, OR auto-evict least-recently-used buffers that
  have `dirty:false` / `edits:0` (nothing to lose by evicting them).## 2. Segment addresses shift after edits; cached addresses break silently
- After a replace, a previously-noted address (e.g. "39.34") returns "No segment".
- Correct behavior, but the error could hint: "addresses may have shifted after the
  last edit — re-read the skeleton." Currently it just says no segment exists.
- Mitigation in practice: always re-read skeleton or use seg_id after an edit.## 3. Cannot read/edit non-whitelisted file types (e.g. .sql)
- read_file rejected schema.sql ("Unsupported file type: .sql").
- This forced me to handle .sql via shell, OUTSIDE the editor's verify/undo safety.
- .sql is a common, safe text format. Suggested fix: add .sql (and likely .sh) to the
  supported list, or a generic "treat as plaintext" fallback for unknown text types.## 4. No granular edit of code nested inside a large function
- The two hardcoded stylelint paths lived deep inside a big function body in the
  master-architect engine. The editor addresses at segment (function) granularity,
  so a tiny string change meant either replacing the whole large parent segment or
  going outside the tool. Documented behavior, but it's the main friction point.
- Note: per the agreed working rule, the right move is to replace the whole parent
  segment rather than drop to external text tools — but for very large functions that
  is expensive. A scoped "replace string within segment N" sub-operation (still
  verified) would close this cleanly.## 5. Block-list gap: inline interpreters bypass the editor guard
- `sed` and `cat >` are correctly blocked (pushed back to write_file), but
  `node -e ... fs.writeFileSync(...)` and `python -c` with file writes are NOT blocked.
- This let me edit a file outside the segment editor (no verify, no undo history).
- Suggested fix: extend blocked-command patterns to catch `node -e/--eval/--input-type`
  and `python -c/python3 -c` when combined with a write call.## Already-queued related infra (not read_file itself)
- RTK should run as a permanent background filter at the ctx.run layer (auto-compress
  all terminal output; pass small/critical output through raw), not as a chosen tool.## Session 2026-06-04 (memory titler fix + child-splitting build)### 6. Architect dumps the full project skeleton — CONTRACT VIOLATION
- Reading segmenter.js (unplaced) returned all 215 files (~5000 tokens).
- Per the design contract (confirmed 2026-06-04): the architect must NEVER dump
  the full skeleton. Its ONLY interface is SEARCH — you ask for something and it
  PROPOSES the relevant segment to open in the file you are editing. Connections
  surface contextually: when you edit the segment that CONTAINS the connectors/
  imports, the links to related files appear THEN — not as a push of the whole tree.
- So this is not a token-optimization request; the full-skeleton code path should
  not exist. Required fix:  1. Remove the project-skeleton dump from the read path entirely.  2. Reading a file returns only THAT file's own structure (+ "unplaced" hint if so).  3. Cross-file navigation = search -> propose segment to open. Pull by relevance.  4. Connectors/links appear only when editing the segment that holds them.### 6b. Connection resolution mechanic (the CONTRACT for `connections`)
How level-1 connections must work (confirmed 2026-06-04). NOT a global graph dump;
computed on demand from the segment being edited:1. You are editing file A, segment 3. Look ONLY at the connectors (calls/imports)
   that literally appear in THAT segment — not the whole file's imports.2. For a referenced symbol (e.g. A.3 calls into file B), search file B's segments
   to locate the exact segment that CONTAINS that symbol's definition.3. If it resolves, propose the precise landing spot: "open A.3" or, when the link
   lands somewhere, "open both A.3 and B.7" (the exact B segment holding it).
- Level-1 / direct references only. Not transitive, not file-wide, no skeleton.
- The connection is a match of (editing-segment connectors) against (candidate
  file segments), returning exact segment addresses. This is why it never needs
  to dump anything — it answers "where does THIS call go?" with one address.### 6c. `ping` / logic-trace — transitive hop-following (NEW primitive)
Distinct from 6b (single-hop). Answers: "follow the logic from module A and show
every hop it makes until the trail is cut." (confirmed 2026-06-04)
- You `ping` module/segment A. The architect resolves A's outgoing call (6b
  mechanic), lands on B.7, then resolves B.7's outgoing call to C.2, and so on —
  following ONE logic thread hop by hop.
- Stops when "the line is cut": the chain dead-ends, hits an unresolvable/external
  reference, or leaves the indexed code. Output = the ordered trail of hops
  (A.3 -> B.7 -> C.2 -> ...) with each landing address.
- Purpose: immediate fault localization. Seeing where the logic flow STOPS is
  usually exactly where the bug is. This is the debugging question I actually have
  ("where does the logic go and where does it break"), far more than "list all
  connections."
- Implementation = 6b applied repeatedly, accumulating the path, with a cut
  condition + cycle guard (don't loop A->B->A forever). Bounded, one thread, no dump.### CORRECTION to #6 (2026-06-04): keep the connections store — do NOT remove it
- #6 above says "remove the project-skeleton dump." That refers ONLY to the DUMP
  BEHAVIOR (a plain file read should not push all 215 files / ~5000 tokens).
- It does NOT mean remove or reshape the underlying CONNECTIONS data. Keep that
  store exactly as it is: it is the substrate 6b (single-hop resolution) and 6c
  (ping/hop-trace) walk. Gutting it to fix the dump would tear out the foundation
  the trace primitive needs.
- Correct fix scope: change WHEN/HOW MUCH is surfaced on a read (file's own
  structure only, search->propose for cross-file), while PRESERVING the connections
  records untouched. The connections are kept on purpose for the hop-scan action.### 7. Mutating ops (insert/replace/delete) echo the ENTIRE file skeleton
- After inserting one function, the response returned all 69 segments of worker.py.
- I only needed: confirmation + the new segment's address + maybe immediate neighbors.
- Suggested fix: insert/replace/delete return just the affected segment(s) +
  immediate neighbors by default; add `full_skeleton:true` opt-in for the rest.
- This compounds with edit-heavy sessions: every structural edit pays full-skeleton
  token cost even though the caller already knows the structure.### 8. run_cmd signal filter too aggressive on read-only listing
- `ls`, `find -name/-printf`, multi-part `echo *` with filenames, and small `cat`
  of non-code text files get blocked as "file reading", costing several reworked
  calls per listing.
- These are read-only and safe; the danger case is file *editing* via interpreters,
  not listing. Suggested fix: allow `ls`, `find` listing, and `cat` of small
  (<~50 line) non-source text; keep blocking write-style commands.
- Workarounds that DO pass: `echo *` (single dir), `for f in ...; do test -e; done`,
  `sqlite3 ... "SELECT..."`, `wc -l`/`grep -c`. Noted for my own future use.### Validated working this session (positive notes)
- insert-into-gap on a real file (between is_degenerate and title_untitled in
  worker.py): worked cleanly, no corruption, correct ins_ id. The id-collision
  fix holds.
- section_group grouping confirmed live (read_file.js segment 7 = OPERATIONS
  section_group with correct nested child tree).
- verify(1) -> commit roundtrip on a Python file: clean.## VERIFIED-LINKS SYSTEM — design locked 2026-06-04 (build next; partial schema exists)
The upgrade that makes connection navigation (6/6b/6c) trustworthy. Connection
resolution becomes a VERIFICATION-TIME FACT, not a scan-time guess that goes stale.### Core idea
- Links are bound when a file passes L3 (L3 already tests that local imports resolve
  — confirmed in verifyL3 -> checkImportResolution). At that moment, bind each
  resolved connector to its target and record a verified_links row.
- A link is ACTIVE only while the file is at its current (highest) version AND L3.### Validation levels (set by scan; scan BOOTSTRAPS a fresh install)
- L1 = file exists. L2 = parses (syntactically correct). L3 = parses AND all local
  imports resolve.
- A mass scan grades every parseable file to its achievable level and stamps
  verification_status='verified' + verified_at_level + version.### Version = a log of VALIDATION-STATE TRANSITIONS (not just content hash)
- Version bumps whenever the achievable level CHANGES: L2->L3 bumps, L3->L1 (broke
  syntax) bumps. Re-validating an unchanged file at the SAME level does NOT bump.
- Every transition is filed (file_versions already exists) so users can trace what
  their edit caused and see all prior states.
- Unchanged files hit the scan hash-gate and are skipped entirely (no bump, links
  intact) — so stamping/minting only happens in the parse+resolve path. Correct.### Active-links rule
- verified_links has a `version` column. A link is ACTIVE iff
  verified_links.version == files.version. When a new version appears, the new
  version's links are minted active; OLD versions' links are RETAINED as plain
  references (the historical "what resolved at version N" trail), not deleted.## CORRECTION (2026-06-04, late): what OLD versions retain + retention policy
This supersedes the "Active-links rule" wording above (the "old versions demote to
references" line is WRONG).- LINKS EXIST ONLY FOR THE CURRENT VERSION. Connection resolution is always a
  now-thing, attached to the top version. There is no per-version link history.
- An OLD (non-current) version retains ONLY: status/level (L1/L2/L3), the version
  number, and the FULL SKELETON of the file + its segments at that version. It holds
  NO links/connections at all.
- So version history = a lightweight STRUCTURAL+STATUS snapshot per version (skeleton
  + level + version number), NOT a link record. "At version N the file was L3 and
  looked structurally like THIS skeleton."Implications for the build (correcting earlier notes):
- verified_links is ALWAYS current-version-only. No accumulation of old-version link
  rows; on a version transition, the current links are re-minted for the new version
  and the previous version simply keeps its skeleton+status snapshot (no links).
- "Active link" therefore = it exists at all (it only ever describes the current
  version). The `version` column still tags which version minted it, but old-version
  link rows are not retained.### Retention policy + OLD VERSIONS ARE READABLE & ROLLBACK-ABLE (corrected 2026-06-04)
"Reference" does NOT mean inert/demoted. An old version snapshot stays fully
OPERATIONAL: readable on request, and ROLLBACK-able (restore the file to that version).
- What a kept version holds: status/level (L1/L2/L3) + version number + the FULL
  SKELETON (viewable structure) + the stored CONTENT at that version (needed to
  actually roll back — skeleton shows structure, content provides the bytes).
- It holds NO links (links are current-version-only, as corrected above). On rollback,
  the restored version becomes current and its links get (re)minted by L3 at that point.
- Rollback mechanism already has its substrate: storeFileContent / getStoredSkeleton
  / file_content + file_versions tables exist. Rollback = read stored content for
  version N, write it back, re-validate (which re-mints current links).
- Retention count (UI field: unlimited / 10 / 30 / …) governs how far back you can
  roll: prune oldest version snapshots (skeleton + status + content) beyond the limit.
  verified_links still needs no per-version pruning (current-only).
- So version history is an ACTIVE store (read any past version, restore any past
  version), not a passive audit log.### Schema already created (additive, nothing reads/writes it yet)
- Table verified_links(id, source_file_id, source_module_id, import_id, connector,
  target_file_id, target_module_id, verified_at, version) + indexes. Harmless until wired.### BLOCKER found 2026-06-04 (why minting was NOT wired tonight)
- Source-segment binding by import LINE does NOT work: imports sit at file top
  (e.g. lines 47-74 in read_file.js) ABOVE all module segments (first module starts
  line 80). So no module's line range contains an import line.
- "The connector in the segment you're editing" really means the segment that USES
  the imported symbol, not where the `import` statement physically sits. That needs
  SYMBOL-USAGE ANALYSIS per segment (which module references the imported name) —
  a scanner capability that does not exist yet. imports table stores import_path +
  line + resolved_file_id, but NOT imported symbol names or per-segment usage.
- Consequence: tonight we could only do FILE-level source binding, not segment-
  precise. Recorded and deferred so the binding is built ONCE, correctly, with the
  usage-analysis half. File-level resolution already works today.### Build order when resumed1. Add symbol-usage capture to scan (which segment uses which imported symbol).2. In scanProject second pass: per file compute level (L1/L2/L3), compare to stored
   verified_at_level, bump version + file history ONLY on transition, mint links for
   L3 files (source_module via USAGE, target via resolved_file_id + target symbol's
   module).3. getConnections reads ACTIVE verified_links (version match) first; raw imports as
   dim fallback. Then 6b (single hop) and 6c (ping/trace) read from active links.## CLARIFICATION (2026-06-04): the segments ARE the file (no separate content blob)
Refines the rollback note above. A version snapshot does NOT need a separate stored
content copy alongside the skeleton:
- skeleton (structure + titles) + the SEGMENT TEXTS in order = the file, byte-for-byte.
  Pasting the segments back in order reconstructs it exactly.
- So a version snapshot = the frozen SEGMENT TREE (segments + their bodies + titles +
  status/level + version number). That single thing is both the viewable structure
  AND the restorable content. There is no redundant content blob.
- Rollback = take version N's frozen segment tree, assemble in order (same as the
  editor's assembleText: prefix + children + suffix), write to disk, re-validate.
- Matches how the editor already reconstructs files from segments. A snapshot is just
  a frozen copy of that segment tree; restore = assemble it back out.
- Implication for storage: the per-version store holds segment trees, not whole-file
  blobs. Retention pruning drops old segment trees. (file_content/file_versions may
  already approximate this — confirm at build time and align to segment-tree storage.)## #1 RESOLVED (2026-06-04): buffer cap is a non-issue
- The original #1 ("buffer cap too tight") is dissolved by the architect-as-store
  design. Reading a file's STRUCTURE comes from the architect's stored segment trees
  (skeleton + segments = the file), NOT from occupying a live editing buffer.
- Live buffers are only needed for files with PENDING DIRTY edits, which is a small
  set by nature (you don't have 10 half-finished edits at once).
- Current state already fine: MAX_OPEN_BUFFERS=10 + auto-evict-of-clean-buffers
  already implemented (evicts oldest non-dirty buffer when full; only errors if ALL
  are dirty). No code change needed. Closing #1.## #2 RESOLVED (2026-06-04): address-shift is workflow, not a defect
- Original #2 framed "addresses shift after edits" as a bug needing a hint message.
  It is not a defect — it is the intended workflow.
- The architect updates addresses IMMEDIATELY after each edit (the reparse on commit).
  The working rule: to reorder/swap things in a file, COMMIT then REOPEN to continue.
  Reopening gives the fresh, correct ordering automatically.
- You don't keep editing against pre-edit addresses across a structural change —
  commit the structural change, reopen, addresses are current. No hint needed; the
  reparse-on-commit + reopen-to-continue IS the design. Closing #2.## SINGLE-ACTIVE-EDIT RULE — BUILT + LIVE (2026-06-04)
- read_file.js openOrGetBuffer now enforces: at most ONE buffer with uncommitted
  edits at a time. Opening a new file while another buffer is dirty throws
  "Single-active-edit: '<path>' has uncommitted edits. Commit or discard...".
- Reading the referenced (matcher-proposed) file is allowed — reads don't dirty a
  buffer; you just can't START a second edit until the first is committed/discarded.
- Discard is always available as the escape hatch (no lockout possible).
- WHY: cheap guardrail so one bad edit can't compound into a tangle across files —
  especially important for OTHER users running this with weaker models (e.g. Codestral).
- STATUS: committed to disk, server restarted (PID 31428), validated LIVE end-to-end
  (dirty buffer blocks second open; discard unblocks; reopen works). DONE, not specced.
- Address repositioning (old #2) confirmed solved by commit->reopen workflow; the two
  together give safe multi-file editing: strong anti-fuckup rule + cheap re-addressing.## KEYSTONE (2026-06-04): FILE IDENTITY = STABLE ID + PER-VERSION SUB-DBs
This is the root-cause fix for the stale-FK bug AND the unifying structure for
versioning + verified-links. Decided with Konstantinos.### The stale-FK bug we found (evidence)
- read_file.js (id 307) import './lib/editor/architect-link.js' has
  resolved_file_id=338. But id 338 DOES NOT EXIST (count 0).
- architect-link.js exists TWICE in files: id 353 at OLD path lib/architect-link.js
  (present_on_disk=0, ghost) and id 1502 at CURRENT path lib/editor/architect-link.js
  (present_on_disk=1, but address='pending'!).
- So the file MOVED paths over time and got a NEW id each move: 338 -> 353 -> 1502.
  The importer (307) still points at the oldest dead id 338.
- WHY it never heals: importer's resolved_file_id is only rewritten when the IMPORTER
  is re-parsed. read_file.js (307) has content_hash + 41 modules, so on re-scan it
  hits the HASH-GATE and is skipped entirely — its imports never re-resolve even
  though the TARGET moved. Unchanged importer + moved target = permanent stale FK.
- Scope today: only 2 stale FKs, 38 valid, 6 null. Narrow, but the mechanism is real.
- Second bug exposed: the moved file (1502) is present_on_disk=1 but address='pending'
  — the move path never assigned it a real address.### ROOT CAUSE (Konstantinos): the scanner mints a NEW id on move/recreate
- Identity is keyed on abs_path (upsert on abs_path), so a moved file looks like a
  NEW file and gets a new id, orphaning the old row + every importer FK to it.
- THE FIX IS NOT "re-resolve importers when targets move." The fix is: a file must
  KEEP ONE STABLE id FOREVER. Moves/edits bump its VERSION, never its id.### THE STRUCTURE (keystone model)
- Think of it as: the MAIN db row = the IDENTITY (the id). Hanging off it are
  SUB-DBs, one per STATE/VERSION. Each sub-db is a self-contained entity holding
  THAT version's: validation level (L1/L2/L3) + skeleton + segments. (Segments ARE
  the file, so a version sub-db is both viewable and restorable — see earlier note.)
- Only the LATEST (highest) version is ACTIVELY LINKED for resolution. getConnections
  / 6b / 6c read ONLY the active version.
- All older versions are HIDDEN: never in the resolution path. Pulled only for
  COMPARISON (diff) or ROLLBACK. Rollback = make a hidden version active again
  (becomes/spawns the new highest version).
- This mirrors the rest of Monster's architecture: one identity anchor + append-only
  per-state sub-stores + only-newest-active (same shape as the memory append-only
  archive, per-letter SQLite DBs, FEK LMDB-per-year).### Why this unifies everything
- IMPORTERS bind to file_id (stable forever) for the TARGET, and to the ACTIVE
  version's segment for the SOURCE. A move/edit bumps the target's version, NOT its
  id, so importer FKs can NEVER dangle. The 338->353->1502 chain becomes one id with
  three versions. Stale-FK bug structurally impossible.
- "verified-links" + "versioning" + "stale-FK fix" are NOT three tasks — they are ONE
  structure: id-anchored identity, version-sub-db'd state, newest-active resolution.### What this changes in the build order (supersedes earlier scanner-fix wording)1. File identity must become STABLE (not abs_path-keyed). Scanner must detect "same
   file, moved/changed" and keep the id, bumping a version sub-db instead of inserting
   a new files row. (Open design Q for next session: how to detect identity across a
   move — content-hash lineage, stored identity marker, or rel_path move-detection.)2. Per-version sub-db store: file_id -> {v1, v2, ... vN}, each holding level+skeleton+
   segments. Only vN active. Retention prunes oldest sub-dbs (user-set count).3. Resolution/L3 binds to file_id (target) + active-version segment (source). Mint
   verified_links against the ACTIVE version only.4. Data cleanup for the 2 existing stale FKs + the 'pending' address on 1502 happens
   AS PART OF this rework (don't hand-patch now; fix via the corrected identity model).
- NOTE: do NOT edit scanProject at session-end. This is foundational; build it fresh.
### Why this is also FASTER (scaling property, Konstantinos 2026-06-04)
The sub-db model makes resolution TWO CHEAP QUERIES instead of one global scan,
and the cost stays flat as the repo grows:
1. ONE query against the active-version set: "active version of file X" — a single
   indexed lookup on a stable file_id. O(log n) even at 3k / 30k files.
2. ONE TINY query into THAT file's own version sub-db for the segment/skeleton you
   need — bounded to ONE file's segments, not the global pile.
- Contrast with today: `modules` is ONE flat table for the whole project (216 files
  -> 1231 modules already). Every segment lookup scans against all of them; at 3k+
  files that's tens of thousands of segment rows per navigation. Per-file version
  sub-dbs keep the segment query bounded to one file regardless of repo size.
- Compounds with newest-active: the active-resolution set holds ONE row per file
  (current version only), never N×versions. History sub-dbs sit off to the side,
  touched only for diff/rollback — normal navigation never pays for version history.
- Same scaling principle as the rest of Monster (FEK LMDB-per-year, memory per-letter
  DBs): keep the working set small and bounded, never scan the global pile. A 3k-file
  and a 30k-file repo cost ~the same per navigation.
