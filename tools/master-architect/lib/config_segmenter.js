/**
 * Config-file segmenter — structure-aware segments for Linux / server configs.
 *
 * read_file treats code through tree-sitter; config files used to fall back to
 * a blank-line paragraph splitter that knew nothing about their structure.
 * This module recognises the common config families and splits along their
 * real structure, so a model (or admin) can address `location /mcp` inside a
 * `server` block, the `[Service]` section of a unit, `services.web` in a
 * compose file, and so on.
 *
 * Flavors:
 *   blocks     nginx, named.conf...             `name args { ... }` and `directive;`
 *   braces     logrotate and other brace configs whose statements end at the newline
 *   tags       Apache httpd                     `<VirtualHost *:443> ... </VirtualHost>`
 *   ini        systemd units, .ini, my.cnf, php.ini, gitconfig, TOML  `[section]`
 *   yaml       compose, Kubernetes, Ansible, CI
 *   json       package.json and friends
 *   ssh        sshd_config / ssh_config         `Host x` / `Match ...` blocks
 *   dockerfile Dockerfile / Containerfile       stages (FROM) -> instructions
 *   lines      fstab, hosts, sysctl, crontab, .env ...
 *
 * Invariant (what makes editing safe): segments cover the content exactly.
 * A parent's text is prefix (start -> first child) + children + suffix
 * (last child -> end); holes are filled with whitespace/gap segments at every
 * level, so joining the segments always reproduces the file byte for byte.
 */
import path from 'path';
import { spawn } from 'child_process';

const ETC_LINE_FILES = new Set(['fstab', 'hosts', 'crontab', 'sudoers', 'resolv.conf', 'sysctl.conf',
  'limits.conf', 'exports', 'environment', 'hostname', 'hosts.allow', 'hosts.deny', 'modules', 'crypttab']);
const INI_EXTS = new Set(['.service', '.timer', '.socket', '.mount', '.automount', '.target', '.path',
  '.slice', '.scope', '.network', '.netdev', '.link', '.desktop', '.repo', '.ini', '.cnf', '.toml']);

export const CONFIG_FLAVORS = ['blocks', 'braces', 'tags', 'ini', 'yaml', 'json', 'ssh', 'dockerfile', 'lines'];

