/**
 * PHP parser adapter for master-architect.
 * Detected: classes, interfaces, traits, functions, methods
 * Imports: namespace_definition, use_declaration
 */
import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(PHP.php);
  return _parser;
}

function nodeLine(n)    { return n.startPosition.row + 1; }
function nodeLineEnd(n) { return n.endPosition.row + 1; }
function nameOf(n)      { return n.childForFieldName?.('name')?.text || n.namedChildren?.find(c => c.type === 'name')?.text || '(anonymous)'; }

function walkClassBody(bodyNode, className, analysis) {
  for (const node of bodyNode.namedChildren) {
    if (node.type === 'method_declaration') {
      const mname = nameOf(node);
      analysis.modules.push({
        kind: 'method',
        name: `${className}::${mname}`,
        line: nodeLine(node), line_end: nodeLineEnd(node),
      });
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
    for (const node of rootNode.namedChildren) {
      switch (node.type) {
        case 'namespace_definition': {
          const raw = node.childForFieldName?.('name')?.text || node.namedChildren?.find(c=>c.type==='namespace_name')?.text || '';
          if (raw) analysis.imports.push({ import_path: raw, line: nodeLine(node) });
          break;
        }
        case 'use_declaration': {
          const raw = node.text.replace(/^use\s+/, '').replace(/;$/, '').trim();
          analysis.imports.push({ import_path: raw, line: nodeLine(node) });
          break;
        }
        case 'class_declaration':
        case 'abstract_class_declaration': {
          const name = nameOf(node);
          analysis.modules.push({ kind: 'class', name, line: nodeLine(node), line_end: nodeLineEnd(node) });
          const body = node.namedChildren.find(c => c.type === 'declaration_list');
          if (body) walkClassBody(body, name, analysis);
          break;
        }
        case 'interface_declaration': {
          const name = nameOf(node);
          analysis.modules.push({ kind: 'interface', name, line: nodeLine(node), line_end: nodeLineEnd(node) });
          break;
        }
        case 'trait_declaration': {
          const name = nameOf(node);
          analysis.modules.push({ kind: 'trait', name, line: nodeLine(node), line_end: nodeLineEnd(node) });
          const body = node.namedChildren.find(c => c.type === 'declaration_list');
          if (body) walkClassBody(body, name, analysis);
          break;
        }
        case 'function_definition': {
          analysis.modules.push({ kind: 'function', name: nameOf(node), line: nodeLine(node), line_end: nodeLineEnd(node) });
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
  language: 'php',
  extensions: ['.php'],
    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },
  resolveImport() { return null; },
};
