// =============================================================================
// Metal Shading Language check with ordinary clang (no Apple software)
// =============================================================================
// clang++ -fsyntax-only with lib/metal/metal_shim.h (our own declarations of the Metal
// language and library, generated from the public specification by gen_metal_shim.py),
// force-included (Metal's types and keywords need no #include), plus stand-in
// <metal_stdlib> ... headers. Metal idioms plain C++ lacks are rewritten first, in the file
// and in every project header it includes (mirrored into a temp folder, so the originals are
// never touched; line numbers are kept, so errors point at the right line):
//   float4(uv, 0.0f, 1.0f)           -> __mctor<float4>(uv, 0.0f, 1.0f)  vector constructors
//   (half4) v                        -> __mcvt<half4>(v)                 converting casts
//   1.5h                             -> ((half)1.5)                      half literals
//   template [[host_name("x")]] ...  -> attribute blanked                (clang refuses it there)
//   [[threadgroup(0)]]               -> [[__a_threadgroup(0)]]           attribute names that are
//                                                                         address-space words
//   constant T x [[function_constant(N)]]  -> `constant` blanked         (no initialiser)
// Conversions through typedef'd vector names (s2_t(h), T4(x)) cannot be seen in the text: clang
// reports them, the checker rewrites exactly those spots and runs again (at most 4 passes).
// Returns { available, errors: [{ file, line, col, msg }], command }. available=false when
// clang or the shim is missing (callers then keep their tree-sitter-only check).
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.join(HERE, 'metal');
const SHIM_INCLUDE = path.join(SHIM_DIR, 'include');
const CLANG = process.env.METAL_CHECK_CLANG || '/usr/bin/clang++';
const MAX_INCLUDE_FILES = 400;
const ANCESTOR_LEVELS = 8;
const MAX_PASSES = 8;