export function detectConfigFlavor(filePath, content, language) {
  const p = String(filePath || '');
  const base = path.basename(p).toLowerCase();
  const ext = path.extname(base);
  if (/^(dockerfile|containerfile)(\..*)?$/.test(base) || ext === '.dockerfile') return 'dockerfile';
  if (ext === '.json' || language === 'json') return 'json';
  if (ext === '.yaml' || ext === '.yml' || language === 'yaml') return 'yaml';
  if (INI_EXTS.has(ext) || language === 'toml' || ['.gitconfig', 'gitconfig', '.editorconfig'].includes(base)) return 'ini';
  if (/^sshd?_config$/.test(base) || /\/\.ssh\/config$/.test(p) || /\/ssh\/sshd?_config\.d\//.test(p)) return 'ssh';
  if (base === '.env' || ext === '.env' || base.startsWith('.env.') || language === 'env') return 'lines';
  if (/\/nginx\//.test(p) || ext === '.nginx') return 'blocks';
  if (/\/logrotate\.d\//.test(p) || base === 'logrotate.conf') return 'braces';
  if (/\/(apache2|httpd)\//.test(p)) return 'tags';
  if (ETC_LINE_FILES.has(base) || /\/etc\/(sysctl\.d|security|cron\.d|sudoers\.d|modprobe\.d)\//.test(p)) return 'lines';
  if (ext === '.conf' || ext === '.cfg' || language === 'ini' || (language === 'plaintext' && p.startsWith('/etc/'))) {
    return sniffFlavor(content);
  }
  return null;
}

function sniffFlavor(content) {
  const c = String(content || '');
  if (/^\s*<([A-Za-z][\w]*)\b[^>]*>\s*$/m.test(c) && /^\s*<\/[A-Za-z]/m.test(c)) return 'tags';
  if (/\{\s*(#.*)?$/m.test(c) && /^\s*\}\s*;?\s*$/m.test(c)) {
    // nginx-style if most statement lines end with ';', else newline-terminated
    const stmts = c.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l && !/^[{}]$/.test(l) && !/\{$/.test(l));
    const semi = stmts.filter((l) => /;$/.test(l)).length;
    return semi * 2 >= stmts.length ? 'blocks' : 'braces';
  }
  if (/^\s*\[[^\]\n]+\]\s*$/m.test(c)) return 'ini';
  return 'lines';
}

// ── shared helpers ──────────────────────────────────────────────────────────

function lineIndex(content) {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return starts;
}

function makeCtx(content, freshId) {
  const starts = lineIndex(content);
  const lineOf = (off) => {           // 1-based line of a char offset
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const lines = content.split('\n').map((text, i) => ({ text, start: starts[i], end: starts[i] + text.length }));
  return { content, lines, lineOf, freshId };
}

function seg(ctx, kind, name, start, end, children) {
  const s = { id: ctx.freshId(), kind, name: String(name || '(unnamed)').slice(0, 80), startByte: start, endByte: end,
              startLine: ctx.lineOf(start), endLine: ctx.lineOf(Math.max(start, end - 1)) };
  if (children && children.length) s.children = children;
  return s;
}

// Fill holes between sorted segments within [from, to) with gap segments.
function cover(ctx, segs, from, to) {
  const out = [];
  let cur = from;
  const gap = (a, b) => {
    if (a >= b) return;
    const text = ctx.content.slice(a, b);
    out.push(seg(ctx, /^\s*$/.test(text) ? 'whitespace' : 'gap', '(blank)', a, b));
  };
  for (const s of segs.sort((x, y) => x.startByte - y.startByte)) {
    gap(cur, s.startByte);
    out.push(s);
    cur = s.endByte;
  }
  gap(cur, to);
  return out;
}

// A parent whose children cover [firstChild.start, lastChild.end) contiguously.
function parent(ctx, kind, name, start, end, kids) {
  if (!kids.length) return seg(ctx, kind, name, start, end);
  const first = kids.reduce((m, k) => Math.min(m, k.startByte), Infinity);
  const last = kids.reduce((m, k) => Math.max(m, k.endByte), -Infinity);
  return seg(ctx, kind, name, start, end, cover(ctx, kids, first, last));
}

const isBlank = (t) => /^\s*$/.test(t);
const isHashComment = (t) => /^\s*[#;]/.test(t);

// Leading comment lines directly above line i (no blank in between) belong to it.
function withLeadingComments(ctx, i, stopAt = 0, isComment = isHashComment) {
  let j = i;
  while (j - 1 >= stopAt && isComment(ctx.lines[j - 1].text) && !isBlank(ctx.lines[j - 1].text)) j--;
  return j;
}

// ── lines (fstab, hosts, sysctl, crontab, .env ...) ─────────────────────────
// Paragraphs (blank-line separated) with one child per entry line.
function segmentLines(ctx) {
  const out = [];
  const L = ctx.lines;
  let i = 0;
  while (i < L.length) {
    if (isBlank(L[i].text)) { i++; continue; }
    const pStart = i;
    while (i < L.length && !isBlank(L[i].text)) i++;
    const pEnd = i - 1;
    const kids = [];
    let k = pStart;
    while (k <= pEnd) {
      if (isHashComment(L[k].text)) { k++; continue; }
      const cStart = withLeadingComments(ctx, k, pStart);
      kids.push(seg(ctx, 'entry', entryName(L[k].text), L[cStart].start, L[k].end));
      k++;
    }
    // Name: a short comment heading ("# Logging") reads best; otherwise the
    // names of the entries the group actually contains.
    const header = L[pStart].text.trim();
    const heading = isHashComment(header) ? header.replace(/^[#;]+\s*/, '') : '';
    const entryNames = [...new Set(kids.map((k) => k.name))];
    const pname = heading && heading.length <= 40 ? heading
      : entryNames.length ? entryNames.slice(0, 4).join(', ')
      : (heading || '(comments)');
    out.push(kids.length > 1 ? parent(ctx, 'group', pname, L[pStart].start, L[pEnd].end, kids)
                             : seg(ctx, kids.length ? 'entry' : 'comment_block', pname, L[pStart].start, L[pEnd].end));
  }
  return cover(ctx, out, 0, ctx.content.length);
}

function entryName(text) {
  const t = text.trim();
  const kv = t.match(/^(?:export\s+)?([A-Za-z_][\w.\-]*)\s*[=:]/);
  if (kv) return kv[1];
  const f = t.split(/\s+/);
  if (f.length >= 2 && f[1].startsWith('/')) return `${f[1]} (${f[0]})`;   // fstab: mount point
  return t.slice(0, 60);
}

// ── ini / systemd / TOML ────────────────────────────────────────────────────
function segmentIni(ctx) {
  const L = ctx.lines;
  const isHeader = (t) => /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/.test(t);
  const headers = [];
  for (let i = 0; i < L.length; i++) if (isHeader(L[i].text)) headers.push(i);
  const out = [];
  const sectionBodies = [];
  if (!headers.length || headers[0] > 0) {
    const endLine = headers.length ? headers[0] : L.length;
    const firstHdrStart = headers.length ? withLeadingComments(ctx, headers[0]) : endLine;
    sectionBodies.push({ hdr: null, from: 0, to: firstHdrStart });
  }
  headers.forEach((h, n) => {
    const next = n + 1 < headers.length ? withLeadingComments(ctx, headers[n + 1]) : L.length;
    sectionBodies.push({ hdr: h, from: withLeadingComments(ctx, h), to: next });
  });
  for (const b of sectionBodies) {
    // trim trailing blank lines (they go into the gap)
    let to = b.to;
    while (to - 1 > b.from && isBlank(L[to - 1].text)) to--;
    let from = b.from;
    while (b.hdr === null && from < to && isBlank(L[from].text)) from++;
    if (from >= to) continue;
    const bodyStart = b.hdr === null ? from : b.hdr + 1;
    const kids = [];
    let i = bodyStart;
    while (i < to) {
      const t = L[i].text;
      if (isBlank(t) || isHashComment(t)) { i++; continue; }
      const cStart = withLeadingComments(ctx, i, bodyStart);
      let j = i;
      // continuation: trailing backslash (systemd) or an open TOML array/table
      let depth = (t.match(/[\[{]/g) || []).length - (t.match(/[\]}]/g) || []).length;
      while (j + 1 < to && (/\\\s*$/.test(L[j].text) || depth > 0)) {
        j++;
        depth += (L[j].text.match(/[\[{]/g) || []).length - (L[j].text.match(/[\]}]/g) || []).length;
      }
      const key = (t.match(/^\s*([^=:\s]+)\s*[=:]/) || [])[1] || t.trim().slice(0, 40);
      kids.push(seg(ctx, 'entry', key, L[cStart].start, L[j].end));
      i = j + 1;
    }
    const name = b.hdr === null ? '(top)' : L[b.hdr].text.trim().replace(/\s*#.*$/, '');
    out.push(parent(ctx, 'section', name, L[from].start, L[to - 1].end, kids));
  }
  return cover(ctx, out, 0, ctx.content.length);
}

// ── ssh (sshd_config / ssh_config) ──────────────────────────────────────────
function segmentSsh(ctx) {
  const L = ctx.lines;
  const isBlockStart = (t) => /^\s*(Host|Match)\s+\S/i.test(t);
  const out = [];
  const starts = [];
  for (let i = 0; i < L.length; i++) if (isBlockStart(L[i].text)) starts.push(i);
  const globalEnd = starts.length ? withLeadingComments(ctx, starts[0]) : L.length;
  // global part: paragraphs of directives
  const gctx = { ...ctx, lines: L.slice(0, globalEnd) };
  if (globalEnd > 0) out.push(...segmentLines(gctx).filter((s) => s.kind !== 'whitespace' && s.kind !== 'gap'));
  starts.forEach((h, n) => {
    const from = withLeadingComments(ctx, h);
    let to = n + 1 < starts.length ? withLeadingComments(ctx, starts[n + 1]) : L.length;
    while (to - 1 > h && isBlank(L[to - 1].text)) to--;
    const kids = [];
    for (let i = h + 1; i < to; i++) {
      if (isBlank(L[i].text) || isHashComment(L[i].text)) continue;
      const cStart = withLeadingComments(ctx, i, h + 1);
      kids.push(seg(ctx, 'directive', L[i].text.trim().split(/\s+/)[0], L[cStart].start, L[i].end));
    }
    out.push(parent(ctx, 'block', L[h].text.trim().replace(/\s+/g, ' '), L[from].start, L[to - 1].end, kids));
  });
  return cover(ctx, out, 0, ctx.content.length);
}

// ── dockerfile ──────────────────────────────────────────────────────────────
function segmentDockerfile(ctx) {
  const L = ctx.lines;
  const instrs = [];
  let i = 0;
  while (i < L.length) {
    const t = L[i].text;
    if (isBlank(t) || isHashComment(t)) { i++; continue; }
    const cStart = withLeadingComments(ctx, i);
    let j = i;
    while (j + 1 < L.length && /\\\s*$/.test(L[j].text)) j++;
    const kw = (t.trim().match(/^([A-Za-z]+)/) || [, '?'])[1].toUpperCase();
    instrs.push({ kw, first: i, from: cStart, to: j, name: t.trim().replace(/\s*\\\s*$/, '').replace(/\s+/g, ' ') });
    i = j + 1;
  }
  const out = [];
  let stage = null;
  const flush = () => {
    if (!stage) return;
    const kids = stage.items.map((x) => seg(ctx, 'instruction', x.name, L[x.from].start, L[x.to].end));
    out.push(parent(ctx, 'stage', stage.name, L[stage.from].start, L[stage.to].end, kids));
    stage = null;
  };
  for (const x of instrs) {
    if (x.kw === 'FROM') {
      flush();
      stage = { name: x.name, from: x.from, to: x.to, items: [] };
      // the FROM line itself is the stage's prefix: children start after it
    } else if (stage) {
      stage.items.push(x); stage.to = x.to;
    } else {
      out.push(seg(ctx, 'instruction', x.name, L[x.from].start, L[x.to].end));   // ARG before FROM
    }
  }
  flush();
  return cover(ctx, out, 0, ctx.content.length);
}

// ── yaml (indentation-based) ────────────────────────────────────────────────
function segmentYaml(ctx) {
  const L = ctx.lines;
  const ind = (t) => t.match(/^ */)[0].length;
  const isEntry = (t, n) => !isBlank(t) && !/^\s*#/.test(t) && ind(t) === n &&
    (/^\s*(-\s|-$)/.test(t) || /^\s*("[^"]*"|'[^']*'|[^\s#][^:#]*?)\s*:(\s|$)/.test(t));
  const keyName = (t) => {
    const m = t.trim().match(/^-\s*([^:#]+?)\s*:\s*(.*)$/) || t.trim().match(/^("[^"]*"|'[^']*'|[^:#]+?)\s*:/);
    if (/^\s*-/.test(t)) return m && m[1] ? (m[1] === 'name' ? String(m[2]).trim() : `- ${m[1]}`) : t.trim().slice(0, 50);
    return m ? m[1].replace(/^["']|["']$/g, '') : t.trim().slice(0, 50);
  };
  function level(from, to, indent, prefix) {
    const entries = [];
    for (let i = from; i < to; i++) {
      const t = L[i].text;
      if (/^---/.test(t) && indent === 0) { entries.push({ i, doc: true }); continue; }
      if (isEntry(t, indent)) entries.push({ i });
    }
    const out = [];
    entries.forEach((e, n) => {
      if (e.doc) { out.push(seg(ctx, 'document', '---', L[e.i].start, L[e.i].end)); return; }
      const sStart = withLeadingComments(ctx, e.i, from, (x) => /^\s*#/.test(x));
      let end = n + 1 < entries.length ? withLeadingComments(ctx, entries[n + 1].i, from, (x) => /^\s*#/.test(x)) : to;
      while (end - 1 > e.i && (isBlank(L[end - 1].text) || (/^\s*#/.test(L[end - 1].text) && ind(L[end - 1].text) <= indent))) end--;
      const name = (prefix ? prefix + '.' : '') + keyName(L[e.i].text);
      // nested level: first deeper non-blank, non-comment line
      let kids = [];
      let k = e.i + 1;
      while (k < end && (isBlank(L[k].text) || /^\s*#/.test(L[k].text))) k++;
      const childIndent = k < end ? ind(L[k].text) : -1;
      if (childIndent > indent && prefix.split('.').length < 2) kids = level(e.i + 1, end, childIndent, name).filter((s) => s.kind !== 'whitespace' && s.kind !== 'gap');
      out.push(parent(ctx, /^\s*-/.test(L[e.i].text) ? 'item' : 'mapping', name, L[sStart].start, L[end - 1].end, kids));
    });
    return out;
  }
  return cover(ctx, level(0, L.length, 0, ''), 0, ctx.content.length);
}

// ── json ────────────────────────────────────────────────────────────────────
function segmentJson(ctx) {
  const c = ctx.content;
  let i = 0;
  const ws = () => { while (i < c.length && /\s/.test(c[i])) i++; };
  const str = () => { const s = i; i++; while (i < c.length && c[i] !== '"') { if (c[i] === '\\') i++; i++; } i++; return c.slice(s + 1, i - 1); };
  function skipValue() {
    ws();
    if (c[i] === '"') { str(); return; }
    if (c[i] === '{' || c[i] === '[') {
      let depth = 0;
      while (i < c.length) {
        if (c[i] === '"') { str(); continue; }
        if (c[i] === '{' || c[i] === '[') depth++;
        else if (c[i] === '}' || c[i] === ']') { depth--; if (depth === 0) { i++; return; } }
        i++;
      }
      return;
    }
    while (i < c.length && !/[,}\]\s]/.test(c[i])) i++;
  }
  // members of the object/array starting at c[open]; returns segments
  function members(open, prefix, depth) {
    const out = [];
    const isObj = c[open] === '{';
    i = open + 1;
    let idx = 0;
    for (;;) {
      ws();
      if (i >= c.length || c[i] === '}' || c[i] === ']') break;
      const start = i;
      let name;
      if (isObj) { name = str(); ws(); i++; /* : */ ws(); } else { name = `[${idx}]`; }
      const valStart = i;
      skipValue();
      const end = i;
      const full = (prefix ? prefix + '.' : '') + name;
      let kids = [];
      if (depth < 2 && (c[valStart] === '{' || c[valStart] === '[')) {
        const save = i;
        kids = members(valStart, full, depth + 1);
        i = save;
      }
      out.push(parent(ctx, isObj ? 'member' : 'element', full, start, end, kids));
      ws();
      if (c[i] === ',') i++;
      idx++;
    }
    return out;
  }
  let top = [];
  ws();
  if (c[i] === '{' || c[i] === '[') {
    const open = i;
    const kids = members(open, '', 1);
    // closing bracket
    i = open; skipValue();
    top = [parent(ctx, c[open] === '{' ? 'object' : 'array', '(root)', open, i, kids)];
  }
  return cover(ctx, top, 0, c.length);
}

// ── blocks (nginx-style) ────────────────────────────────────────────────────
// Statements end with `;` or open a block with `{ ... }`. Quotes and `#`
// comments are respected. Consecutive simple directives (no blank line
// between) are grouped into one segment; blocks get their own segment with
// nested children.
function segmentBlocks(ctx, out_errors, newlineTerminated = false) {
  const c = ctx.content;
  let i = 0;
  function skipWsAndComments(stopAtNewlineGroups) {
    while (i < c.length) {
      if (/\s/.test(c[i])) { i++; continue; }
      if (c[i] === '#') { while (i < c.length && c[i] !== '\n') i++; continue; }
      break;
    }
  }
  // parse statements until '}' (depth>0) or EOF; returns list of nodes
  function parseList(depth) {
    const nodes = [];
    for (;;) {
      skipWsAndComments();
      if (i >= c.length) { if (depth > 0) out_errors.push('unclosed block: missing "}"'); break; }
      if (c[i] === '}') { if (depth === 0) { out_errors.push(`unexpected "}" at line ${ctx.lineOf(i)}`); i++; continue; } break; }
      const start = i;
      let quote = null;
      while (i < c.length) {
        const ch = c[i];
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; i++; continue; }
        if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
        if (ch === '#') { while (i < c.length && c[i] !== '\n') i++; continue; }
        if (ch === ';' || ch === '{' || ch === '}') break;
        if (newlineTerminated && ch === '\n') break;
        i++;
      }
      if (i >= c.length) {
        const end = start + c.slice(start).trimEnd().length;
        if (!newlineTerminated) out_errors.push(`unterminated statement at line ${ctx.lineOf(start)} (missing ";")`);
        nodes.push({ type: 'directive', start, end, header: c.slice(start, end).trim() }); break;
      }
      if (c[i] === ';') { i++; nodes.push({ type: 'directive', start, end: i, header: c.slice(start, i - 1).trim() }); continue; }
      if (newlineTerminated && c[i] === '\n') { const end = start + c.slice(start, i).trimEnd().length; nodes.push({ type: 'directive', start, end, header: c.slice(start, end).trim() }); continue; }
      if (c[i] === '}') {   // statement without ';' before a closing brace
        nodes.push({ type: 'directive', start, end: i, header: c.slice(start, i).trim() });
        if (depth > 0 && !newlineTerminated) out_errors.push(`missing ";" at line ${ctx.lineOf(start)}`);
        continue;
      }
      // block
      const header = c.slice(start, i).trim();
      i++;   // {
      const kids = parseList(depth + 1);
      if (c[i] === '}') i++;
      nodes.push({ type: 'block', start, end: i, header, kids });
    }
    return nodes;
  }
  const tree = parseList(0);

  const lineStartOf = (off) => c.lastIndexOf('\n', off - 1) + 1;
  // attach leading comment lines (directly above, no blank line) to a node
  function leading(start, floor) {
    let s = lineStartOf(start);
    if (c.slice(s, start).trim()) return start;   // something else on the same line
    for (;;) {
      if (s <= floor) break;
      const prevEnd = s - 1;
      const prevStart = lineStartOf(prevEnd);
      const prev = c.slice(prevStart, prevEnd);
      if (/^\s*#/.test(prev) && prevStart >= floor) { s = prevStart; continue; }
      break;
    }
    return s < start && /^\s*#/.test(c.slice(s, start)) ? s : start;
  }
  function blockName(n) {
    const words = n.header.replace(/\s+/g, ' ');
    if (/^server$/.test(words) && n.kids) {
      const find = (k) => (n.kids.find((x) => x.type === 'directive' && x.header.split(/\s+/)[0] === k) || {}).header;
      const sn = find('server_name'); const ls = find('listen');
      return ['server', sn ? sn.replace(/^server_name\s+/, '') : '', ls ? `(listen ${ls.replace(/^listen\s+/, '')})` : ''].filter(Boolean).join(' ');
    }
    return words;
  }
  function build(nodes, floor) {
    const segs = [];
    let group = [];
    let prevEnd = floor;
    const flushGroup = () => {
      if (!group.length) return;
      const names = [...new Set(group.map((g) => g.header.split(/\s+/)[0]))];
      const gStart = leading(group[0].start, floor);
      const gEnd = group[group.length - 1].end;
      if (group.length === 1) segs.push(seg(ctx, 'directive', group[0].header.replace(/\s+/g, ' '), gStart, gEnd));
      else {
        const kids = group.map((g, n) => seg(ctx, 'directive', g.header.replace(/\s+/g, ' '), n === 0 ? gStart : leading(g.start, group[n - 1].end), g.end));
        segs.push(parent(ctx, 'directives', names.join(', ').slice(0, 70), gStart, gEnd, kids));
      }
      group = [];
    };
    for (const n of nodes) {
      const between = c.slice(prevEnd, n.start);
      const blankLine = /\n[ \t]*\n/.test(between.replace(/#[^\n]*/g, ''));
      if (n.type === 'directive') {
        if (blankLine) flushGroup();
        group.push(n);
      } else {
        flushGroup();
        const s = leading(n.start, prevEnd);
        const kids = build(n.kids || [], n.start + n.header.length + 1);
        segs.push(parent(ctx, 'block', blockName(n), s, n.end, kids));
      }
      prevEnd = n.end;
    }
    flushGroup();
    return segs;
  }
  return cover(ctx, build(tree, 0), 0, c.length);
}

// ── tags (Apache) ───────────────────────────────────────────────────────────
function segmentTags(ctx, out_errors) {
  const L = ctx.lines;
  const openRe = /^\s*<([A-Za-z][\w]*)\b([^>]*)>\s*$/;
  const closeRe = /^\s*<\/([A-Za-z][\w]*)\s*>\s*$/;
  function parse(from, to, closingTag) {
    const nodes = [];
    let i = from;
    while (i < to) {
      const t = L[i].text;
      const cm = t.match(closeRe);
      if (cm) {
        if (closingTag && cm[1].toLowerCase() === closingTag.toLowerCase()) return { nodes, end: i };
        out_errors.push(`unexpected </${cm[1]}> at line ${i + 1}`); i++; continue;
      }
      const om = t.match(openRe);
      if (om) {
        const inner = parse(i + 1, to, om[1]);
        if (inner.end === null) { out_errors.push(`<${om[1]}> opened at line ${i + 1} is never closed`); nodes.push({ type: 'tag', first: i, last: to - 1, name: `${om[1]}${om[2]}`.trim(), kids: inner.nodes }); i = to; continue; }
        nodes.push({ type: 'tag', first: i, last: inner.end, name: `${om[1]}${om[2]}`.trim().replace(/\s+/g, ' '), kids: inner.nodes });
        i = inner.end + 1; continue;
      }
      if (!isBlank(t) && !isHashComment(t)) nodes.push({ type: 'directive', first: i, last: i, name: t.trim().split(/\s+/)[0] });
      i++;
    }
    return { nodes, end: closingTag ? null : to };
  }
  function build(nodes, floorLine) {
    const segs = [];
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const kids = group.map((g, n) => seg(ctx, 'directive', L[g.first].text.trim().replace(/\s+/g, ' '),
        L[withLeadingComments(ctx, g.first, n === 0 ? floorLine : group[n - 1].last + 1)].start, L[g.last].end));
      if (kids.length === 1) segs.push(kids[0]);
      else segs.push(parent(ctx, 'directives', [...new Set(group.map((g) => g.name))].join(', ').slice(0, 70), kids[0].startByte, kids[kids.length - 1].endByte, kids));
      group = [];
    };
    let prevLast = floorLine - 1;
    for (const n of nodes) {
      const gapHasBlank = L.slice(prevLast + 1, n.first).some((x) => isBlank(x.text));
      if (n.type === 'directive') { if (gapHasBlank) flush(); group.push(n); }
      else {
        flush();
        const from = withLeadingComments(ctx, n.first, prevLast + 1);
        const kids = build(n.kids, n.first + 1);
        segs.push(parent(ctx, 'block', n.name, L[from].start, L[n.last].end, kids));
      }
      prevLast = n.last;
    }
    flush();
    return segs;
  }
  return cover(ctx, build(parse(0, L.length, null).nodes, 0), 0, ctx.content.length);
}

// ── entry point ─────────────────────────────────────────────────────────────
export function segmentConfig(content, flavor, freshId) {
  let n = 0;
  const ctx = makeCtx(String(content), freshId || (() => `cfg_${++n}`));
  const errors = [];
  let segments;
  switch (flavor) {
    case 'blocks': segments = segmentBlocks(ctx, errors); break;
    case 'braces': segments = segmentBlocks(ctx, errors, true); break;
    case 'tags': segments = segmentTags(ctx, errors); break;
    case 'ini': segments = segmentIni(ctx); break;
    case 'yaml': segments = segmentYaml(ctx); break;
    case 'json': segments = segmentJson(ctx); break;
    case 'ssh': segments = segmentSsh(ctx); break;
    case 'dockerfile': segments = segmentDockerfile(ctx); break;
    default: segments = segmentLines(ctx);
  }
  return { segments, hasParseErrors: errors.length > 0, structureErrors: errors, flavor };
}

// Rebuild the text from segments exactly as read_file's buffer does
// (prefix + children + suffix). Used by tests to prove the invariant.
export function assembleFromSegments(content, segments) {
  const parts = [];
  const emit = (s) => {
    if (s.children && s.children.length) {
      parts.push(content.slice(s.startByte, s.children[0].startByte));
      s.children.forEach(emit);
      parts.push(content.slice(s.children[s.children.length - 1].endByte, s.endByte));
    } else parts.push(content.slice(s.startByte, s.endByte));
  };
  segments.forEach(emit);
  return parts.join('');
}

// ── syntax checks (read_file verify, level 1) ───────────────────────────────
const FLAVOR_LABEL = { blocks: 'nginx-style config', braces: 'brace config', tags: 'Apache config', ini: 'INI config',
  yaml: 'YAML', json: 'JSON', ssh: 'ssh config', dockerfile: 'Dockerfile', lines: 'line config' };

function runPython(code, input) {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try { p = spawn('python3', ['-c', code], { stdio: ['pipe', 'ignore', 'pipe'] }); } catch (e) { return resolve({ code: -1, err: e.message }); }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 15000);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, err: err.trim() }); });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// Parse-only checks: YAML uses safe_load (no object construction), TOML and
// JSON use the standard parsers. Brace/tag/INI configs are checked for
// structure. Returns { ok, messages } in read_file's verify format.
export async function checkConfigSyntax(content, flavor, filePath) {
  const label = FLAVOR_LABEL[flavor] || flavor;
  const okMsg = (how) => ({ ok: true, messages: [`L1 ${label}: OK (${how})`] });
  const fail = (msg) => ({ ok: false, messages: [`L1 ${label}: ${msg}`] });
  if (flavor === 'json') {
    try { JSON.parse(content); return okMsg('parsed'); } catch (e) { return fail(e.message); }
  }
  if (flavor === 'yaml') {
    const r = await runPython('import sys, yaml\ntry:\n    list(yaml.safe_load_all(sys.stdin))\nexcept Exception as e:\n    sys.stderr.write(str(e)); sys.exit(1)', content);
    if (r.code === 0) return okMsg('parsed with PyYAML');
    if (/No module named/.test(r.err)) return okMsg('structure only; PyYAML not installed');
    return fail(r.err.replace(/<unicode string>|<file>|<stdin>/g, "file"));
  }
  if (flavor === 'ini' && /\.toml$/i.test(filePath || '')) {
    const r = await runPython('import sys, tomllib\ntry:\n    tomllib.loads(sys.stdin.read())\nexcept Exception as e:\n    sys.stderr.write(str(e)); sys.exit(1)', content);
    if (r.code === 0) return okMsg('parsed with tomllib');
    if (/No module named/.test(r.err)) return okMsg('structure only; tomllib unavailable');
    return fail(r.err);
  }
  if (flavor === 'blocks' || flavor === 'braces' || flavor === 'tags') {
    const r = segmentConfig(content, flavor);
    return r.structureErrors.length ? fail(r.structureErrors.join('; ')) : okMsg('structure');
  }
  if (flavor === 'ini') {
    const bad = String(content).split('\n').map((t, n) => ({ t, n: n + 1 }))
      .filter(({ t }) => /^\s*\[/.test(t) && !/^\s*\[\[?[^\]]+\]\]?\s*([#;].*)?$/.test(t));
    return bad.length ? fail(bad.map((b) => `malformed section header at line ${b.n}: ${b.t.trim()}`).join('; ')) : okMsg('structure');
  }
  return okMsg('structure');
}
