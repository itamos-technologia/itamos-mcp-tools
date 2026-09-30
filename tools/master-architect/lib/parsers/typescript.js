/**
 * TypeScript parser for master_architect.
 *
 * TypeScript is JavaScript-with-types from our perspective: the constructs
 * the verifier cares about (DB connections, SQL queries, imports, modules,
 * methods) all parse to the same tree-sitter AST node types as JavaScript.
 * `new_expression`, `call_expression`, `member_expression`, `string`,
 * `object`, `pair`, `property_identifier` — same nodes, same children.
 *
 * Therefore this parser delegates to javascript.js's walks unchanged.
 * Only the grammar differs: we load tree-sitter-typescript instead of
 * tree-sitter-javascript. The walks don't know or care.
 *
 * Two grammars are exposed by tree-sitter-typescript:
 *   - typescript  → for .ts files (no JSX)
 *   - tsx         → for .tsx files (TS + JSX support)
 * We pick per-file based on extension.
 */

import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';
import path from 'path';
import { parseWithParser, parseWithRootNode as jsParseWithRootNode } from './javascript.js';

const _parsers = { typescript: null, tsx: null };

function getTsParser(grammarName) {
  if (_parsers[grammarName]) return _parsers[grammarName];
  const p = new Parser();
  p.setLanguage(TS[grammarName]);
  _parsers[grammarName] = p;
  return p;
}

/**
 * Run analysis over an externally-supplied rootNode (shared parse). TS reuses
 * JS's walkers, so this is JS's parseWithRootNode. NOTE: the caller must have
 * parsed with the correct grammar (.tsx needs the tsx grammar); the scan
 * dispatch currently routes .tsx via parseFile to preserve grammar selection.
 */
export function parseWithRootNode(rootNode, content) {
  return jsParseWithRootNode(rootNode, content);
}

export default {
  language: 'typescript',
  extensions: ['.ts', '.tsx'],

  /**
   * Parse a TypeScript file. Picks the right grammar based on extension
   * if available via the optional `filename` arg; otherwise defaults to
   * the plain typescript grammar.
   *
   * @param {string} content
   * @param {string} [filename]  optional filename so .tsx gets the tsx grammar
   * @returns {{ modules, imports, databases, sql_queries, parse_error?: string }}
   */
  parseFile(content, filename) {
    const ext = filename ? path.extname(filename).toLowerCase() : '.ts';
    const grammarName = ext === '.tsx' ? 'tsx' : 'typescript';
    return parseWithParser(getTsParser(grammarName), content);
  },

  /**
   * Resolve a relative import path. TypeScript's resolution is a strict
   * superset of JS's: same relative-path rules, but adds .ts/.tsx extensions
   * and handles the case where source imports './foo' meaning './foo.ts'.
   *
   * We also try .js/.mjs etc. because TS code often imports compiled JS
   * neighbors or .d.ts type declarations from JS files.
   */
  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
    const baseDir = path.dirname(fromAbsFile);
    const candidate = path.resolve(baseDir, importPath);
    const tries = [
      candidate,
      candidate + '.ts', candidate + '.tsx',
      candidate + '.js', candidate + '.mjs', candidate + '.cjs', candidate + '.jsx',
      candidate + '.d.ts',
      path.join(candidate, 'index.ts'),
      path.join(candidate, 'index.tsx'),
      path.join(candidate, 'index.js'),
      path.join(candidate, 'index.mjs'),
    ];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