const VEC_BASES = ['bool', 'char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'half', 'float', 'bfloat'];
const VEC_NAMES = VEC_BASES.flatMap(b => [2, 3, 4].flatMap(n => [`${b}${n}`, `packed_${b}${n}`]));
const VEC_ALT = `(?:metal::)?(?:${VEC_NAMES.join('|')})`;
const CTOR_RE = new RegExp(`(?<![\\w.>:])(${VEC_ALT})(\\s*)\\((?!\\s*[*&^])`, 'g');   // not floatN (*fn)(...)
const STATIC_CAST_RE = /(?<![\w.>:])static_cast\s*</g;
const CAST_RE = new RegExp(`\\(\\s*(${VEC_ALT})\\s*\\)(?=\\s*[\\w(!~+\\-*&])`, 'g');
const HALF_LIT_RE = /(?<![\w.])((?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)[hH](?![\w])/g;
const HOST_NAME_RE = /(\btemplate(?:\s|\\\n)*)((?:\[\[(?:[^\[\]]|\[[^\[\]]*\])*\]\](?:\s|\\\n)*)+)/g;
const ATTR_RE = /\[\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\]/g;
const ATTR_WORDS_RE = /\b(threadgroup|device|constant|thread|kernel|vertex|fragment|threadgroup_imageblock|ray_data|object_data)\b/g;
const FUNC_CONST_RE = /\bconstant\b(?=[^;{}\n]*\[\[\s*function_constant\b)/g;

// end of the unary expression that starts at i (operand of a cast): prefix operators, then a
// primary (identifier / literal / ( ... )), then postfix [ ... ] ( ... ) .x ->y ++ --
function operandEnd(t, i) {
  const ws = () => { while (i < t.length && /\s/.test(t[i])) i++; };
  const bal = (open, close) => {
    let d = 0;
    for (; i < t.length; i++) {
      if (t[i] === open) d++;
      else if (t[i] === close) { d--; if (d === 0) { i++; return true; } }
    }
    return false;
  };
  ws();
  while (/[-+!~*&]/.test(t[i] || '')) { i++; ws(); }
  if (t[i] === '(') { if (!bal('(', ')')) return -1; }
  else {
    const m = /^(?:[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*|\d[\w.]*(?:[eE][+-]?\d+)?|\.\d[\w]*)/.exec(t.slice(i));
    if (!m) return -1;
    i += m[0].length;
  }
  for (;;) {
    const save = i; ws();
    if (t[i] === '[') { if (!bal('[', ']')) return -1; continue; }
    if (t[i] === '(') { if (!bal('(', ')')) return -1; continue; }
    if (t[i] === '.' && /[A-Za-z_]/.test(t[i + 1] || '')) { i++; i += /^\w*/.exec(t.slice(i))[0].length; continue; }
    if (t[i] === '-' && t[i + 1] === '>') { i += 2; ws(); i += /^\w*/.exec(t.slice(i))[0].length; continue; }
    if ((t[i] === '+' && t[i + 1] === '+') || (t[i] === '-' && t[i + 1] === '-')) { i += 2; continue; }
    i = save;
    return i;
  }
}

// (half4) x  ->  __mcvt<half4>(x)   in one code chunk
function rewriteCasts(code) {
  let out = '', last = 0;
  CAST_RE.lastIndex = 0;
  let m;
  while ((m = CAST_RE.exec(code))) {
    const end = operandEnd(code, m.index + m[0].length);
    if (end < 0) continue;
    out += code.slice(last, m.index) + `__mcvt<${m[1]}>(` + code.slice(m.index + m[0].length, end) + ')';
    last = end;
    CAST_RE.lastIndex = end;
  }
  return out + code.slice(last);
}

// rewrites outside comments and string / char literals; newlines are kept. The ones that
// can contain strings (host_name("..."), attributes) run on the whole text first.
// names declared as template type parameters anywhere in the file
function templateTypeParams(src) {
  const names = new Set();
  for (const m of src.matchAll(/\btemplate\s*<([^<>]*(?:<[^<>]*>[^<>]*)*)>/g))
    for (const p of m[1].matchAll(/\b(?:typename|class)\s+([A-Za-z_]\w*)/g)) names.add(p[1]);
  return names;
}
// NAME( a, b ... ) with a top-level comma -> __mctor<NAME>(   (vector construction in Metal)
function rewriteTParamCtors(code, names) {
  if (!names.size) return code;
  const re = new RegExp(`(?<![\\w.>:])(${[...names].join('|')})(\\s*)\\((?!\\s*[*&^)])`, 'g');
  return code.replace(re, (m, name, sp, off) => {
    let d = 0;
    for (let k = off + m.length; k < code.length; k++) {
      const ch = code[k];
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (d === 0) return m; d--; }
      else if (ch === ',' && d === 0) return `__mctor<${name}>${sp}(`;
      else if (ch === ';') return m;
    }
    return m;
  });
}

export function rewriteMetal(src) {
  const tparams = templateTypeParams(src);
  src = src.replace(HOST_NAME_RE, (m, t, attr) => t + attr.replace(/[^\n\\]/g, ' '))
           .replace(ATTR_RE, (m, inner) => `[[${inner.replace(ATTR_WORDS_RE, '__a_$1')}]]`)
           .replace(FUNC_CONST_RE, '        ');
  let out = '';
  let i = 0;
  let code = '';
  const flush = () => {
    out += rewriteCasts(rewriteTParamCtors(code, tparams).replace(CTOR_RE, (m, type, sp) => `__mctor<${type}>${sp}(`)
                            .replace(STATIC_CAST_RE, '__mscast<')
                            .replace(HALF_LIT_RE, (m, num) => `((half)${num})`));
    code = '';
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      flush(); const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e;
      out += src.slice(i, end); i = end; continue;
    }
    if (c === '/' && d === '*') {
      flush(); const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2;
      out += src.slice(i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      flush(); let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== '\n') { if (src[k] === '\\') k++; k++; }
      out += src.slice(i, k + 1); i = k + 1; continue;
    }
    code += c; i++;
  }
  flush();
  return out;
}

// clang errors that mean "Metal would convert this vector here": fix at the reported spot
const CONVERSION_ERR = /(?:from vector .* to vector .* of different size|static_cast from .* is not allowed|cast from vector .* of different size|cannot initialize .* with an (?:l|r)value of type '[^']*vector|excess elements in (?:vector|scalar) initializer|cannot convert between vector|cannot convert '[^']*' to '[^']*' without a conversion operator|assigning to '[^']*' from incompatible type|no viable conversion from)/;
// at (line, col) of text: TYPE( -> __mctor<TYPE>(   or   (TYPE)x -> __mcvt<TYPE>(x)
function healAt(text, line, col) {
  const lines = text.split('\n');
  const L = lines[line - 1];
  if (L === undefined) return null;
  const at = Math.max(0, col - 1);
  const rest = L.slice(at);
  let m = /^(\(\s*([A-Za-z_][\w:]*)\s*\))/.exec(rest);
  if (m && !m[2].startsWith('__m')) {
    const before = lines.slice(0, line - 1).join('\n') + (line > 1 ? '\n' : '') + L.slice(0, at);
    const after = rest.slice(m[1].length) + '\n' + lines.slice(line).join('\n');
    const end = operandEnd(after, 0);
    if (end < 0) return null;
    return before + `__mcvt<${m[2]}>(` + after.slice(0, end) + ')' + after.slice(end).replace(/\n$/, '');
  }
  m = /^([A-Za-z_][\w:]*(?:<[^<>;(){}]*>)?)(\s*)([({])/.exec(rest);
  if (!m) {
    // the column points inside the call (excess elements): find the enclosing  T( ... )
    let depth = 0;
    for (let k = at - 1; k >= 0; k--) {
      const ch = L[k];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth > 0) { depth--; continue; }
        const head = /([A-Za-z_][\w:]*(?:<[^<>;(){}]*>)?)\s*$/.exec(L.slice(0, k));
        if (!head || head[1].startsWith('__m') || /^(if|for|while|switch|return|sizeof)$/.test(head[1])) return null;
        lines[line - 1] = L.slice(0, head.index) + `__mctor<${head[1]}>` + L.slice(head.index + head[1].length);
        return lines.join('\n');
      }
    }
    return null;
  }
  if (m && !m[1].startsWith('__m')) {
    lines[line - 1] = L.slice(0, at) + `__mctor<${m[1]}>${m[2]}(` + (m[3] === '{' ? '' : '') + L.slice(at + m[0].length) ;
    if (m[3] === '{') return null;        // braced init: leave it, it is a real error
    return lines.join('\n');
  }
  return null;
}

function searchDirs(filePath) {
  const dirs = [];
  let d = path.dirname(path.resolve(filePath));
  for (let k = 0; k <= ANCESTOR_LEVELS; k++) {
    dirs.push(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirs;
}

// project files reachable through #include from the main file (resolved like clang will)
async function includeClosure(mainPath, mainContent, dirs) {
  const seen = new Map();            // abs path -> content
  const queue = [[mainPath, mainContent]];
  while (queue.length && seen.size < MAX_INCLUDE_FILES) {
    const [p, text] = queue.shift();
    if (seen.has(p)) continue;
    seen.set(p, text);
    for (const m of text.matchAll(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm)) {
      const name = m[2];
      const cands = (m[1] === '"' ? [path.dirname(p), ...dirs] : dirs).map(d => path.join(d, name));
      const hit = cands.find(c => { try { return existsSync(c) && !c.startsWith(SHIM_DIR); } catch { return false; } });
      if (!hit || seen.has(hit)) continue;
      try { queue.push([hit, await fs.readFile(hit, 'utf8')]); } catch { /* unreadable: clang will say */ }
    }
  }
  return seen;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, killed: !!(err && err.killed), out: `${stdout}${stderr}` });
    });
  });
}

