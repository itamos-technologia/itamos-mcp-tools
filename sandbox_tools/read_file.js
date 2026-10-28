/**
 * MCP shim for read_file.
 *
 * Segment-addressed file editor with master-architect project awareness.
 *
 * On file open, queries master-architect's DB to detect project membership
 * and attaches a `project` field to the response (skeleton, address, etc.).
 * If the opened file is not yet placed in a project, a link-discovery hook
 * files it (auto-absorbing unknown_N clusters into a real project when a
 * link resolves) — never prompts, never breaks the read.
 *
 * Implementation lives in ../tools/master-architect/read_file.js (post-merger
 * location). This file just re-exports the tool definition so
 * server-modular.js's mcp_tools/ loader picks it up.
 *
 * If the master-architect DB is missing or unavailable, project-info lookup
 * and link-discovery degrade gracefully and read_file behaves exactly like
 * before. The architect linkage is purely additive.
 */

import tool from '../tools/master-architect/read_file.js';
import { resolveProjectTarget, resolveCoordinate } from '../tools/master-architect/lib/project_view.js';
import { withEditFlow } from './lib/edit_flow.js';   // two-call editing: read → edit token → one edit

// ── Project coordinates for edits ───────────────────────────────────────────
// Reads accept a project plus a coordinate (path="wce", segment="e.h.25").
// Edits used to need the FILE path plus a file-local segment number; with a
// project path the engine silently showed the project structure instead.
// This translates edit calls before the engine sees them:
//  - a project coordinate in an edit field (replace, comment_out, uncomment,
//    delete, move, paste.to, insert.between, undo) becomes the file path plus
//    the segment address inside that file;
//  - commit / diff / discard / undo=true|"all" with a project path (or no path)
//    go to the file that holds the open edit.
// Calls with a file path, reads, trace and status pass through unchanged.
const shimWrap = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const isAnchor = (v) => ['start', 'end', '0', '-1'].includes(String(v).trim().toLowerCase());

// Every field that holds a segment address, as [address, setter] pairs.
function editCoords(args) {
  const fields = [];
  for (const k of ['replace', 'comment_out', 'uncomment']) {
    if (typeof args[k] === 'string') fields.push([args[k], (v) => { args[k] = v; }]);
  }
  if (typeof args.undo === 'string' && !['all', 'true', 'false'].includes(args.undo)) {
    fields.push([args.undo, (v) => { args.undo = v; }]);
  }
  if (Array.isArray(args.delete)) args.delete.forEach((c, i) => fields.push([c, (v) => { args.delete[i] = v; }]));
  if (args.move && typeof args.move === 'object') {
    for (const k of ['seg', 'after', 'before']) {
      if (typeof args.move[k] === 'string' && !isAnchor(args.move[k])) fields.push([args.move[k], (v) => { args.move[k] = v; }]);
    }
  }
  if (args.paste && typeof args.paste.to === 'string') fields.push([args.paste.to, (v) => { args.paste.to = v; }]);
  if (args.insert && Array.isArray(args.insert.between)) {
    args.insert.between.forEach((c, i) => { if (!isAnchor(c)) fields.push([c, (v) => { args.insert.between[i] = v; }]); });
  }
  return fields;
}

