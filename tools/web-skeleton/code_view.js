// Code snippets on web pages, shown the way read_file shows a file.
//
// In the page map a code block is ONE line: its language, a title (its first
// definition, or its first line) and its size. read on the block ("e12") gives
// its map: the parts read_file's segmenter finds (imports, functions, classes
// ...), numbered e12.1, e12.2 ... read on a part ("e12.3") gives its code; a
// part that holds others (a class) shows its opening line(s) and its own parts
// (e12.3.1 ...), so a model always drills down instead of getting all the code.

import { createHash } from 'node:crypto';
import { segmentFile, getParser } from '../master-architect/lib/segmenter.js';
import { countParseErrors } from '../master-architect/lib/macro_mask.js';

// Page class hints ("language-py", "hljs bash", "highlight-source-c++", Sphinx "highlight-python") → segmenter language.
const HINTS = {
  py: 'python', python: 'python', python3: 'python', py3: 'python', ipython: 'python', default: 'python',
  js: 'javascript', javascript: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', typescript: 'typescript', tsx: 'typescript',
  c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', csharp: 'csharp', 'c#': 'csharp',
  go: 'go', golang: 'go', rs: 'rust', rust: 'rust', java: 'java', kt: 'kotlin', kotlin: 'kotlin',
  php: 'php', rb: 'ruby', ruby: 'ruby', swift: 'swift',
  sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', shellsession: 'shell',
  css: 'css', scss: 'css', html: 'html', xml: 'html', vue: 'html', svelte: 'html',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown', markdown: 'markdown',
  text: 'plaintext', txt: 'plaintext', plaintext: 'plaintext', plain: 'plaintext', none: 'plaintext',
  // interactive sessions and tracebacks (">>> ", "$ " prompts mixed with output): shown as text
  pycon: 'plaintext', 'python-repl': 'plaintext', pytb: 'plaintext', doscon: 'plaintext',
};
const EXT = {
  python: '.py', javascript: '.js', typescript: '.ts', c: '.c', cpp: '.cpp', csharp: '.cs', go: '.go',
  rust: '.rs', java: '.java', kotlin: '.kt', php: '.php', ruby: '.rb', swift: '.swift', shell: '.sh',
  css: '.css', html: '.html', json: '.json', yaml: '.yaml', toml: '.toml', markdown: '.md', plaintext: '.txt',
};
// Languages tried, in order, when the page gives no hint. A snippet that parses
// cleanly in several grammars gets the first: the stricter, more distinctive
// grammars (Rust, Go) come before the forgiving C family, and the very
// forgiving ones (Kotlin, Swift) after it.
const TRY_ORDER = ['python', 'javascript', 'typescript', 'rust', 'go', 'cpp', 'c', 'java', 'csharp',
  'kotlin', 'swift', 'php', 'ruby', 'shell', 'css', 'html'];
