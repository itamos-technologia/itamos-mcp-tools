/**
 * Kotlin parser adapter for master-architect.
 *
 * Detected:
 *   modules:  class_declaration (class, data class, interface, enum class),
 *             object_declaration (singleton objects),
 *             companion_object, function_declaration (top-level + methods)
 *   imports:  import_list entries
 */

import Parser from 'tree-sitter';
import Kotlin from 'tree-sitter-kotlin';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Kotlin);
  return _parser;
}

function nodeLine(n)    { return n.startPosition.row + 1; }
function nodeLineEnd(n) { return n.endPosition.row + 1; }

function nameOf(node) {
  return node.childForFieldName?.('name')?.text
      || node.namedChildren?.find(c => c.type === 'simple_identifier' || c.type === 'type_identifier')?.text
      || '(anonymous)';
}

function classKind(node) {
  // Check modifiers for data, enum, abstract, sealed, interface
  const mods = node.namedChildren?.find(c => c.type === 'modifiers');
  const modText = mods?.text || '';
  if (modText.includes('enum'))   return 'enum';
  if (modText.includes('data'))   return 'data_class';
  if (modText.includes('sealed')) return 'sealed_class';
  // Check if it's actually an interface
  const kw = node.namedChildren?.find(c => c.type === 'interface');
  if (kw) return 'interface';
  return 'class';
}

function walkClassBody(bodyNode, className, analysis) {
  for (const node of bodyNode.namedChildren) {
    if (node.type === 'function_declaration') {
      const name = nameOf(node);
      analysis.modules.push({
        kind: 'method',
        name: `${className}.${name}`,
        line: nodeLine(node), line_end: nodeLineEnd(node),
      });
    } else if (node.type === 'companion_object') {
      analysis.modules.push({
        kind: 'companion_object',
        name: `${className}.Companion`,
        line: nodeLine(node), line_end: nodeLineEnd(node),
      });
      const compBody = node.childForFieldName?.('body') || node.namedChildren?.find(c => c.type === 'class_body');
      if (compBody) walkClassBody(compBody, `${className}.Companion`, analysis);
    } else if (node.type === 'class_declaration') {
      // Inner/nested class
      const innerName = `${className}.${nameOf(node)}`;
      analysis.modules.push({
        kind: classKind(node),
        name: innerName,
        line: nodeLine(node), line_end: nodeLineEnd(node),
      });
    }
  }
}

function walkImports(root, analysis) {
  for (const node of root.namedChildren) {
    if (node.type === 'import_list') {
      for (const imp of node.namedChildren) {
        if (imp.type === 'import_header') {
          const raw = imp.text.replace(/^import\s+/, '').trim();
          analysis.imports.push({ import_path: raw, line: nodeLine(imp) });
        }
      }
    } else if (node.type === 'import_header') {
      const raw = node.text.replace(/^import\s+/, '').trim();
      analysis.imports.push({ import_path: raw, line: nodeLine(node) });
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
    walkImports(rootNode, analysis);
    for (const node of rootNode.namedChildren) {
      switch (node.type) {
        case 'class_declaration': {
          const name = nameOf(node);
          analysis.modules.push({
            kind: classKind(node),
            name,
            line: nodeLine(node), line_end: nodeLineEnd(node),
          });
          const body = node.childForFieldName?.('body') || node.namedChildren?.find(c => c.type === 'class_body');
          if (body) walkClassBody(body, name, analysis);
          break;
        }
        case 'object_declaration': {
          const name = nameOf(node);
          analysis.modules.push({
            kind: 'object',
            name,
            line: nodeLine(node), line_end: nodeLineEnd(node),
          });
          const body = node.namedChildren?.find(c => c.type === 'class_body');
          if (body) walkClassBody(body, name, analysis);
          break;
        }
        case 'function_declaration': {
          analysis.modules.push({
            kind: 'function',
            name: nameOf(node),
            line: nodeLine(node), line_end: nodeLineEnd(node),
          });
          break;
        }
      }
    }
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'kotlin',
  extensions: ['.kt', '.kts'],

    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },

  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromAbsFile), importPath);
    for (const t of [base, base + '.kt']) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