async function translate(args, ctx) {
  if (!args || args.action === 'status' || args.trace !== undefined) return { args };
  const target = args.path ? resolveProjectTarget(args.path) : null;
  const inProject = !!target && target.kind === 'project';

  // A read of a segment by project coordinate: the engine resolves it itself;
  // only note the file's coordinate so the answer comes back in project form.
  if (args.segment !== undefined) {
    if (inProject) {
      const c = resolveCoordinate(target.project, args.segment);
      if (c && c.kind === 'file' && c.segment) {
        const coord = String(args.segment);
        return { args, filePrefix: coord.slice(0, coord.length - c.segment.length - 1) };
      }
      // The file itself (its map, or a search inside it): addresses in the
      // answer (e.g. content_matches) are file-local, so prefix them with the
      // file's coordinate too.
      if (c && c.kind === 'file' && !c.segment) {
        return { args, filePrefix: String(args.segment) };
      }
    }
    return { args };
  }
  args = structuredClone(args);

  const fields = editCoords(args);
  if (fields.length) {
    if (!inProject) return { args };   // a file path: the engine takes plain segment numbers
    let file = null, filePrefix = null;
    for (const [coord, set] of fields) {
      const c = resolveCoordinate(target.project, coord);
      if (!c || c.kind !== 'file' || !c.segment) {
        return { error: {
          error: `"${coord}" is not a segment inside a file of project '${target.project.name}'.`,
          next: `read_file(path="${target.project.name}", segment="<file coordinate>") lists that file's segments`,
        } };
      }
      if (file && file !== c.absPath) return { error: { error: 'All coordinates in one edit must be in the same file.' } };
      file = c.absPath;
      // The file's own coordinate (e.g. "h.a.e" of "h.a.e.7.48.30"), used to turn
      // the engine's file-local addresses back into project coordinates.
      filePrefix = String(coord).slice(0, String(coord).length - c.segment.length - 1);
      set(c.segment);
    }
    args.path = file;
    return { args, filePrefix };
  }

  const isOn = (v) => v === true || v === 'true';
  const control = isOn(args.commit) || isOn(args.diff) || isOn(args.discard) || isOn(args.undo) || args.undo === 'all';
  if (control && (!args.path || inProject)) {
    const st = JSON.parse((await tool.handler({ action: 'status' }, ctx)).content[0].text);
    const bufs = st.open_buffers || [];
    const open = bufs.find((b) => b.dirty || b.edits > 0) || (bufs.length === 1 ? bufs[0] : null);
    if (!open) return { error: { error: 'There is no open edit to apply this to.', next: 'Read a segment, edit it, then commit.' } };
    args.path = open.path;
  }
  return { args };
}

// The engine answers in file-local addresses ("7.48.34"). When the caller used
// project coordinates, give them back in the same form ("h.a.e.7.48.34").
const ADDRESS_KEYS = new Set(['address', 'from', 'to', 'parent', 'replaced']);
function toProjectCoords(value, prefix) {
  if (Array.isArray(value)) return value.map((v) => toProjectCoords(v, prefix));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'labelled_code' && typeof v === 'string') {
      // A small block shown whole labels each part "[31.21.1.13] code".
      out[k] = v.replace(/^\[(\d+(?:\.\d+)*)\]/gm, (_, a) => `[${prefix}.${a}]`);
      continue;
    }
    out[k] = (ADDRESS_KEYS.has(k) && typeof v === 'string' && /^\d+(\.\d+)*$/.test(v))
      ? `${prefix}.${v}`
      : toProjectCoords(v, prefix);
  }
  return out;
}

import path from 'node:path';

// ── Automatic validation + save ─────────────────────────────────────────────
// Every edit action (replace, insert, delete, move, comment_out, uncomment,
// paste) is validated and saved in the same call. If validation passes, the
// change is written and the answer says what was saved and how the edited area
// is numbered now (names and lines, never code). If it fails, nothing is saved:
// the change is dropped, the file on disk is unchanged, and the answer says
// why. The targets the caller had read stay unlocked (their code on disk is
// exactly what the caller saw), so a corrected version can be sent straight
// away. After a successful save everything must be read again (fresh-read rule).
const EDIT_VERBS = ['replace', 'insert', 'delete', 'move', 'comment_out', 'uncomment', 'paste'];
const isEditCall = (a) => !!a && EDIT_VERBS.some((k) => a[k] !== undefined && a[k] !== null && a[k] !== false);
const parseRes = (res) => { try { return JSON.parse(res?.content?.[0]?.text); } catch { return null; } };

// File-local addresses the edit acts on (the ones that needed a fresh read).
function editTargets(a) {
  const t = [];
  for (const k of ['replace', 'comment_out', 'uncomment']) if (typeof a[k] === 'string') t.push(a[k]);
  if (Array.isArray(a.delete)) t.push(...a.delete.map(String));
  if (a.move && typeof a.move.seg === 'string') t.push(a.move.seg);
  if (a.paste && typeof a.paste.to === 'string') t.push(a.paste.to);
  return t;
}

// The address whose surroundings show the result of the edit.
function editAnchor(a) {
  const t = editTargets(a);
  if (t.length) return t[0];
  if (a.insert && Array.isArray(a.insert.between)) return a.insert.between.find((c) => !isAnchor(c)) || null;
  return null;
}

function describeEdit(a, P) {
  const at = (c) => (isAnchor(c) ? String(c) : P(c));
  if (typeof a.replace === 'string') return `replace ${P(a.replace)}`;
  if (a.insert && Array.isArray(a.insert.between)) return `insert between ${a.insert.between.map(at).join(' and ')}`;
  if (Array.isArray(a.delete)) return `delete ${a.delete.map(P).join(', ')}`;
  if (a.move) return `move ${P(a.move.seg)} ${a.move.after !== undefined ? `after ${at(a.move.after)}` : `before ${at(a.move.before)}`}`;
  if (typeof a.comment_out === 'string') return `deactivate ${P(a.comment_out)}`;
  if (typeof a.uncomment === 'string') return `activate ${P(a.uncomment)}`;
  if (a.paste) return `paste into ${P(a.paste.to)}`;
  return 'edit';
}