export function metalCheckAvailable() {
  return existsSync(CLANG) && existsSync(path.join(SHIM_DIR, 'metal_shim.h')) && existsSync(SHIM_INCLUDE);
}

// filePath: the .metal file (its folder and parents are the include search path);
// content: the text to check (the edited buffer); files on disk are used for its includes
export async function checkMetal(filePath, content) {
  if (!metalCheckAvailable()) return { available: false, errors: [] };
  const abs = path.resolve(filePath);
  const dirs = searchDirs(abs);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'metal-check-'));
  const prefix = path.join(root, 'm');
  const mirror = (p) => path.join(prefix, p);
  try {
    const files = await includeClosure(abs, content, dirs);
    const mirrored = new Map();      // mirror path -> current rewritten text
    for (const [p, text] of files) {
      const mp = mirror(p);
      await fs.mkdir(path.dirname(mp), { recursive: true });
      const rt = rewriteMetal(text);
      mirrored.set(mp, rt);
      await fs.writeFile(mp, rt);
    }
    const args = ['-x', 'c++', '-std=c++17', '-fsyntax-only', '-w', '-ferror-limit=0',
      '-fno-caret-diagnostics', '-fno-color-diagnostics', '-fno-diagnostics-show-option',
      '-nostdinc', '-nostdinc++', '-isystem', SHIM_INCLUDE,
      '-include', path.join(SHIM_DIR, 'metal_shim.h'),
      ...dirs.flatMap(d => ['-I', mirror(d)]), mirror(abs)];
    let errors = [], killed = false, passes = 0;
    for (; passes < MAX_PASSES; passes++) {
      const r = await run(CLANG, args, 60000);
      killed = r.killed;
      errors = [];
      let inShim = null;   // last error located inside the stand-in library, awaiting a user location
      for (const line of r.out.split('\n')) {
        const m = /^(.+?):(\d+):(\d+): (?:fatal )?error: (.*)$/.exec(line);
        if (m) {
          const e = { mfile: m[1], line: +m[2], col: +m[3], msg: m[4] };
          if (e.mfile.startsWith(SHIM_DIR)) {
            inShim = e;
            if (/vector constructor: wrong number of components/.test(e.msg)) e.msg = 'vector constructor: wrong number of components';
          } else inShim = null;
          errors.push(e);
          continue;
        }
        const n = /^(.+?):(\d+):(\d+): note: (?:in instantiation of|required from)/.exec(line);
        if (n && inShim && mirrored.has(n[1])) {
          Object.assign(inShim, { mfile: n[1], line: +n[2], col: +n[3] });
          inShim = null;
        }
      }
      // heal the conversions Metal allows (bottom-up per file, so columns stay valid)
      let healed = 0;
      const byFile = new Map();
      for (const e of errors) if (CONVERSION_ERR.test(e.msg) && mirrored.has(e.mfile)) {
        if (!byFile.has(e.mfile)) byFile.set(e.mfile, []);
        byFile.get(e.mfile).push(e);
      }
      for (const [mf, es] of byFile) {
        let text = mirrored.get(mf);
        const spots = [...new Map(es.map(e => [`${e.line}:${e.col}`, e])).values()]
          .sort((a, b) => b.line - a.line || b.col - a.col);
        for (const e of spots) { const t2 = healAt(text, e.line, e.col); if (t2 !== null) { text = t2; healed++; } }
        mirrored.set(mf, text);
        await fs.writeFile(mf, text);
      }
      if (!healed) break;
    }
    const out = errors.map(e => ({
      file: e.mfile.startsWith(prefix) ? e.mfile.slice(prefix.length) : e.mfile,
      line: e.line, col: e.col,
      msg: e.msg.replace(/__mctor<([^>]+)>/g, '$1').replace(/__mcvt<([^>]+)>/g, '($1)'),
    }));
    if (killed) out.push({ file: abs, line: 0, col: 0, msg: 'Metal check timed out' });
    return { available: true, errors: out, passes: passes + 1,
      command: `clang++ -fsyntax-only + metal_shim.h (${files.size} file(s))` };
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// errors in `after` that are not in `before` (same file + message; line numbers ignored,
// an edit moves them), as many times as they are new
export function newMetalErrors(before, after) {
  const count = new Map();
  for (const e of before) { const k = `${e.file}|${e.msg}`; count.set(k, (count.get(k) || 0) + 1); }
  const fresh = [];
  for (const e of after) {
    const k = `${e.file}|${e.msg}`;
    const c = count.get(k) || 0;
    if (c > 0) count.set(k, c - 1); else fresh.push(e);
  }
  return fresh;
}
