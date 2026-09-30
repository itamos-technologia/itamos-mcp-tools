/**
 * Swift parser adapter for master-architect.
 * Detected: classes, structs, enums, protocols, functions, methods
 * Note: Swift uses class_declaration for both class and struct
 * Imports: import declarations
 */
import Parser from 'tree-sitter';
import Swift from 'tree-sitter-swift';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Swift);
  return _parser;
}

function nodeLine(n)    { return n.startPosition.row + 1; }
function nodeLineEnd(n) { return n.endPosition.row + 1; }
function nameOf(n)      {
  return n.childForFieldName?.('name')?.text
      || n.namedChildren?.find(c => c.type === 'type_identifier')?.text
      || '(anonymous)';
}

function walkClassBody(bodyNode, className, analysis) {
  for (const node of bodyNode.namedChildren) {
    if (node.type === 'function_declaration') {
      const mname = node.childForFieldName?.('name')?.text
                 || node.namedChildren?.find(c => c.type === 'simple_identifier')?.text
                 || '(func)';
      analysis.modules.push({
        kind: 'method',
        name: `${className}.${mname}`,
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
        case 'import_declaration': {
          const mod = node.namedChildren?.find(c => c.type !== 'import')?.text || node.text.replace(/^import\s+/, '').trim();
          analysis.imports.push({ import_path: mod, line: nodeLine(node) });
          break;
        }
        case 'class_declaration': {
          const name = nameOf(node);
          // Swift uses class_declaration for both class and struct — check keyword
          const kw = node.namedChildren?.find(c => ['class','struct'].includes(c.type));
          const kind = kw?.type === 'struct' ? 'struct' : 'class';
          analysis.modules.push({ kind, name, line: nodeLine(node), line_end: nodeLineEnd(node) });
          const body = node.namedChildren?.find(c => c.type === 'class_body');
          if (body) walkClassBody(body, name, analysis);
          break;
        }
        case 'protocol_declaration': {
          analysis.modules.push({ kind: 'protocol', name: nameOf(node), line: nodeLine(node), line_end: nodeLineEnd(node) });
          break;
        }
        case 'enum_declaration':
        case 'class_declaration': {
          // enum also uses class_declaration in some tree-sitter-swift versions
          if (node.text?.startsWith('enum')) {
            analysis.modules.push({ kind: 'enum', name: nameOf(node), line: nodeLine(node), line_end: nodeLineEnd(node) });
          }
          break;
        }
        case 'function_declaration': {
          const fname = node.childForFieldName?.('name')?.text
                     || node.namedChildren?.find(c => c.type === 'simple_identifier')?.text || '(func)';
          analysis.modules.push({ kind: 'function', name: fname, line: nodeLine(node), line_end: nodeLineEnd(node) });
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
  language: 'swift',
  extensions: ['.swift'],
    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },
  resolveImport() { return null; },
};