async function editAndSave(a, origPath, prefix, ctx) {
  const P = (addr) => (prefix ? `${prefix}.${addr}` : String(addr));
  const file = a.path;
  delete a.commit;                                   // saving is automatic
  const editRes = await tool.handler(a, ctx);
  const edit = parseRes(editRes);
  const applied = !!edit && !edit.error && !!(edit.replaced || edit.inserted || edit.deleted || edit.moved);
  if (!applied) return (prefix && edit) ? shimWrap(toProjectCoords(edit, prefix)) : editRes;

  const action = describeEdit(a, P);
  const target = origPath ? resolveProjectTarget(origPath) : null;
  const root = target && target.kind === 'project' ? target.project.root_path : null;
  const rel = root ? path.relative(root, file) : file;

  let saved;
  try { saved = parseRes(await tool.handler({ path: file, commit: true }, ctx)); } catch (e) { saved = { error: e.message }; }

  if (!saved || !saved.committed) {
    // Rejected: drop the change (disk stays as it was) and keep the targets the
    // caller had read unlocked, since their code on disk is what it saw.
    await tool.handler({ path: file, discard: true }, ctx);
    for (const addr of editTargets(a)) {
      try { await tool.handler({ path: file, segment: addr }, ctx); } catch { /* best effort */ }
    }
    const errs = (saved && Array.isArray(saved.errors) ? saved.errors : [])
      .filter((m) => !/\bOK\b|no linter configured/.test(m));
    const syntax = errs.some((m) => /^L1\b/.test(m));
    // Over-escaped content: the whole block arrives as one line with literal
    // "\n" pairs (often with \" too) instead of real line breaks. Name that cause,
    // since the parse error alone does not tell a model what it did wrong.
    const sent = typeof a.content === 'string' ? a.content
      : (a.insert && typeof a.insert.content === 'string' ? a.insert.content : '');
    const literalBreaks = (sent.match(/\\n/g) || []).length;
    const realBreaks = (sent.match(/\n/g) || []).length;
    const overEscaped = literalBreaks >= 2 && literalBreaks > realBreaks * 2;
    return shimWrap({
      rejected: true,
      action,
      file: rel,
      reason: saved && saved.blocked
        ? (syntax ? 'Syntax error: the file would not parse with this change.' : 'The file checker rejected this change.')
        : `The change could not be saved: ${saved?.error || saved?.message || 'unknown error'}`,
      ...(overEscaped ? { cause: `Your content contains ${literalBreaks} literal "\\n" escape sequences and ${realBreaks} real line breaks, so the code arrived as one long line. Send the code with real line breaks (and plain " quotes, not \\"), exactly as it should appear in the file.` } : {}),
      ...(errs.length ? { errors: errs.slice(0, 2) } : {}),
      nothing_saved: true,
      next: `The file is unchanged and the target is still unlocked. Fix the content and send the ${action.split(' ')[0]} again.`,
    });
  }

  // Saved: show how the edited area is numbered now (names and lines, no code).
  let now;
  const anchor = editAnchor(a);
  try {
    // Only the edited place and a few neighbours on each side (addresses of
    // siblings step by 2, gaps sit in between): enough to see the new numbering.
    const near = (addr, center) => Math.abs((Number(String(addr).split('.').pop()) || 0) - center) <= 6;
    const center = Number(String(anchor || '').split('.').pop()) || 0;
    if (anchor && String(anchor).includes('.')) {
      const parent = String(anchor).split('.').slice(0, -1).join('.');
      const r = parseRes(await tool.handler({ path: file, segment: parent }, ctx));
      if (r && !r.error) {
        now = Array.isArray(r.children)
          ? r.children.filter((c) => near(c.address, center)).map((c) => ({ address: P(c.address), name: c.name, lines: c.lines }))
          : [{ address: P(r.address), name: r.name, lines: r.lines }];
      }
    } else {
      const r = parseRes(await tool.handler({ path: file }, ctx));
      const list = r && Array.isArray(r.segments) ? r.segments : [];
      now = list.map((s) => String(s).match(/^(\S+)\s+(.*)$/)).filter(Boolean)
        .filter((m) => near(m[1], center))
        .map((m) => ({ address: P(m[1]), name: m[2] }));
    }
  } catch { now = undefined; }
  // Looking up the new numbering must not unlock anything: clear the marks.
  await tool.handler({ path: file, discard: true }, ctx);

  // The path the caller should use next: the project name when there is one
  // (the server hands the tool absolute sandbox paths).
  const shownPath = target && target.kind === 'project' ? target.project.name : (origPath || file);
  return shimWrap({
    saved: true,
    action,
    file: rel,
    checks: saved.check,
    ...(saved.not_checked ? { not_checked: saved.not_checked } : {}),
    ...(saved.incomplete ? { incomplete: saved.incomplete } : {}),
    ...(now && now.length ? { now } : {}),
    next: `Read again before the next edit: read_file(path="${shownPath}", segment="<address from now>")`,
  });
}

