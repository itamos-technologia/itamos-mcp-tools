// ── Two-call editing for read_file ──────────────────────────────────────────
// Step 1, a read of one segment: the answer carries edit.token plus the actions
// that fit that segment (edit.options) and a ready example call.
// Step 2: read_file(edit=<token>, action=<option>, content=<code>) does exactly
// one edit. The wrapper reads the segment itself first (that unlocks it in the
// engine within the same request), re-indents the content, and hands the edit
// to the normal read_file handler, which checks and saves it.
//
// The token holds where the segment is plus a hash of the file as it was read.
// Any save changes the file, so every token of that file is spent by it: one
// edit, then a fresh read. No server-side state, so parallel calls and new
// turns cannot break it.
//
// Every wrong call gets a clear error with a correct example call. The old
// address-based edit parameters stay in the schema only as stubs, because the
// SDK drops unknown keys: without the stubs, a stray delete=[...] would quietly
// turn into a plain read instead of reaching the error below.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolveProjectTarget, resolveCoordinate } from '../../tools/master-architect/lib/project_view.js';

const OLD_EDIT_KEYS = ['replace', 'insert', 'delete', 'move', 'paste', 'deactivate', 'activate', 'comment_out', 'uncomment'];

const OLD_TO_ACTION = {
  replace: 'replace', insert: 'insert_after', delete: 'delete', move: 'move_after', paste: 'paste',
  deactivate: 'deactivate', comment_out: 'deactivate', activate: 'activate', uncomment: 'activate',
};
const EDIT_ACTIONS = ['replace', 'insert_before', 'insert_after', 'delete', 'deactivate', 'activate', 'move_after', 'move_before', 'paste'];
const NEEDS_CONTENT = new Set(['replace', 'insert_before', 'insert_after']);
const REPEAT_LIMIT = 3;

const parse = (res) => { try { return JSON.parse(res?.content?.[0]?.text); } catch { return null; } };
const wrap = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const q = (s) => JSON.stringify(String(s));
const fileHash = (abs) => createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 12);

// Example calls, ready to copy.
const exEdit = (token, action) =>
  `read_file(edit=${q(token)}, action=${q(action)}${NEEDS_CONTENT.has(action) ? ', content="<new code>"' : ''}${action.startsWith('move_') ? ', to="<address>"' : ''}${action === 'paste' ? ', from="<address>"' : ''})`;
const exRead = (p, seg) => `read_file(path=${q(p)}, segment=${q(seg)})`;

