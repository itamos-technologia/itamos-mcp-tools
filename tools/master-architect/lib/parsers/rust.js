/**
 * Rust parser adapter for master-architect.
 *
 * Uses tree-sitter-rust for AST extraction. Returns the standard analysis shape.
 *
 * Detected:
 *   modules:  function_item (top-level fns), impl_item (impl blocks with methods),
 *             struct_item, enum_item, trait_item, mod_item
 *   methods:  function_item inside impl_item blocks
 *   imports:  use_declaration
 *   databases: common Rust DB patterns (Connection::open, Pool::connect, etc.)
 */

import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Rust);
  return _parser;
}

function nodeLine(node)    { return node.startPosition.row + 1; }
function nodeLineEnd(node) { return node.endPosition.row + 1; }

function itemName(node) {
  const n = node.childForFieldName?.('name');
  return n ? n.text : '(anonymous)';
}

function walkTopLevel(root, analysis) {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'function_item': {
        analysis.modules.push({
          kind: 'function',
          name: itemName(node),
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'impl_item': {
        // impl TypeName { ... } or impl Trait for TypeName { ... }
        const typeName = node.childForFieldName?.('type')?.text || '(impl)';
        const traitName = node.childForFieldName?.('trait')?.text;
        const implLabel = traitName ? `${traitName} for ${typeName}` : typeName;

        analysis.modules.push({
          kind: 'impl',
          name: `impl ${implLabel}`,
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });

        // Walk methods inside the impl block
        const body = node.childForFieldName?.('body');
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === 'function_item') {
              analysis.modules.push({
                kind: 'method',
                name: `${typeName}::${itemName(child)}`,
                line: nodeLine(child),
                line_end: nodeLineEnd(child),
              });
            }
          }
        }
        break;
      }
      case 'struct_item': {
        analysis.modules.push({
          kind: 'struct',
          name: itemName(node),
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'enum_item': {
        analysis.modules.push({
          kind: 'enum',
          name: itemName(node),
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'trait_item': {
        analysis.modules.push({
          kind: 'trait',
          name: itemName(node),
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'mod_item': {
        // Only capture named modules (mod foo;), not inline mod foo { }
        analysis.modules.push({
          kind: 'mod',
          name: itemName(node),
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
    }
  }
}

function walkImports(root, analysis) {
  function recurse(node) {
    if (node.type === 'use_declaration') {
      // Flatten use path to a string
      const arg = node.childForFieldName?.('argument');
      if (arg) {
        analysis.imports.push({
          import_path: arg.text,
          line: nodeLine(node),
        });
      }
      return; // don't recurse into use trees
    }
    for (const c of node.namedChildren) recurse(c);
  }
  recurse(root);
}

const DB_METHODS = new Set(['open', 'connect', 'connect_lazy', 'new', 'establish', 'from_str']);

function walkDatabases(root, analysis) {
  function recurse(node) {
    // Look for TypePath::method(...) calls that match DB patterns
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName?.('function');
      if (fn?.type === 'scoped_identifier') {
        const path = fn.childForFieldName?.('path')?.text  || '';
        const name = fn.childForFieldName?.('name')?.text  || '';
        const isDb = DB_METHODS.has(name.toLowerCase()) &&
          /sqlite|postgres|mysql|redis|mongo|sled|rusqlite|diesel|sqlx|sea_orm/i.test(path);
        if (isDb) {
          const args = node.childForFieldName?.('arguments');
          const first = args?.namedChildren?.[0];
          const pathStr = first?.type === 'string_literal'
            ? first.text.slice(1, -1)
            : first?.text || '?';
          analysis.databases.push({
            name: `${path}::${name}`,
            type: 'rust_db',
            path_or_uri: pathStr,
            line: nodeLine(node),
          });
        }
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
    walkImports(rootNode, analysis);
    walkDatabases(rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'rust',
  extensions: ['.rs'],

    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },

  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
    const candidate = path.resolve(path.dirname(fromAbsFile), importPath);
    const tries = [candidate, candidate + '.rs', path.join(candidate, 'mod.rs'), path.join(candidate, 'lib.rs')];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