import { z } from 'zod';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getDb } from '../tools/master-architect/lib/db.js';
import { storeFileContent } from '../tools/master-architect/lib/editor/architect-link.js';
import { reindexFile } from '../tools/master-architect/lib/scan.js';

// Parameters the model sees. commit, diff, discard and verify acted on a
// pending edit; with every edit validated and saved in the same call there is
// never one, so they are gone (the engine's commit is still used internally to
// do the save). undo now reverts saved changes, see undoChanges below.
const { commit: _commit, diff: _diff, discard: _discard, verify: _verify, ...publicSchema } = tool.schema;
publicSchema.undo = z.union([z.boolean(), z.number(), z.string()]).optional()
  .describe('Revert the project\'s last saved change(s), newest first: true = the last one, a number 1-10 = that many. Restores the previous versions from the architect history.');
// comment_out / uncomment become deactivate / activate: switched-off code is
// its own kind ("deactivated", shown as [off] ...), separate from comments.
delete publicSchema.comment_out;
delete publicSchema.uncomment;
publicSchema.deactivate = z.string().optional()
  .describe('Switch off a code segment (address you have read). It stays in the file as "[off]" lines and shows as deactivated.');
publicSchema.activate = z.string().optional()
  .describe('Switch a deactivated segment back on (address you have read). Only deactivated code can be activated, never a normal comment.');
publicSchema.segment = z.union([z.string(), z.array(z.string()).min(1).max(20)]).optional()
  .describe('In a file: a segment number ("31" or "31.17"). In a project: a coordinate, a file ("d.a.f") or a file plus segment ("d.a.f.31.17"). Several at once: a list (up to 20), e.g. ["e.h.31.21.1.3","e.h.31.21.1.13"]. Reading a segment unlocks it for editing.');
publicSchema.search = z.string().optional()
  .describe('On a project: files and folders whose path matches. On a file (path=<file>, or path=<project> with segment=<file coordinate>): segments whose name matches, plus content_matches — code lines containing the word, each with the address of the segment that holds it. Use it to jump to an error message, a call or a field instead of reading segment by segment.');

// ── Undo: the project's last saved changes ──────────────────────────────────
// Every successful save is logged (file, version before, version after,
// action); only the newest UNDO_LIMIT per project are kept. The contents
// themselves live in the architect's version store (file_versions). Before a
// save, the file's current disk content is stored there too (a no-op when it
// is already the latest version), so even the very first change of a file
// has a "before" version to return to.
const UNDO_LIMIT = 10;

function ensureChangeLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS change_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_root   TEXT NOT NULL,
    abs_path       TEXT NOT NULL,
    version_before INTEGER NOT NULL,
    version_after  INTEGER NOT NULL,
    action         TEXT,
    undone         INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

// Newest stored version of a file in the architect's version store. Read from
// file_versions itself: files.version is also bumped by markFileVerified, so it
// can point one past the newest stored version after an L3 save.
function latestStoredVersion(db, abs) {
  return db.prepare('SELECT MAX(fv.version_number) AS v FROM file_versions fv JOIN files f ON f.id = fv.file_id WHERE f.abs_path = ?').get(abs)?.v || null;
}

// Before a save: make sure the current disk content is a stored version and
// remember its number. Returns null for files the architect does not track.
function recordBaseline(file) {
  try {
    const abs = path.resolve(file);
    const db = getDb();
    ensureChangeLog(db);
    storeFileContent(abs, fs.readFileSync(abs, 'utf8'), null, { changeType: 'baseline' });
    const r = db.prepare('SELECT p.root_path FROM files f JOIN projects p ON p.id = f.project_id WHERE f.abs_path = ?').get(abs);
    const v = latestStoredVersion(db, abs);
    if (!r || !v) return null;
    return { abs, root: r.root_path, versionBefore: v };
  } catch {
    return null;
  }
}