// Unmistakable signs of a language: those languages are tried first.
const SIGNS = [
  ['csharp', /\busing\s+System\b|\bConsole\.\w+\(|\bnamespace\s+[\w.]+\s*[{;]/],
  ['java', /\bSystem\.out\.|\bimport\s+java\.|\bpublic\s+static\s+void\s+main\s*\(\s*String/],
  ['cpp', /#include\s*<(iostream|vector|string|memory|map)>|\bstd::|\bcout\s*<</],
  ['c', /#include\s*[<"]|\bint\s+main\s*\(|\bprintf\s*\(|\bmalloc\s*\(/],
  ['kotlin', /\bfun\s+\w+\s*\(|\bval\s+\w+\s*[:=]/],
  ['swift', /\bimport\s+(UIKit|SwiftUI|Foundation)\b|\bfunc\s+\w+\s*\([^)]*\)\s*->/],
];
const MAX_DETECT_BYTES = 200 * 1024;

// Command lines: "$ npm install x", "pip install y", "git clone ..." — several
// grammars accept these as code, so they are recognised before parsing.
const SHELL_LINE = /^\s*(?:\$\s|(?:sudo|npm|npx|yarn|pnpm|pip3?|python3?\s+-m|git|cd|ls|mkdir|rm|cp|mv|cat|echo|export|source|curl|wget|apt(?:-get)?|brew|docker|kubectl|make|cmake|cargo|go\s+(?:get|run|build|install|mod)|node|deno|bun|chmod|chown|tar|unzip|ssh|scp|systemctl|journalctl)\b)/;
function looksLikeShell(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return false;
  const hits = lines.filter((l) => SHELL_LINE.test(l)).length;
  return hits / lines.length >= 0.5;
}

// The language of a snippet: the page's hint when it names one we know,
// otherwise the grammar that parses it with the fewest errors (or plain text).
// Some grammars read almost any text without errors, so they are only tried
// when the snippet shows their signs: PHP and HTML need their tags, shell
// needs shell syntax (bash takes any words as commands, prose included).
const SHELL_SIGNS = /^#!|\$\{?\w|\b(then|fi|done|esac)\b|\s\|\s|&&|^\s*[A-Za-z_]\w*=\S/m;
export function detectCodeLanguage(text, hint = '') {
  const h = String(hint || '').toLowerCase().replace(/^(language-|lang-)/, '');
  if (h && HINTS[h]) return HINTS[h];
  if (!text || !text.trim() || text.length > MAX_DETECT_BYTES) return 'plaintext';
  if (looksLikeShell(text)) return 'shell';
  const lines = text.split('\n').filter((l) => l.trim()).length;
  const hasPhpTag = /<\?(php|=)/.test(text);
  const hasHtmlTag = /<\/?[a-zA-Z][\w-]*[\s>\/]|<!DOCTYPE/i.test(text);
  const hasShellSigns = SHELL_SIGNS.test(text);
  // Languages whose unmistakable signs the snippet shows are tried first.
  const signed = SIGNS.filter(([, re]) => re.test(text)).map(([lang]) => lang);
  const order = [...signed, ...TRY_ORDER.filter((l) => !signed.includes(l))];
  let best = null;
  for (const lang of order) {
    if (lang === 'php' && !hasPhpTag) continue;
    if (lang === 'html' && !hasHtmlTag) continue;
    if (lang === 'shell' && !hasShellSigns) continue;
    const parser = getParser(lang);
    if (!parser) continue;
    let errors;
    try { errors = countParseErrors(parser.parse(text)); } catch { continue; }
    if (!best || errors < best.errors) best = { lang, errors };
    if (errors === 0) break;
  }
  // A short snippet must parse cleanly; a longer one may carry a few errors
  // (fragments, "..." placeholders), one per ten lines.
  const allowed = lines < 5 ? 0 : Math.floor(lines / 10);
  if (!best || best.errors > allowed) return 'plaintext';
  return best.lang;
}

const KIND_WORDS = [
  [/^(function|method|func|arrow_function|generator_function)/, 'function'],
  [/^(class|struct|interface|enum|trait|impl|object|protocol|record|union)/, (k) => k.split('_')[0]],
  [/^(import|use_declaration|using|include|preproc_include|require)/, 'import'],
  [/^comment/, 'comment'],
  [/^(lexical_declaration|variable_declaration|var_declaration|const_declaration|short_var_declaration|assignment|let_declaration)/, 'variable'],
  [/^(expression_statement|expression|call|command|pipeline|text|paragraph|block)/, ''],   // shown by its first line
];
function kindWord(kind) {
  for (const [re, word] of KIND_WORDS) if (re.test(kind)) return typeof word === 'function' ? word(kind) : word;
  return String(kind || 'code').replace(/_(statement|declaration|definition|item|expression)$/, '').replace(/_/g, ' ');
}
const realName = (name) => (name && !/^\(.*\)$/.test(name) ? name : '');
const lineRange = (s) => (s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}-${s.endLine}`);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Parts of a segment list, whitespace left out, numbered from 1.
function parts(segs) {
  return (segs || []).filter((s) => s.kind !== 'whitespace' && s.kind !== 'gap');
}

const _outlines = new Map();   // hash → outline (small LRU)
const OUTLINE_CACHE = 200;

// The snippet's language, size, title and part tree (memoised by content).
export async function codeOutline(text, hint = '') {
  const lang = detectCodeLanguage(text, hint);
  const key = createHash('sha1').update(lang + '\0' + text).digest('hex');
  if (_outlines.has(key)) return _outlines.get(key);
  let segs = [];
  try {
    const r = await segmentFile(`/snippet${EXT[lang] || '.txt'}`, text, lang);
    segs = r.segments || [];
  } catch { segs = []; }
  const srcLines = text.split('\n');
  const firstLine = (s) => cut((srcLines.slice(s.startLine - 1, s.endLine).find((l) => l.trim()) || '').trim(), 70);
  // "function load_model", "class Cache", "variable app"; statements and
  // plain text are shown by their first line.
  const label = (s) => {
    const word = kindWord(s.kind);
    if (!word) return firstLine(s);
    const name = realName(String(s.name || '').replace(/\s+/g, ' ').trim());
    return name ? `${word} ${name}` : `${word}: ${firstLine(s)}`;
  };
  const top = parts(segs);
  const main = top.find((s) => !/^(import|comment)$/.test(kindWord(s.kind)));
  const title = main ? cut(label(main), 70) : cut((srcLines.find((l) => l.trim()) || '').trim(), 70);
  const outline = { lang, lines: srcLines.length, title, segs, srcLines, label };
  _outlines.set(key, outline);
  if (_outlines.size > OUTLINE_CACHE) _outlines.delete(_outlines.keys().next().value);
  return outline;
}

// Give every code element of a freshly read page its language, size and title
// (stored with the page, so the map can show them without parsing again).
export async function annotateCode(data) {
  for (const el of data.elements || []) {
    if (el.kind !== 'code') continue;
    try {
      const o = await codeOutline(data.sections?.[el.id] || '', el.label || '');
      el.lang = o.lang; el.lines = o.lines; el.codeTitle = o.title;
    } catch { /* a snippet that cannot be outlined stays a plain code line */ }
  }
}

// "e12" → { elementId: 'e12', path: [] }; "e12.3.1" → { elementId: 'e12', path: [3, 1] }
export function parseCodeAddress(id) {
  const m = /^(e\d+)((?:\.\d+)*)$/.exec(String(id || '').trim());
  if (!m) return null;
  return { elementId: m[1], path: m[2] ? m[2].slice(1).split('.').map(Number) : [] };
}

function listParts(prefix, segs, label, out) {
  const ps = parts(segs);
  for (let i = 0; i < ps.length; i++) {
    const s = ps[i];
    const inner = parts(s.children).length;
    out.push(`  ${prefix}.${i + 1}  ${cut(label(s), 80)} (${lineRange(s)})${inner ? ` · ${inner} parts` : ''}`);
  }
  return ps.length;
}

// Snippets this short are shown whole: their map would cost more than the code.
const SHOW_WHOLE_LINES = 8;

// read on a code element or one of its parts.
export async function readCode(elementId, path, text, hint = '') {
  const o = await codeOutline(text, hint);
  const out = [];
  if (!path.length) {
    const top = parts(o.segs);
    // Nothing worth choosing from (short, no parts, or one part without parts): the code itself.
    if (o.lines <= SHOW_WHOLE_LINES || !top.length || (top.length === 1 && !parts(top[0].children).length)) {
      return [`CODE ${elementId}: ${o.lang}, ${o.lines} lines`, '---', text].join('\n');
    }
    out.push(`CODE ${elementId}: ${o.lang}, ${o.lines} lines`);
    const n = listParts(elementId, o.segs, o.label, out);
    out.push('---', `Read a part: read with section "${elementId}.1" ... "${elementId}.${n}".`);
    return out.join('\n');
  }
  let segs = o.segs, seg = null, addr = elementId;
  for (const k of path) {
    const ps = parts(segs);
    seg = ps[k - 1];
    if (!seg) return `[WebSkeleton Error] ${addr} has no part ${k}; it has ${ps.length ? `${addr}.1 ... ${addr}.${ps.length}` : 'no parts'}.`;
    addr += `.${k}`;
    segs = seg.children;
  }
  const kids = parts(seg.children);
  const code = (from, to) => o.srcLines.slice(from - 1, to).join('\n');
  out.push(`CODE ${addr}: ${cut(o.label(seg), 80)} (${lineRange(seg)})`, '---');
  if (!kids.length) {
    out.push(code(seg.startLine, seg.endLine));
    return out.join('\n');
  }
  // A part with parts: its opening line(s), then its parts to choose from.
  const openEnd = Math.max(seg.startLine, kids[0].startLine - 1);
  out.push(code(seg.startLine, openEnd));
  out.push('---');
  listParts(addr, seg.children, o.label, out);
  out.push(`Read a part: read with section "${addr}.1" ... "${addr}.${kids.length}".`);
  return out.join('\n');
}
