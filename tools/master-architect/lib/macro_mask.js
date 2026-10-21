// =============================================================================
// Macro-aware parsing for the C family (C, C++, CUDA/HIP, Metal, Objective-C)
// =============================================================================
// tree-sitter does not run the preprocessor, so real code full of project macros breaks
// the grammar wherever a macro stands for something that is not an expression:
//   TORCH_API bool f(...);             export / attribute macros before a declaration
//   CUTLASS_HOST_DEVICE                ... or alone on the line above it
//   struct TORCH_API X : Base {        ... or inside a class head
//   void f() __ubsan_ignore_x__ {      trailing attribute macros
//   C10_CLANG_DIAGNOSTIC_PUSH()        macro "statements" without a semicolon
//   HANDLE_TH_ERRORS                   bare macro statements
//   DELEGATE_OP(int8_t, cudaSum, +);   macro calls whose arguments are types / operators
//   if XNN_UNLIKELY(x) { ... }         macros that supply the parentheses themselves
//   _named_for_(i, 0, 20) { ... }      macros used like a for / with block
//   { 1, 2,\n#if X\n 3,\n#else ...     #if / #else inside an expression or initializer
// One error there also derails everything after it.
//
// How: parse; only when the tree has errors, look at the error lines for such macro uses,
// group them by macro name (one macro behaves the same everywhere in a file) and try, per
// group, blanking either the whole use or only the macro's name (each character -> a space,
// line breaks kept, so every offset and line number is unchanged). A group is kept only if
// the number of parse errors goes down; repeat while it helps. The tree then lines up with
// the original text exactly: segments are cut from the original, only the blanked macro
// uses are seen as whitespace by the parser. Code that parses cleanly is never touched.
// Results are cached by content, so reading and re-checking the same text parses once.
import { createHash } from 'crypto';

const MAX_ROUNDS = 6;
const MAX_CALL_CHARS = 4000;          // longest macro call (balanced parens) we blank
const CACHE_SIZE = 32;
const DBG = !!process.env.MACRO_MASK_DEBUG;

// ALL_CAPS (3+ chars, at least one letter) or __lowercase_dunder__
const MACRO_WORD = /^(?=[A-Z0-9_]*[A-Z])[A-Z_][A-Z0-9_]{2,}$|^__[a-z0-9_]+__$/;
const CLASS_KW = /\b(class|struct|union)\s*$/;
const C_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'do', 'else', 'case',
  'catch', 'decltype', 'alignof', 'static_assert', 'typeof', 'defined', 'new', 'delete', 'throw']);

export function countParseErrors(tree) {
  let n = 0;
  const walk = (node) => {
    if (node.type === 'ERROR' || node.isMissing) n++;
    if (node.hasError) for (const c of node.children) walk(c);
  };
  walk(tree.rootNode);
  return n;
}

// rows (0-based) worth looking at: the innermost error nodes' lines and the two lines above
// (a macro line without its semicolon is reported on the line after it)
function errorRows(tree, text, starts) {
  const errs = [];
  const walk = (node) => {
    if (node.type === 'ERROR' || node.isMissing) errs.push(node);
    if (node.hasError) for (const c of node.children) walk(c);
  };
  walk(tree.rootNode);
  errs.sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex);
  const rows = new Set();
  for (let i = 0; i < errs.length; i++) {
    const e = errs[i];
    const next = errs[i + 1];
    if (next && next.startIndex >= e.startIndex && next.endIndex <= e.endIndex) continue;   // has an error inside
    const r0 = e.startPosition.row;
    const r1 = Math.min(e.endPosition.row, r0 + 30) + 3;
    for (let r = Math.max(0, r0 - 2); r <= r1; r++) rows.add(r);
    // the previous code line (comments and blank lines skipped)
    let inBlock = false;
    for (let r = r0 - 1, k = 0; r >= 0 && k < 25; r--, k++) {
      const ln = text.slice(starts[r], r + 1 < starts.length ? starts[r + 1] - 1 : text.length).trim();
      if (inBlock) { if (ln.includes('/*')) inBlock = false; continue; }
      if (!ln || ln.startsWith('//')) continue;
      if (ln.endsWith('*/') && !ln.includes('/*')) { inBlock = true; continue; }
      if (ln.startsWith('*') || ln.startsWith('/*')) continue;
      rows.add(r);
      break;
    }
  }
  return rows;
}