// After a successful save: log it and keep only the newest UNDO_LIMIT entries.
function logChange(baseline, action) {
  try {
    const db = getDb();
    const after = latestStoredVersion(db, baseline.abs);
    if (!after || after === baseline.versionBefore) return;   // nothing new was stored
    db.prepare('INSERT INTO change_log (project_root, abs_path, version_before, version_after, action) VALUES (?, ?, ?, ?, ?)')
      .run(baseline.root, baseline.abs, baseline.versionBefore, after, action);
    db.prepare('DELETE FROM change_log WHERE project_root = ? AND id NOT IN (SELECT id FROM change_log WHERE project_root = ? ORDER BY id DESC LIMIT ?)')
      .run(baseline.root, baseline.root, UNDO_LIMIT);
  } catch { /* the save itself already succeeded */ }
}

async function undoChanges(args, ctx) {
  const v = args.undo;
  const n = (v === true || v === 'true') ? 1 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > UNDO_LIMIT) {
    return shimWrap({ error: `undo takes true (the last change) or a number from 1 to ${UNDO_LIMIT}.` });
  }
  const db = getDb();
  ensureChangeLog(db);
  let root = null;
  if (args.path) {
    const t = resolveProjectTarget(args.path);
    if (t && t.kind === 'project') root = t.project.root_path;
    else root = db.prepare('SELECT p.root_path FROM files f JOIN projects p ON p.id = f.project_id WHERE f.abs_path = ?').get(path.resolve(args.path))?.root_path || null;
  }
  const rows = root
    ? db.prepare('SELECT * FROM change_log WHERE undone = 0 AND project_root = ? ORDER BY id DESC LIMIT ?').all(root, n)
    : db.prepare('SELECT * FROM change_log WHERE undone = 0 ORDER BY id DESC LIMIT ?').all(n);
  if (!rows.length) return shimWrap({ message: 'There is nothing to undo.' });

  const getVersion = db.prepare('SELECT fv.content, fv.hash FROM file_versions fv JOIN files f ON f.id = fv.file_id WHERE f.abs_path = ? AND fv.version_number = ?');
  const undone = [];
  let stopped = null;
  for (const row of rows) {
    const rel = path.relative(row.project_root, row.abs_path);
    const before = getVersion.get(row.abs_path, row.version_before);
    const after = getVersion.get(row.abs_path, row.version_after);
    if (!before || before.content == null) { stopped = `${rel}: the previous version is no longer stored, so "${row.action}" was not reverted.`; break; }
    let disk = null;
    try { disk = fs.readFileSync(row.abs_path, 'utf8'); } catch { /* missing file */ }
    const diskHash = disk == null ? null : createHash('sha256').update(disk, 'utf8').digest('hex');
    if (!after || diskHash !== after.hash) {
      stopped = `${rel} changed after "${row.action}" was saved, so it was not reverted (nothing older was touched).`;
      break;
    }
    const content = String(before.content);
    fs.writeFileSync(row.abs_path, content, 'utf8');
    try { await reindexFile(row.abs_path, content); } catch { /* index refresh is best effort */ }
    try { storeFileContent(row.abs_path, content, null, { changeType: 'undo', changeSummary: `reverted: ${row.action}` }); } catch { /* version row is best effort */ }
    db.prepare('UPDATE change_log SET undone = 1 WHERE id = ?').run(row.id);
    await tool.handler({ path: row.abs_path, discard: true }, ctx);   // fresh-read rule: clear read marks
    undone.push({ reverted: row.action, file: rel });
  }
  const left = root
    ? db.prepare('SELECT COUNT(*) AS c FROM change_log WHERE undone = 0 AND project_root = ?').get(root).c
    : db.prepare('SELECT COUNT(*) AS c FROM change_log WHERE undone = 0').get().c;
  return shimWrap({
    ...(undone.length ? { undone } : {}),
    ...(stopped ? { stopped } : {}),
    can_still_undo: left,
    next: undone.length ? 'Read again before the next edit.' : 'Nothing was changed.',
  });
}

