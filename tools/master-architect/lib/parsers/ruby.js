/**
 * Ruby parser adapter for master-architect.
 * Detected: modules, classes, methods (def), singleton methods (def self.x)
 * Imports: require, require_relative
 */
import Parser from 'tree-sitter';
import Ruby from 'tree-sitter-ruby';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Ruby);
  return _parser;
}

function nodeLine(n)    { return n.startPosition.row + 1; }
function nodeLineEnd(n) { return n.endPosition.row + 1; }

function walkBody(bodyNode, prefix, analysis) {
  for (const node of bodyNode.namedChildren) {
    switch (node.type) {
      case 'module': {
        const name = node.childForFieldName?.('name')?.text
                  || node.namedChildren?.find(c => c.type === 'constant')?.text || '(module)';
        const fullName = prefix ? `${prefix}::${name}` : name;
        analysis.modules.push({ kind: 'module', name: fullName, line: nodeLine(node), line_end: nodeLineEnd(node) });
        const body = node.childForFieldName?.('body') || node.namedChildren?.find(c => c.type === 'body_statement');
        if (body) walkBody(body, fullName, analysis);
        break;
      }
      case 'class': {
        const nameNode = node.childForFieldName?.('name') || node.namedChildren?.find(c => c.type === 'constant');
        const name = nameNode?.text || '(class)';
        const fullName = prefix ? `${prefix}::${name}` : name;
        analysis.modules.push({ kind: 'class', name: fullName, line: nodeLine(node), line_end: nodeLineEnd(node) });
        const body = node.childForFieldName?.('body') || node.namedChildren?.find(c => c.type === 'body_statement');
        if (body) walkBody(body, fullName, analysis);
        break;
      }
      case 'method': {
        const nameNode = node.childForFieldName?.('name') || node.namedChildren?.find(c => c.type === 'identifier');
        const mname = nameNode?.text || '(method)';
        analysis.modules.push({
          kind: 'method',
          name: prefix ? `${prefix}#${mname}` : mname,
          line: nodeLine(node), line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'singleton_method': {
        // def self.foo — receiver is usually 'self'
        const nameNode = node.childForFieldName?.('name') || node.namedChildren?.find(c => c.type === 'identifier');
        const mname = nameNode?.text || '(singleton)';
        analysis.modules.push({
          kind: 'singleton_method',
          name: prefix ? `${prefix}.${mname}` : mname,
          line: nodeLine(node), line_end: nodeLineEnd(node),
        });
        break;
      }
    }
  }
}

function walkRequires(root, analysis) {
  function recurse(node) {
    if (node.type === 'call') {
      const method = node.childForFieldName?.('method')?.text;
      if (method === 'require' || method === 'require_relative') {
        const args = node.childForFieldName?.('arguments');
        const first = args?.namedChildren?.[0];
        const raw = first?.type === 'string' ? first.text.slice(1, -1) : first?.text || '?';
        analysis.imports.push({ import_path: raw, line: nodeLine(node) });
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
    walkBody(rootNode, '', analysis);
    walkRequires(rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'ruby',
  extensions: ['.rb'],
    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },
  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromAbsFile), importPath);
    for (const t of [base, base + '.rb']) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