// index just past the ')' matching the '(' at i, or -1 (skips literals and comments)
function matchParen(text, i) {
  let depth = 0;
  const end = Math.min(text.length, i + MAX_CALL_CHARS);
  for (let k = i; k < end; k++) {
    const ch = text[k];
    if (ch === '"' || ch === "'") {
      for (k++; k < end && text[k] !== ch && text[k] !== '\n'; k++) if (text[k] === '\\') k++;
      continue;
    }
    if (ch === '/' && text[k + 1] === '*') { const c = text.indexOf('*/', k + 2); if (c < 0) return -1; k = c + 1; continue; }
    if (ch === '/' && text[k + 1] === '/') { const c = text.indexOf('\n', k); if (c < 0) return -1; k = c; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return k + 1; }
  }
  return -1;
}

const isIdentStart = (ch) => /[A-Za-z_]/.test(ch || '');
function skipSpaces(text, i) { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; return i; }
const atLineEnd = (text, i) => i >= text.length || text[i] === '\n' || text[i] === '\r' ||
  text.startsWith('//', i) || text.startsWith('/*', i);

// #if ... #endif around row r (r is one of its directive lines): blank the directive lines
// and every branch after the first, keeping the first branch's code
function condCandidate(text, starts, r) {
  const lineAt = (k) => text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] - 1 : text.length);
  const dir = (k) => { const m = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/.exec(lineAt(k)); return m ? m[1] : null; };
  const d = dir(r);
  if (!d) return null;
  let open = r;
  if (d !== 'if' && d !== 'ifdef' && d !== 'ifndef') {           // find the opening #if
    let depth = 0;
    for (open = r - 1; open >= 0; open--) {
      const x = dir(open);
      if (x === 'endif') depth++;
      else if (x && x.startsWith('if')) { if (depth === 0) break; depth--; }
    }
    if (open < 0) return null;
  }
  const ranges = [];
  let depth = 0, firstBranch = true, branchStart = -1;
  const lineRange = (k) => [starts[k], k + 1 < starts.length ? starts[k + 1] - 1 : text.length];
  for (let k = open; k < starts.length && k < open + 5000; k++) {
    const x = dir(k);
    if (x && x.startsWith('if')) {
      depth++;
      if (depth === 1) { ranges.push(lineRange(k)); continue; }
    } else if (x === 'endif') {
      depth--;
      if (depth === 0) {
        if (!firstBranch && branchStart >= 0) ranges.push([starts[branchStart], lineRange(k - 1)[1]]);
        ranges.push(lineRange(k));
        // same condition text = same treatment (an #ifdef __cplusplus that opens extern "C" {
        // and the one that closes it); 'name' variant: blank the whole conditional
        const cond = lineAt(open).trim().replace(/\s+/g, ' ');
        const small = k - open <= 8;
        return { group: `#cond:${cond}`, kind: 'cond', full: ranges.filter(([a, b]) => b > a),
          ...(small ? { name: [[starts[open], lineRange(k)[1]]] } : {}) };
      }
    } else if ((x === 'elif' || x === 'else') && depth === 1) {
      if (!firstBranch && branchStart >= 0) ranges.push([starts[branchStart], lineRange(k - 1)[1]]);
      ranges.push(lineRange(k));
      firstBranch = false;
      branchStart = k + 1;
    }
  }
  return null;
}

