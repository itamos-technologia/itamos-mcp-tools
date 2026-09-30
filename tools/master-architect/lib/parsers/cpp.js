/**
 * C++ parser adapter for master-architect.
 *
 * Extends C with: class_specifier, namespace_definition, template_declaration,
 * and method detection inside class bodies.
 * Reuses C's function_definition and preproc_include patterns.
 */

import Parser from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Cpp);
  return _parser;
}

function nodeLine(node)    { return node.startPosition.row + 1; }
function nodeLineEnd(node) { return node.endPosition.row + 1; }

function findIdent(n) {
  if (!n) return null;
  if (n.type === 'identifier' || n.type === 'destructor_name') return n.text;
  if (n.type === 'qualified_identifier') return n.text; // Foo::bar
  if (n.type === 'function_declarator' || n.type === 'pointer_declarator' || n.type === 'reference_declarator') {
    return findIdent(n.childForFieldName?.('declarator'));
  }
  for (const c of n.namedChildren || []) {
    const r = findIdent(c);
    if (r) return r;
  }
  return null;
}

function funcName(node) {
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
      case 'class_specifier':
      case 'struct_specifier': {
        const nameNode = node.childForFieldName?.('name');
        const className = nameNode ? nameNode.text : '(anonymous)';
        analysis.modules.push({
          kind: node.type === 'class_specifier' ? 'class' : 'struct',
          name: className,
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        // Walk methods inside class body
        const body = node.childForFieldName?.('body');
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === 'function_definition') {
              analysis.modules.push({
                kind: 'method',
                name: `${className}::${funcName(child)}`,
                line: nodeLine(child),
                line_end: nodeLineEnd(child),
              });
            }
          }
        }
        break;
      }
      case 'namespace_definition': {
        const nameNode = node.childForFieldName?.('name');
        analysis.modules.push({
          kind: 'namespace',
          name: nameNode ? nameNode.text : '(anonymous)',
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'template_declaration': {
        // template<...> function or class
        const inner = node.namedChildren?.find(c =>
          c.type === 'function_definition' || c.type === 'class_specifier'
        );
        if (inner) {
          const name = inner.type === 'function_definition'
            ? funcName(inner)
            : inner.childForFieldName?.('name')?.text || '(template)';
          analysis.modules.push({
            kind: 'template',
            name,
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
    }
  }
}

function walkIncludes(root, analysis) {
  for (const node of root.namedChildren) {
    if (node.type === 'preproc_include') {
      const pathNode = node.childForFieldName?.('path') || node.namedChildren?.[0];
      if (pathNode) {
        analysis.imports.push({
          import_path: pathNode.text.replace(/^[<"']|[>"']$/g, ''),
          line: nodeLine(node),
        });
      }
    }
  }
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
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'cpp',
  extensions: ['.cpp', '.hpp', '.cc', '.hh', '.cxx'],

    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },

  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
    const base = path.resolve(path.dirname(fromAbsFile), importPath);
    const tries = [base, base + '.h', base + '.hpp', base + '.cpp', base + '.cc'];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
