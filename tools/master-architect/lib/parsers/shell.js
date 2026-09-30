/**
 * Bash/Shell parser adapter for master-architect.
 * Detected: function definitions (both syntaxes)
 * Imports: source and . commands
 */
import Parser from 'tree-sitter';
import Bash from 'tree-sitter-bash';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Bash);
  return _parser;
}

function nodeLine(n)    { return n.startPosition.row + 1; }
function nodeLineEnd(n) { return n.endPosition.row + 1; }

/**
 * Run analysis walkers over an externally-supplied rootNode (shared parse).
 * parseFile delegates here, so behavior is byte-identical by construction.
 */
export function parseWithRootNode(rootNode) {
  const analysis = { modules: [], imports: [], databases: [], sql_queries: [] };
  try {
    function recurse(node) {
      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName?.('name') || node.namedChildren?.find(c => c.type === 'word');
        analysis.modules.push({
          kind: 'function',
          name: nameNode ? nameNode.text : '(anonymous)',
          line: nodeLine(node), line_end: nodeLineEnd(node),
        });
      } else if (node.type === 'command') {
        // source ./x or . ./x
        const cmd = node.namedChildren?.[0];
        if (cmd?.text === 'source' || cmd?.text === '.') {
          const arg = node.namedChildren?.[1];
          if (arg) analysis.imports.push({ import_path: arg.text, line: nodeLine(node) });
        }
      }
      for (const c of node.namedChildren) recurse(c);
    }
    recurse(rootNode);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'shell',
  extensions: ['.sh', '.bash'],
    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },
  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromAbsFile), importPath);
    for (const t of [base, base + '.sh']) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
