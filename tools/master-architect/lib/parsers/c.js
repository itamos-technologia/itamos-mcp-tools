/**
 * C parser adapter for master-architect.
 *
 * Detected:
 *   modules:  function_definition (all functions),
 *             struct_specifier, union_specifier, enum_specifier (named),
 *             typedef declarations
 *   imports:  preproc_include (#include <x> and #include "x")
 *   databases: sqlite3_open / fopen patterns
 */

import Parser from 'tree-sitter';
import C from 'tree-sitter-c';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(C);
  return _parser;
}

function nodeLine(node)    { return node.startPosition.row + 1; }
function nodeLineEnd(node) { return node.endPosition.row + 1; }

function funcName(node) {
  // function_definition → declarator → ... → identifier
  function findIdent(n) {
    if (!n) return null;
    if (n.type === 'identifier') return n.text;
    if (n.type === 'function_declarator') {
      const d = n.childForFieldName?.('declarator');
      return findIdent(d);
    }
    if (n.type === 'pointer_declarator') {
      const d = n.childForFieldName?.('declarator');
      return findIdent(d);
    }
    for (const c of n.namedChildren || []) {
      const r = findIdent(c);
      if (r) return r;
    }
    return null;
  }
  const decl = node.childForFieldName?.('declarator');
  return findIdent(decl) || '(anonymous)';
}

function walkTopLevel(root, analysis) {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'function_definition': {
        analysis.modules.push({
          kind: 'function',
          name: funcName(node),
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'struct_specifier':
      case 'union_specifier': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) {
          analysis.modules.push({
            kind: node.type === 'struct_specifier' ? 'struct' : 'union',
            name: nameNode.text,
            line: nodeLine(node),
            line_end: nodeLineEnd(node),
          });
        }
        break;
      }
      case 'enum_specifier': {
        const nameNode = node.childForFieldName?.('name');
        if (nameNode) {
          analysis.modules.push({
            kind: 'enum',
            name: nameNode.text,
            line: nodeLine(node),
            line_end: nodeLineEnd(node),
          });
        }
        break;
      }
      case 'declaration': {
        // typedef struct/enum or function declaration
        const typeNode = node.childForFieldName?.('type');
        if (typeNode?.type === 'struct_specifier' || typeNode?.type === 'union_specifier' || typeNode?.type === 'enum_specifier') {
          // Handled by the struct/enum cases above when they appear directly
          break;
        }
        // Check for typedef
        if (node.text?.startsWith('typedef')) {
          const decl = node.childForFieldName?.('declarator');
          const name = decl?.type === 'type_identifier' ? decl.text
                     : decl?.namedChildren?.[0]?.text || null;
          if (name) {
            analysis.modules.push({
              kind: 'typedef',
              name,
              line: nodeLine(node),
              line_end: nodeLineEnd(node),
            });
          }
        }
        break;
      }
    }
  }
}

function walkIncludes(root, analysis) {
  for (const node of root.namedChildren) {
    if (node.type === 'preproc_include') {
      const pathNode = node.childForFieldName?.('path') || node.namedChildren?.[0];
      if (pathNode) {
        const raw = pathNode.text.replace(/^[<"']|[>"']$/g, '');
        analysis.imports.push({ import_path: raw, line: nodeLine(node) });
      }
    }
  }
}

const C_DB_FUNCS = new Set(['sqlite3_open', 'sqlite3_open_v2', 'fopen', 'open']);

function walkDatabases(root, analysis) {
  function recurse(node) {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName?.('function');
      if (fn?.type === 'identifier' && C_DB_FUNCS.has(fn.text)) {
        const args = node.childForFieldName?.('arguments');
        const first = args?.namedChildren?.[0];
        const pathStr = first?.type === 'string_literal'
          ? first.text.slice(1, -1) : first?.text || '?';
        analysis.databases.push({
          name: fn.text,
          type: 'c_io',
          path_or_uri: pathStr,
          line: nodeLine(node),
        });
      }
    }
    for (const c of node.namedChildren) recurse(c);
  }
  recurse(root);
}

/**
 * Run analysis walkers over an externally-supplied rootNode (shared parse).
 * parseFile delegates here, so behavior is byte-identical by construction.
 */
export function parseWithRootNode(rootNode) {
  const analysis = { modules: [], imports: [], databases: [], sql_queries: [] };
  try {
    walkTopLevel(rootNode, analysis);
    walkIncludes(rootNode, analysis);
    walkDatabases(rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'c',
  extensions: ['.c', '.h'],

    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },

  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
    const base = path.resolve(path.dirname(fromAbsFile), importPath);
    const tries = [base, base + '.h', base + '.c'];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