// macro uses on one line (text[lineStart, lineEnd)):
//   [{ group, kind, full: [[start, end]], name?: [[start, end]] }]
function candidatesOnLine(text, lineStart, lineEnd) {
  const out = [];
  const line = text.slice(lineStart, lineEnd);
  if (/^\s*#/.test(line)) return out;               // directives: condCandidate's business
  // positions inside string / char literals or a // comment: not code
  const quoted = new Uint8Array(line.length);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') { quoted.fill(1, i); break; }
    if (ch === '"' || ch === "'") {
      let k = i + 1;
      while (k < line.length && line[k] !== ch) { if (line[k] === '\\') k++; k++; }
      quoted.fill(1, i, Math.min(k + 1, line.length));
      i = k;
    }
  }
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(line))) {
    if (quoted[m.index]) continue;
    const word = m[0];
    const s = lineStart + m.index;
    const e = s + word.length;
    let before = s - 1;
    while (before >= lineStart && (text[before] === ' ' || text[before] === '\t')) before--;
    const prev = before >= lineStart ? text[before] : '';
    if (prev === ':' || prev === '.' || prev === '>' || prev === '#' || prev === '~') continue;  // X::Y a.Y p->Y ## ~X
    const lineHead = line.slice(0, m.index).trim() === '';
    // just after a declarator: ')' or a trailing const / override / final / noexcept / volatile
    const prevWordM = /([A-Za-z_]\w*)\s*$/.exec(line.slice(0, m.index));
    const afterDeclarator = prev === ')' ||
      (prevWordM && ['const', 'override', 'final', 'noexcept', 'volatile'].includes(prevWordM[1]));
    const n = skipSpaces(text, e);
    const next = text[n];
    const isMacro = MACRO_WORD.test(word);
    if (next === '(') {
      const close = matchParen(text, n);
      if (close < 0) continue;
      re.lastIndex = Math.max(re.lastIndex, Math.min(close, lineEnd) - lineStart);
      let end = close;
      let after = skipSpaces(text, close);
      if (text[after] === ';' && lineHead) { end = after + 1; after = skipSpaces(text, after + 1); }
      const rest = text[after];
      if (isMacro) {
        // CAPS(...): a statement macro (alone on its line), an attribute macro with arguments
        // (a declaration continues after it), or a wrapper that supplies parentheses
        const c = { group: word, kind: 'call', full: [[s, end]], name: [[s, e]] };
        if ((lineHead && atLineEnd(text, after)) || isIdentStart(rest) || rest === '{' ||
            /\b(if|while)\s*$/.test(line.slice(0, m.index)) ||
            (afterDeclarator && ';{:='.includes(rest || '\0'))) out.push(c);
      } else if (lineHead && rest === '{' && !C_KEYWORDS.has(word)) {
        // name(args) { ... } at the start of a line: a block macro (for-like)
        out.push({ group: word, kind: 'call', full: [[s, close]] });
      } else if (lineHead && !C_KEYWORDS.has(word) && /[;{]/.test(text.slice(n + 1, close - 1))) {
        // name( ...code... ) at the start of a line: a macro that takes code as its argument
        out.push({ group: word, kind: 'call', full: [[s, end]] });
      }
      continue;
    }
    if (!isMacro) continue;
    // bare CAPS word
    if (CLASS_KW.test(text.slice(lineStart, s))) { out.push({ group: word, kind: 'word', full: [[s, e]] }); continue; }
    if (lineHead && atLineEnd(text, n)) { out.push({ group: word, kind: 'word', full: [[s, e]] }); continue; }   // alone on its line
    if (prev === '"' || next === '"') { out.push({ group: '#strmacro', kind: 'word', full: [[s, e]] }); continue; }
    if (afterDeclarator && ';{:='.includes(next || '\0')) { out.push({ group: word, kind: 'word', full: [[s, e]] }); continue; }
    if ((prev === '{' || prev === ';') && next === '}') { out.push({ group: word, kind: 'word', full: [[s, e]] }); continue; }  // "a" VERSION "b"
    if (!(isIdentStart(next) || next === '{')) continue;            // FOO *p, FOO;, FOO = ...: leave it
    if (isIdentStart(next)) {
      // "FOO x;" / "FOO x = 1" / "FOO x, y" / "FOO x[" / "FOO x)": FOO is a type there, leave it
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(n, n + 200))[0];
      const k = skipSpaces(text, n + id.length);
      if (';=,[)'.includes(text[k] || '\0')) continue;
    }
    out.push({ group: word, kind: 'word', full: [[s, e]] });
  }
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function blank(text, ranges) {
  if (!ranges.length) return text;
  const chars = text.split('');
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
  return chars.join('');
}