const DESCRIPTION = 'Read anything, and edit it safely. read_file() lists your projects. ' +
  'path=<project name or folder>: its structure only, no code: folders and files with coordinates ' +
  '(letters = location, e.g. "d.a.f"); over ~3000 tokens it asks for search. A folder not scanned yet is scanned first. ' +
  'path=<project> with segment="<file coordinate>" gives that file map (one line per segment); ' +
  'segment="<file coordinate>.<segment>" (e.g. "d.a.f.31.17") gives that segment. ' +
  'Find the spot first: search="<word>" on a file returns the code lines containing it, each with its segment address ' +
  '(an error message, a call, a field), so you can jump there instead of reading segment by segment. ' +
  'A small block (up to ~60 lines) is shown whole, each part labelled [address]; a bigger one shows its opening line ' +
  'and a list of its children with their first line of code: read the child you need. ' +
  'Read several segments in one call with a list: segment=["d.a.f.31.3","d.a.f.31.13"]. ' +
  'In maps, "// ..." is a comment and "[off] ..." is deactivated (switched-off) code. ' +
  'path=<file> works the same with plain segment numbers. ' +
  'Editing: use the same path and coordinate you read with, and only change segments you have read since the last change. ' +
  'Each edit (replace/insert/delete/move/paste/deactivate/activate) is checked and saved in the same call: ' +
  'a syntax error or a failing config checker rejects it and nothing is saved; otherwise it is saved and the answer ' +
  'shows the new coordinates of that area. Read again before the next edit. ' +
  'Example: read_file(path="wce", segment="e.h.25"), then read_file(path="wce", replace="e.h.25", content="<new code>"). ' +
  'undo=true reverts the project\'s last saved change, undo=<1-10> that many. ' +
  'trace=true: what a file connects to, or a project data-flow map.';

const sandboxReadFile = {
  ...tool,
  description: DESCRIPTION,
  schema: publicSchema,
  async handler(args, ctx) {
    // Several segments in one read: a list (or a comma-separated string) of
    // addresses. Each one goes through the normal single read below, so
    // project coordinates and file paths work as usual, and every shown
    // segment is unlocked for editing; the answers come back together.
    if (args && !isEditCall(args) && args.segment !== undefined) {
      const list = Array.isArray(args.segment) ? args.segment
        : (typeof args.segment === 'string' && args.segment.includes(',') ? args.segment.split(',') : null);
      if (list) {
        const addrs = list.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
        const segments = [];
        for (const a of addrs) {
          const r = await sandboxReadFile.handler({ ...args, segment: a }, ctx);
          const text = r?.content?.[0]?.text;
          try { segments.push(JSON.parse(text)); } catch { segments.push({ address: a, result: text }); }
        }
        return shimWrap({ segments });
      }
    }
    // deactivate / activate are the engine's comment_out / uncomment.
    if (args && (args.deactivate !== undefined || args.activate !== undefined)) {
      args = { ...args };
      if (args.deactivate !== undefined) { args.comment_out = args.deactivate; delete args.deactivate; }
      if (args.activate !== undefined) { args.uncomment = args.activate; delete args.activate; }
    }
    // Verbs for pending edits no longer exist: every edit saves itself.
    if (args && !isEditCall(args) && ['commit', 'diff', 'discard', 'verify'].some((k) => args[k] !== undefined)) {
      return shimWrap({ message: 'Saving is automatic: every edit is checked and saved in the same call. To revert saved changes use undo (true = the last one, or a number up to 10).' });
    }
    if (args && args.undo !== undefined && !isEditCall(args)) return undoChanges(args, ctx);
    let t;
    try {
      t = await translate(args, ctx);
    } catch (e) {
      return shimWrap({ error: `Could not resolve the coordinate: ${e.message}` });
    }
    if (t.error) return shimWrap(t.error);
    if (isEditCall(t.args)) {
      // Make sure the current content is a stored version (so this change can
      // be undone), save the edit, and log it when it was saved.
      const baseline = recordBaseline(t.args.path);
      const res = await editAndSave(t.args, args?.path, t.filePrefix, ctx);
      const out = parseRes(res);
      if (baseline && out && out.saved) logChange(baseline, out.action);
      return res;
    }
    const res = await tool.handler(t.args, ctx);
    if (!t.filePrefix) return res;
    try {
      const text = res?.content?.[0]?.text;
      return shimWrap(toProjectCoords(JSON.parse(text), t.filePrefix));
    } catch {
      return res;   // not JSON: pass it through unchanged
    }
  },
};

// What the server registers: the same tool behind the two-call edit flow
// (lib/edit_flow.js), which also supplies the description and schema.
export default withEditFlow(sandboxReadFile);
