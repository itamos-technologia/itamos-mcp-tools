/**
 * Go parser adapter for master-architect.
 *
 * Uses tree-sitter-go for AST extraction. Returns the standard analysis shape.
 *
 * Detected:
 *   modules:  top-level function_declaration, method_declaration,
 *             type_declaration (struct, interface, type alias)
 *   methods:  method_declaration (receiver functions) — also captured in modules
 *             with kind='method' for the DB to store separately
 *   imports:  import_declaration (single and grouped)
 *   databases: common Go DB open patterns (sql.Open, gorm.Open, etc.)
 */

import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Go);
  return _parser;
}

function nodeLine(node)    { return node.startPosition.row + 1; }
function nodeLineEnd(node) { return node.endPosition.row + 1; }

function funcName(node) {
  const n = node.childForFieldName?.('name');
  return n ? n.text : '(anonymous)';
}

function receiverType(node) {
  // method_declaration has a 'receiver' field: (r *TypeName)
  const recv = node.childForFieldName?.('receiver');
  if (!recv) return null;
  // Walk to find type_identifier or pointer_type > type_identifier
  for (const c of recv.namedChildren || []) {
    const typeNode = c.childForFieldName?.('type') || c;
    if (typeNode.type === 'pointer_type') {
      const inner = typeNode.namedChildren?.[0];
      return inner ? '*' + inner.text : null;
    }
    if (typeNode.type === 'type_identifier') return typeNode.text;
  }
  return null;
}

function walkTopLevel(root, analysis) {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'function_declaration': {
        const name = funcName(node);
        analysis.modules.push({
          kind: 'function',
          name,
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'method_declaration': {
        const name = funcName(node);
        const recv = receiverType(node);
        analysis.modules.push({
          kind: 'method',
          name: recv ? `(${recv}).${name}` : name,
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'type_declaration': {
        // May contain multiple type specs
        for (const spec of node.namedChildren) {
          if (spec.type === 'type_spec') {
            const nameNode = spec.childForFieldName?.('name');
            const typeNode = spec.childForFieldName?.('type');
            const kind = typeNode?.type === 'struct_type'    ? 'struct'
                       : typeNode?.type === 'interface_type' ? 'interface'
                       : 'type';
            analysis.modules.push({
              kind,
              name: nameNode ? nameNode.text : '(type)',
              line: nodeLine(spec),
              line_end: nodeLineEnd(spec),
            });
          }
        }
        break;
      }
    }
  }
}

function walkImports(root, analysis) {
  for (const node of root.namedChildren) {
    if (node.type !== 'import_declaration') continue;

    // Single import: import "fmt"
    // Grouped import: import ( "fmt"\n "os" )
    for (const spec of node.namedChildren) {
      if (spec.type === 'import_spec') {
        const pathNode = spec.childForFieldName?.('path') || spec.namedChildren?.[0];
        if (pathNode) {
          const raw = pathNode.text;
          analysis.imports.push({
            import_path: raw.replace(/^["']|["']$/g, ''),
            line: nodeLine(spec),
          });
        }
      } else if (spec.type === 'import_spec_list') {
        for (const s of spec.namedChildren) {
          if (s.type === 'import_spec') {
            const pathNode = s.childForFieldName?.('path') || s.namedChildren?.[0];
            if (pathNode) {
              analysis.imports.push({
                import_path: pathNode.text.replace(/^["']|["']$/g, ''),
                line: nodeLine(s),
              });
            }
          }
        }
      }
    }
  }
}

const DB_FUNCS = new Set(['Open', 'Connect', 'New', 'Init']);
const DB_PKGS  = new Set(['sql', 'gorm', 'sqlx', 'pgx', 'mongo', 'redis', 'bolt', 'badger']);

function walkDatabases(root, analysis) {
  function recurse(node) {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName?.('function');
      if (fn?.type === 'selector_expression') {
        const pkg  = fn.childForFieldName?.('operand')?.text  || '';
        const meth = fn.childForFieldName?.('field')?.text    || '';
        if (DB_PKGS.has(pkg) && DB_FUNCS.has(meth)) {
          const args = node.childForFieldName?.('arguments');
          const first = args?.namedChildren?.[0];
          if (first?.type === 'interpreted_string_literal') {
            analysis.databases.push({
              name: `${pkg}.${meth}`,
              type: 'go_db',
              path_or_uri: first.text.slice(1, -1),
              line: nodeLine(node),
            });
          }
        }
      }
    }
    for (const c of node.namedChildren) recurse(c);
  }
  recurse(root);
}

/**
 * Run Go analysis walkers over an externally-supplied rootNode (shared parse).
 * Mirrors parseFile exactly (walkTopLevel, walkImports, walkDatabases).
 */
export function parseWithRootNode(rootNode) {
  const analysis = { modules: [], imports: [], databases: [], sql_queries: [] };
  try {
    walkTopLevel(rootNode, analysis);
    walkImports(rootNode, analysis);
    walkDatabases(rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'go',
  extensions: ['.go'],

  parseFile(content) {
    const analysis = { modules: [], imports: [], databases: [], sql_queries: [] };
    try {
      const tree = getParser().parse(content);
      walkTopLevel(tree.rootNode, analysis);
      walkImports(tree.rootNode, analysis);
      walkDatabases(tree.rootNode, analysis);
    } catch (err) {
      analysis.parse_error = err.message;
    }
    return analysis;
  },

  resolveImport(importPath, fromAbsFile, fs, path) {
    // Go imports are module paths — not resolvable to local files without
    // go.mod context. Return null for now; local relative paths are rare.
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
    const candidate = path.resolve(path.dirname(fromAbsFile), importPath);
    const tries = [candidate, candidate + '.go', path.join(candidate, 'doc.go')];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