const _cache = new Map();            // key -> ranges (insertion order = age)
function cacheKey(parser, text) {
  const lang = parser.getLanguage ? parser.getLanguage() : null;
  const langId = lang && (lang.name || (lang.nodeTypeCount + ':' + lang.fieldCount)) || '';
  return createHash('sha1').update(String(langId)).update('\0').update(text).digest('hex');
}

// parser: a tree-sitter Parser with a C-family grammar set. Returns
// { tree, masked: [{start, end, text, group, kind}], errorsBefore, errorsAfter }
export function parseCFamily(parser, text) {
  const key = cacheKey(parser, text);
  const hit = _cache.get(key);
  if (hit) {
    const tree = parser.parse(hit.ranges.length ? blank(text, hit.ranges) : text);
    return { tree, masked: hit.masked, errorsBefore: hit.errorsBefore, errorsAfter: hit.errorsAfter };
  }
  let tree = parser.parse(text);
  const errorsBefore = countParseErrors(tree);
  let errors = errorsBefore;
  const kept = [];                     // accepted candidates (with the variant used)
  if (errors) {
    const starts = lineStarts(text);
    let cur = text;
    for (let round = 0; round < MAX_ROUNDS && errors > 0; round++) {
      const tried = new Set();         // `${start}|${variant}`, this round
      const groups = new Map();
      const rows = [...errorRows(tree, cur, starts)].sort((a, b) => a - b);
      if (round === 0) {
        // class-head macros anywhere: class GTEST_API_ TestResult {  /  struct TORCH_API X : Y
        const re = /^[ \t]*(?:template\s*<[^\n]*>\s*)?(?:class|struct|union)\s+([A-Z_][A-Z0-9_]{2,})\s+[A-Za-z_]/gm;
        let m;
        while ((m = re.exec(cur))) {
          const s0 = m.index + m[0].lastIndexOf(m[1]);
          const c = { group: m[1], kind: 'word', full: [[s0, s0 + m[1].length]] };
          if (!groups.has(c.group)) groups.set(c.group, new Map());
          groups.get(c.group).set(s0, c);
        }
        // CAPS macros alone on their line:  CUTLASS_HOST_DEVICE \n  Ctor(...) : a_(a) {
        const alone = /^[ \t]*((?=[A-Z0-9_]*[A-Z])[A-Z_][A-Z0-9_]{2,})[ \t]*$/gm;
        while ((m = alone.exec(cur))) {
          const s0 = m.index + m[0].indexOf(m[1]);
          const c = { group: m[1], kind: 'word', full: [[s0, s0 + m[1].length]] };
          if (!groups.has(c.group)) groups.set(c.group, new Map());
          groups.get(c.group).set(s0, c);
        }
      }
      for (const r of rows) {
        if (r >= starts.length) continue;
        const ls = starts[r];
        const le = r + 1 < starts.length ? starts[r + 1] - 1 : text.length;
        const cands = candidatesOnLine(cur, ls, le);
        const cc = condCandidate(cur, starts, r);
        if (cc) cands.push(cc);
        for (const c of cands) {
          const at = c.full[0][0];
          if (!groups.has(c.group)) groups.set(c.group, new Map());
          groups.get(c.group).set(at, c);
        }
      }
      // conditionals: every other #if in the file with the same condition text joins its group
      for (const [g, byStart] of groups) {
        if (!g.startsWith('#cond:')) continue;
        const want = g.slice(6);
        for (let r = 0; r < starts.length; r++) {
          const ln = cur.slice(starts[r], r + 1 < starts.length ? starts[r + 1] - 1 : cur.length).trim().replace(/\s+/g, ' ');
          if (ln !== want || byStart.has(starts[r])) continue;
          const cc = condCandidate(cur, starts, r);
          if (cc) byStart.set(cc.full[0][0], cc);
        }
      }
      let improved = false;
      const ordered = [...groups.entries()].sort((a, b) => b[1].size - a[1].size);
      if (DBG) console.error(`round ${round}: errors ${errors}, rows ${rows.length}, groups ${ordered.map(([g, m]) => g + 'x' + m.size).join(' ')}`);
      for (const [, byStart] of ordered) {
        let best = null;
        for (const variant of ['full', 'name']) {
          const use = [...byStart.values()].filter(c => c[variant] && !tried.has(`${c.full[0][0]}|${variant}`));
          if (!use.length) continue;
          for (const c of use) tried.add(`${c.full[0][0]}|${variant}`);
          const next = blank(cur, use.flatMap(c => c[variant]));
          const t2 = parser.parse(next);
          const e2 = countParseErrors(t2);
          if (DBG) console.error(`   try ${use[0].group} ${variant} x${use.length}: ${errors} -> ${e2}`);
          if (e2 < errors && (!best || e2 < best.e2)) best = { use, variant, next, t2, e2 };
          if (e2 === 0) break;
        }
        if (best) {
          for (const c of best.use) kept.push({ c, variant: best.variant });
          cur = best.next; tree = best.t2; errors = best.e2; improved = true;
        }
        if (!errors) break;
      }
      if (!improved && errors) {
        // nothing helped alone: all of them together, then all macro calls together
        const all = [...groups.values()].flatMap(m => [...m.values()]);
        const condName = (c) => (c.kind === 'cond' && c.name ? 'name' : 'full');
        const keptFull = kept.map(({ c }) => ({ c, variant: 'full' }));
        const tries = [
          [...keptFull, ...all.map(c => ({ c, variant: 'full' }))],
          [...keptFull, ...all.map(c => ({ c, variant: condName(c) }))],
          [...keptFull, ...all.filter(c => c.kind === 'call').map(c => ({ c, variant: 'full' }))],
        ];
        for (const set of tries) {
          if (set.length === keptFull.length) continue;
          const next = blank(text, set.flatMap(({ c, variant }) => c[variant]));
          const t2 = parser.parse(next);
          const e2 = countParseErrors(t2);
          if (DBG) console.error(`   fallback x${set.length}: ${errors} -> ${e2}`);
          if (e2 < errors) {
            kept.length = 0;
            const seen = new Set();
            for (const k of set) {
              const key = `${k.c.full[0][0]}|${k.variant}`;
              if (!seen.has(key)) { seen.add(key); kept.push(k); }
            }
            cur = next; tree = t2; errors = e2; improved = true;
            break;
          }
        }
      }
      if (!improved) break;
    }
  }
  const ranges = kept.flatMap(({ c, variant }) => c[variant]);
  const masked = kept.flatMap(({ c, variant }) => c[variant].map(([s, e]) =>
    ({ start: s, end: e, text: text.slice(s, e), group: c.group, kind: variant === 'name' ? 'name' : c.kind })))
    .sort((a, b) => a.start - b.start);
  _cache.set(key, { ranges, masked, errorsBefore, errorsAfter: errors });
  if (_cache.size > CACHE_SIZE) _cache.delete(_cache.keys().next().value);
  return { tree, masked, errorsBefore, errorsAfter: errors };
}
