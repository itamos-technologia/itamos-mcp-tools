// =============================================================================
// Dialect grammars for the C family, and the enriched ("plus") C++ grammars
// =============================================================================
//   .cu .cuh  -> CUDA grammar          .hip -> CUDA grammar (HIP is CUDA-style C++)
//   .metal    -> Metal grammar (C++ grammar + kernel/vertex/fragment, address spaces)
//   .m .mm    -> Objective-C grammar   .h with @interface / @protocol -> Objective-C too
//   other C++ (.cpp .cc .hpp, C++ .h) -> tree-sitter-cpp-plus when present
// The "plus" builds (grammars/plus/: stock grammar + extra C++ rules, checked to give the
// same tree wherever the stock grammar already parses) are preferred when present; the
// stock grammar is the fallback. The grammars live apart from the tools' node_modules, in
// the repo's grammars/ folder (or SANDBOX_GRAMMARS_DIR). Each grammars/tree-sitter-* folder
// is a self-contained drop-in package: prebuilt binary in prebuilds/<platform>-<arch>/, or
// its own build/Release after `npx node-gyp rebuild`. Stock packages (tree-sitter-cuda,
// tree-sitter-objc) come from grammars/node_modules. Only the PARSE uses them: the language
// name stays 'c' / 'cpp' everywhere else (checks, import resolution, project map). A grammar
// that is missing or fails to load returns null, and callers fall back to the plain C / C++
// grammar, as before.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Parser from 'tree-sitter';
import { headerDialect } from './c_header.js';

const GRAMMARS_DIR = process.env.SANDBOX_GRAMMARS_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../grammars');
const req = createRequire(path.join(GRAMMARS_DIR, 'package.json'));

// ext -> [dialect name, grammar packages (first that loads wins), label for messages]
const CUDA = ['tree-sitter-cuda-plus', 'tree-sitter-cuda'];
const METAL = ['tree-sitter-metal-plus', 'tree-sitter-metal'];
const OBJC = ['tree-sitter-objc'];
const DIALECT_BY_EXT = {
  '.cu':    ['cuda',  CUDA,  'CUDA'],
  '.cuh':   ['cuda',  CUDA,  'CUDA'],
  '.hip':   ['cuda',  CUDA,  'CUDA (HIP)'],
  '.metal': ['metal', METAL, 'Metal'],
  '.m':     ['objc',  OBJC,  'Objective-C'],
  '.mm':    ['objc',  OBJC,  'Objective-C'],
};
const CPP_PLUS = ['tree-sitter-cpp-plus'];

const _grammars = new Map();   // dialect -> { grammar, pkg } | null (nothing loads)
const _parsers = new Map();    // dialect -> Parser

// A broken native grammar (e.g. an undefined symbol) does not throw, it kills the process.
// So each grammar package is first loaded and used once in a short child process; only when
// that succeeds is it loaded here. Done once per package per process start.
const TREE_SITTER_PATH = createRequire(import.meta.url).resolve('tree-sitter');
// Where a grammar package lives: its own folder in grammars/ (drop-in: copy the folder in and
// it is found, no npm install or symlink needed), else grammars/node_modules (npm-installed
// stock grammars such as tree-sitter-cuda / tree-sitter-objc). null when neither exists.
function locate(pkg) {
  const dir = path.join(GRAMMARS_DIR, pkg);
  if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  try { req.resolve(pkg); return pkg; } catch { return null; }
}

function loadsSafely(target) {
  const probe = `const r = require('module').createRequire(${JSON.stringify(path.join(GRAMMARS_DIR, 'package.json'))});
    const P = require(${JSON.stringify(TREE_SITTER_PATH)}); const m = r(${JSON.stringify(target)});
    const p = new P(); p.setLanguage(m.default || m); p.parse('int main(void) { return 0; }');`;
  const r = spawnSync(process.execPath, ['-e', probe], { timeout: 20000, stdio: 'ignore' });
  return r.status === 0;
}

function loadGrammar(name, pkgs) {
  if (_grammars.has(name)) return _grammars.get(name);
  let found = null;
  for (const pkg of pkgs) {
    try {
      const target = locate(pkg);
      if (!target) continue;                 // not present -> next, without spawning
      if (!loadsSafely(target)) continue;
      const m = req(target);
      const g = m.default || m;
      new Parser().setLanguage(g);           // fails here if the binary does not match the runtime
      found = { grammar: g, pkg };
      break;
    } catch { /* next */ }
  }
  _grammars.set(name, found);
  return found;
}

function parserFor(name, grammar) {
  if (!_parsers.has(name)) {
    const p = new Parser();
    p.setLanguage(grammar);
    _parsers.set(name, p);
  }
  return _parsers.get(name);
}

// { name, label, grammar, pkg } for a dialect file, or null (not a dialect / grammar missing).
// By content (lib/c_header.js headerDialect; content optional, read from disk): a .h with
// Objective-C (@interface / @protocol ...); a .h / .hpp / .cpp / .cc ... with CUDA or HIP
// code (__global__ / __device__ / kernel<<<...>>>).
export function dialectInfo(filePath, content) {
  if (!filePath) return null;
  const ext = path.extname(filePath).toLowerCase();
  let d = DIALECT_BY_EXT[ext];
  if (!d) {
    const hd = headerDialect(filePath, content);
    if (hd === 'objc') d = ['objc', OBJC, 'Objective-C header'];
    else if (hd === 'cuda') d = ['cuda', CUDA, ext === '.h' || ext.startsWith('.h') ? 'CUDA / HIP header' : 'CUDA / HIP'];
  }
  if (!d) return null;
  const g = loadGrammar(d[0], d[1]);
  return g ? { name: d[0], label: d[2], grammar: g.grammar, pkg: g.pkg } : null;
}

// A cached parser for the file's dialect grammar, or null
export function dialectParser(filePath, content) {
  const info = dialectInfo(filePath, content);
  return info ? parserFor(info.name, info.grammar) : null;
}

// The best parser for a C-family file: its dialect grammar, else (C++) the plus C++ grammar
// when built, else null (the caller uses the stock grammar for the language)
export function grammarParser(filePath, language, content) {
  const dp = dialectParser(filePath, content);
  if (dp) return dp;
  if (language === 'cpp') {
    const g = loadGrammar('cpp', CPP_PLUS);
    if (g) return parserFor('cpp', g.grammar);
  }
  return null;
}

export const DIALECT_EXTS = Object.keys(DIALECT_BY_EXT);