// The path as the model knows it (project name or path inside its sandbox).
function shownPath(ctx, abs) {
  if (!abs) return '<project>';
  if (!ctx || !ctx.sandboxDir) return abs;
  const rel = path.relative(ctx.sandboxDir, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

// The file and the file-local segment address behind a read.
function locate(jailedPath, coord) {
  if (!jailedPath || coord === undefined || coord === null) return null;
  let target = null;
  try { target = resolveProjectTarget(jailedPath); } catch { target = null; }
  if (target && target.kind === 'project') {
    let c = null;
    try { c = resolveCoordinate(target.project, String(coord)); } catch { c = null; }
    return c && c.kind === 'file' && c.segment ? { abs: c.absPath, local: String(c.segment) } : null;
  }
  try { if (fs.statSync(jailedPath).isFile()) return { abs: jailedPath, local: String(coord) }; } catch { /* not a file */ }
  return null;
}

function makeToken(ctx, jailedPath, coord, abs) {
  const rel = (p) => path.relative(ctx.sandboxDir, p);
  const body = { p: rel(jailedPath), c: String(coord), f: rel(abs), h: fileHash(abs) };
  return Buffer.from(JSON.stringify(body)).toString('base64url');
}

function readToken(ctx, token) {
  try {
    const b = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    if (!b || ['p', 'c', 'f', 'h'].some((k) => typeof b[k] !== 'string')) return null;
    return { path: ctx.jailPath(b.p), coord: b.c, abs: ctx.jailPath(b.f), hash: b.h };
  } catch { return null; }
}

// ── Indentation ──────────────────────────────────────────────────────────────
// The engine stores a segment as: first line without its indent, later lines at
// their full depth. Models get that wrong, so reads show the whole block from
// column 0 and edits take it the same way; the depth is added back here.
function lineIndent(abs, lines) {
  const start = Number(String(lines || '').split('-')[0]);
  if (!start) return '';
  const line = fs.readFileSync(abs, 'utf8').split('\n')[start - 1] || '';
  return line.match(/^[ \t]*/)[0];
}

function toShown(text, indent) {
  if (!indent || typeof text !== 'string') return text;
  return text.split('\n').map((l, i) => (i > 0 && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n');
}

function toEngine(content, indent, insert = false) {
  const all = String(content).replace(/\r\n/g, '\n').split('\n');
  // Leading empty lines ask for blank lines above the code: set them aside.
  let k = 0;
  while (k < all.length - 1 && all[k].trim() === '') k++;
  let lines = all.slice(k);
  // Sent at its depth in the file (first line indented too): make it relative.
  const first = lines[0].match(/^[ \t]*/)[0];
  if (first) lines = lines.map((l) => (l.startsWith(first) ? l.slice(first.length) : l.replace(/^[ \t]+/, '')));
  const body = indent ? lines.map((l, i) => (i === 0 || l.trim() === '' ? l : indent + l)).join('\n') : lines.join('\n');
  if (!k) return body;
  // Insert: plain newlines; the engine turns them into clean blank lines in
  // front of the spacing it copies (which brings the first line's indent).
  // Replace keeps the segment's own spacing in front, so after the blank lines
  // the first code line needs its indent here.
  return '\n'.repeat(k) + (insert ? body : indent + body);
}

// ── What can be done with a segment ──────────────────────────────────────────
const isContainer = (s) => !!(s && (s.container || Array.isArray(s.tree) || Array.isArray(s.children)));

function isSegmentRead(o) {
  return !!o && typeof o === 'object' && typeof o.id === 'string' && o.address !== undefined
    && typeof o.lines === 'string' && (o.text !== undefined || o.labelled_code !== undefined)
    && o.kind !== 'gap' && o.kind !== 'whitespace';
}

function optionsFor(seg, local) {
  const opts = [];
  // replace on a container would only change its first line: edit a child.
  if (!isContainer(seg)) opts.push('replace');
  opts.push('insert_before', 'insert_after', 'delete', seg.kind === 'deactivated' ? 'activate' : 'deactivate');
  const more = [];
  if (!String(local).includes('.')) more.push('move_after', 'move_before');   // the engine moves top-level segments only
  more.push('paste');
  return { opts, more };
}

function addEditBlock(o, ctx, jailedPath, coord) {
  const loc = locate(jailedPath, coord);
  if (!loc) return o;
  let indent = '';
  try { indent = lineIndent(loc.abs, o.lines); } catch { indent = ''; }
  let token;
  try { token = makeToken(ctx, jailedPath, coord, loc.abs); } catch { return o; }
  const { opts, more } = optionsFor(o, loc.local);
  const out = { ...o };
  if (!isContainer(o) && typeof out.text === 'string') out.text = toShown(out.text, indent);
  // Extra actions, with what each one needs: only those this segment allows.
  const needs = more.map((m) => (m.startsWith('move_') ? `${m} (needs to="<address>")` : `${m} (needs from="<address>")`));
  out.edit = {
    token,
    options: opts,
    ...(needs.length ? { more: needs.join(', ') } : {}),
    content_rule: 'Write content from column 0, like text above; it is indented for you. Start with an empty line for a blank line above it.',
    next: exEdit(token, opts[0]),
    ...(isContainer(o) ? { note: 'This is a container. To change code inside it, read the child segment you need and edit that one.' } : {}),
  };
  return out;
}

function augmentRead(res, args, ctx) {
  const obj = parse(res);
  if (!obj) return res;
  const multi = Array.isArray(args.segment)
    || (typeof args.segment === 'string' && args.segment.includes(','));
  if (multi && Array.isArray(obj.segments)) {
    const list = Array.isArray(args.segment) ? args.segment : args.segment.split(',');
    const addrs = list.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
    if (addrs.length !== obj.segments.length) return res;
    obj.segments = obj.segments.map((s, i) => (isSegmentRead(s) ? addEditBlock(s, ctx, args.path, addrs[i]) : s));
    return wrap(obj);
  }
  return isSegmentRead(obj) ? wrap(addEditBlock(obj, ctx, args.path, args.segment)) : res;
}

// ── Errors that teach the right call ─────────────────────────────────────────
function oldParamError(args, ctx) {
  const key = OLD_EDIT_KEYS.find((k) => args[k] !== undefined && args[k] !== null && args[k] !== false);
  if (!key) return null;
  let target = args[key];
  if (key === 'insert') target = args.insert && Array.isArray(args.insert.between) ? args.insert.between[0] : null;
  else if (key === 'delete') target = Array.isArray(args.delete) ? args.delete[0] : args.delete;
  else if (key === 'move') target = args.move ? args.move.seg : null;
  else if (key === 'paste') target = args.paste ? args.paste.to : null;
  const action = OLD_TO_ACTION[key];
  return {
    error: `"${key}=" is no longer used, so nothing was changed. Editing takes two calls: read the segment, then edit it with the token from that read.`,
    example: [
      `1) ${exRead(shownPath(ctx, args.path), typeof target === 'string' ? target : '<coordinate>')}`,
      `2) ${exEdit('<edit.token from step 1>', action)}`,
    ],
  };
}

function strayEditFields(args, ctx) {
  if (args.edit !== undefined) return null;
  const stray = ['content', 'to', 'from'].filter((k) => args[k] !== undefined);
  const action = args.action !== undefined && args.action !== 'status' ? args.action : null;
  if (!stray.length && !action) return null;
  const act = action && EDIT_ACTIONS.includes(action) ? action : 'replace';
  return {
    error: `${[...stray, ...(action ? ['action'] : [])].join(', ')} given without edit, so nothing was changed. An edit needs the token from a read of that segment.`,
    example: [
      `1) ${exRead(shownPath(ctx, args.path), args.segment !== undefined && !Array.isArray(args.segment) ? args.segment : '<coordinate>')}`,
      `2) ${exEdit('<edit.token from step 1>', act)}`,
    ],
  };
}

// ── Step 2: the edit ─────────────────────────────────────────────────────────
// Neighbouring gap address (siblings step by 2, gaps sit in between); the
// engine steps off a gap anchor to the nearest real segment.
function neighbour(coord, d) {
  const parts = String(coord).split('.');
  const n = Number(parts.pop());
  if (!Number.isInteger(n) || n + d < 1) return null;
  return [...parts, String(n + d)].join('.');
}

async function runEdit(inner, args, ctx) {
  const action = typeof args.action === 'string' ? args.action : '';
  const tokenEx = (act) => exEdit(args.edit, act || 'replace');
  if (args.segment !== undefined || args.search !== undefined) {
    return { error: 'An edit call takes only edit, action and content (to/from for move/paste). Reading and editing are two separate calls, so nothing was changed.', example: tokenEx(action) };
  }
  const t = readToken(ctx, args.edit);
  if (!t) {
    return {
      error: 'This edit token is not valid, so nothing was changed. Copy edit.token exactly as the read returned it.',
      example: [`1) ${exRead('<project>', '<coordinate>')}`, `2) ${exEdit('<edit.token from step 1>', EDIT_ACTIONS.includes(action) ? action : 'replace')}`],
    };
  }
  const p = shownPath(ctx, t.path);
  if (!EDIT_ACTIONS.includes(action)) {
    return { error: `action must be one of the options from your read (${EDIT_ACTIONS.join(', ')}). Nothing was changed.`, example: tokenEx('replace') };
  }
  if (NEEDS_CONTENT.has(action) && typeof args.content !== 'string') {
    return { error: `${action} needs content: the new code, from column 0. Nothing was changed.`, example: tokenEx(action) };
  }
  if (!NEEDS_CONTENT.has(action) && args.content !== undefined) {
    return { error: `${action} takes no content. Nothing was changed. To change the code itself use action="replace".`, example: tokenEx(action) };
  }
  if (action.startsWith('move_') && typeof args.to !== 'string') {
    return { error: `${action} needs to="<address>": where to move the segment. Nothing was changed.`, example: tokenEx(action) };
  }
  if (action === 'paste' && typeof args.from !== 'string') {
    return { error: 'paste needs from="<address>": the segment to copy. Nothing was changed.', example: tokenEx(action) };
  }

  // Spent or out of date: hand back that address read again, with a new token.
  let current = null;
  try { current = fileHash(t.abs); } catch { current = null; }
  const loc = locate(t.path, t.coord);
  if (current === null) {
    return { error: 'The file of this token no longer exists. Nothing was changed.', example: exRead(p, '<coordinate>') };
  }
  if (current !== t.hash || !loc || loc.abs !== t.abs) {
    let fresh = parse(await inner.handler({ path: t.path, segment: t.coord }, ctx));
    if (isSegmentRead(fresh)) fresh = addEditBlock(fresh, ctx, t.path, t.coord);
    return {
      stale: true,
      nothing_saved: true,
      reason: 'The file changed after this token was made (every save uses up the tokens of that file). Below is the same address read again: check it is still the code you meant, then use its new edit.token.',
      current: fresh,
    };
  }

  // Read it now: this unlocks it in the engine, in this same request.
  const seg = parse(await inner.handler({ path: t.path, segment: t.coord }, ctx));
  if (!isSegmentRead(seg)) {
    return { error: 'The segment of this token could not be read again. Nothing was changed.', example: exRead(p, t.coord), detail: seg && seg.error ? seg.error : undefined };
  }
  const { opts, more } = optionsFor(seg, loc.local);
  if (![...opts, ...more].includes(action)) {
    return {
      error: `"${action}" is not possible on this segment. Possible: ${opts.join(', ')}; also ${more.join(', ')}. Nothing was changed.`,
      ...(isContainer(seg) && action === 'replace' ? { why: 'This is a container: replace would change only its first line. Read the child you want to change and edit that one.' } : {}),
      example: tokenEx(opts[0]),
    };
  }
  let indent = '';
  try { indent = lineIndent(t.abs, seg.lines); } catch { indent = ''; }
  const content = typeof args.content === 'string' ? toEngine(args.content, indent, action.startsWith('insert_')) : undefined;

  const call = { path: t.path };
  if (action === 'replace') { call.replace = t.coord; call.content = content; }
  else if (action === 'delete') call.delete = [t.coord];
  else if (action === 'deactivate') call.deactivate = t.coord;
  else if (action === 'activate') call.activate = t.coord;
  else if (action === 'move_after') call.move = { seg: t.coord, after: args.to };
  else if (action === 'move_before') call.move = { seg: t.coord, before: args.to };
  else if (action === 'paste') {
    await inner.handler({ path: t.path, segment: args.from }, ctx);   // the source must be shown too
    await inner.handler({ path: t.path, segment: t.coord }, ctx);
    call.paste = { from: args.from, to: t.coord };
  } else if (action === 'insert_before') call.insert = { between: [neighbour(t.coord, -1) || 'start', t.coord], content };
  else if (action === 'insert_after') call.insert = { between: [t.coord, neighbour(t.coord, 1) || 'end'], content };

  let res = await inner.handler(call, ctx);
  let out = parse(res);
  // No gap on that side (first or last child): anchor on start / end instead.
  if (call.insert && out && typeof out.error === 'string' && /No segment at address/.test(out.error)) {
    call.insert.between = action === 'insert_before' ? ['start', t.coord] : [t.coord, 'end'];
    res = await inner.handler(call, ctx);
    out = parse(res);
  }
  if (!out) return parse(res) || { error: 'The edit returned no answer.' };
  if (out.rejected) {
    out.next = `Nothing was saved and the file is unchanged, so this token still works. Fix the content and send it again: ${tokenEx(action)}`;
  } else if (out.saved) {
    out.next = `Saved. This token is now used up: read again before the next edit, e.g. ${exRead(p, '<address from now>')}`;
  } else if (out.error) {
    out.example = exRead(p, t.coord);
  }
  return out;
}

// ── Stop repeat failures ─────────────────────────────────────────────────────
const failures = new Map();   // sandbox -> { sig, count }

function guard(ctx, args, res) {
  const key = (ctx && ctx.sandboxDir) || '_';
  const obj = parse(res);
  const failed = !!obj && !!(obj.error || obj.rejected || obj.stale);
  if (!failed) { failures.delete(key); return res; }
  const sig = createHash('sha1').update(JSON.stringify(args)).digest('hex');
  const prev = failures.get(key);
  const count = prev && prev.sig === sig ? prev.count + 1 : 1;
  failures.set(key, { sig, count });
  if (count < REPEAT_LIMIT) return res;
  obj.stop = `This exact call has failed ${count} times in a row. Do not send it again: stop and tell the user what is going wrong.`;
  return wrap(obj);
}

// ── The tool the server sees ─────────────────────────────────────────────────
export const DESCRIPTION = 'Read code and edit it safely. read_file() lists your projects. ' +
  'EDITING TAKES TWO CALLS. 1) Read the segment: read_file(path="<project>", segment="<coordinate>"); the answer has edit.token and edit.options. ' +
  '2) read_file(edit="<that token>", action="<one option>", content="<new code>"). ' +
  'Write content from column 0, like the text you read; it is indented for you. One segment per edit. Every edit is checked and saved at once ' +
  '(a syntax error saves nothing and the token stays valid); after a save, read again before the next edit. ' +
  'Finding code: path=<project or folder> gives its structure with coordinates (e.g. "d.a.f"); segment="<file coordinate>" gives that file\'s map; ' +
  'segment="<file coordinate>.<segment>" (e.g. "d.a.f.31.17") gives that segment. search="<word>" on a file returns the lines containing it with their addresses. ' +
  'Several segments in one read: segment=["d.a.f.31.3","d.a.f.31.13"]. A big block lists its children: read the child you need. ' +
  '"[off] ..." is deactivated code. path=<file> works the same with plain segment numbers. ' +
  'undo=true reverts the project\'s last saved change, undo=<1-10> that many. trace=true: what a file connects to, or a project data-flow map.';

export function withEditFlow(inner) {
  const schema = { ...inner.schema };
  // The old address-based edit parameters are gone from the list entirely.
  // The schema object below is passthrough, so a model that still sends them
  // reaches oldParamError (a clear error with the right call) instead of the
  // SDK silently dropping them and turning the call into a plain read.
  for (const k of OLD_EDIT_KEYS) delete schema[k];
  schema.action = z.enum(['status', ...EDIT_ACTIONS]).optional()
    .describe('With edit: what to do with the segment, one of the edit.options from your read. Without edit: "status" lists open buffers.');
  schema.edit = z.string().optional()
    .describe('Step 2 of editing: the edit.token from your read of that segment. Send it with action (and content).');
  schema.content = z.string().optional()
    .describe('New code for replace, insert_before or insert_after, written from column 0 (it is indented for you).');
  schema.to = z.string().optional().describe('move_after / move_before: the address to move the segment next to.');
  schema.from = z.string().optional().describe('paste: the address of the segment to copy.');

  return {
    ...inner,
    description: DESCRIPTION,
    schema,
    inputSchema: z.object(schema).passthrough(),   // registered as given (server-sandbox.js loadTools)
    async handler(args, ctx) {
      const a = args || {};
      let res;
      const bad = oldParamError(a, ctx) || strayEditFields(a, ctx);
      if (bad) res = wrap(bad);
      else if (a.edit !== undefined) res = wrap(await runEdit(inner, a, ctx));
      else {
        res = await inner.handler(a, ctx);
        if (a.segment !== undefined && a.path !== undefined && a.search === undefined) res = augmentRead(res, a, ctx);
      }
      return guard(ctx, a, res);
    },
  };
}
