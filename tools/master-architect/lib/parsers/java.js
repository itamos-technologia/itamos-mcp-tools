/**
 * Java parser adapter for master-architect.
 *
 * Detected:
 *   modules:  class_declaration, interface_declaration, enum_declaration (top-level),
 *             method_declaration inside class/interface bodies
 *   imports:  import_declaration
 *   databases: DriverManager.getConnection, DataSource patterns
 */

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(Java);
  return _parser;
}

function nodeLine(node)    { return node.startPosition.row + 1; }
function nodeLineEnd(node) { return node.endPosition.row + 1; }

function walkClassBody(bodyNode, className, analysis) {
  for (const child of bodyNode.namedChildren) {
    switch (child.type) {
      case 'method_declaration':
      case 'constructor_declaration': {
        const nameNode = child.childForFieldName?.('name');
        analysis.modules.push({
          kind: child.type === 'constructor_declaration' ? 'constructor' : 'method',
          name: `${className}.${nameNode ? nameNode.text : '(anonymous)'}`,
          line: nodeLine(child),
          line_end: nodeLineEnd(child),
        });
        break;
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration': {
        // Inner class — recurse
        const nameNode = child.childForFieldName?.('name');
        const innerName = nameNode ? `${className}.${nameNode.text}` : className;
        const kind = child.type === 'class_declaration' ? 'class'
                   : child.type === 'interface_declaration' ? 'interface' : 'enum';
        analysis.modules.push({
          kind,
          name: innerName,
          line: nodeLine(child),
          line_end: nodeLineEnd(child),
        });
        const innerBody = child.childForFieldName?.('body');
        if (innerBody) walkClassBody(innerBody, innerName, analysis);
        break;
      }
    }
  }
}

function walkTopLevel(root, analysis) {
  for (const node of root.namedChildren) {
    switch (node.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration': {
        const nameNode = node.childForFieldName?.('name');
        const name = nameNode ? nameNode.text : '(anonymous)';
        const kind = node.type === 'class_declaration' ? 'class'
                   : node.type === 'interface_declaration' ? 'interface' : 'enum';
        analysis.modules.push({
          kind,
          name,
          line: nodeLine(node),
          line_end: nodeLineEnd(node),
        });
        const body = node.childForFieldName?.('body');
        if (body) walkClassBody(body, name, analysis);
        break;
      }
    }
  }
}

function walkImports(root, analysis) {
  for (const node of root.namedChildren) {
    if (node.type === 'import_declaration') {
      // import java.util.List; → "java.util.List"
      // strip "import " and ";"
      const raw = node.text.replace(/^import\s+/, '').replace(/;$/, '').replace(/\s/g, '');
      analysis.imports.push({ import_path: raw, line: nodeLine(node) });
    }
  }
}

const JAVA_DB_METHODS = new Set(['getConnection', 'connect', 'open', 'createConnection']);

function walkDatabases(root, analysis) {
  function recurse(node) {
    if (node.type === 'method_invocation') {
      const nameNode = node.childForFieldName?.('name');
      const objNode  = node.childForFieldName?.('object');
      if (nameNode && JAVA_DB_METHODS.has(nameNode.text)) {
        const args = node.childForFieldName?.('arguments');
        const first = args?.namedChildren?.[0];
        const pathStr = first?.type === 'string_literal'
          ? first.text.slice(1, -1) : first?.text || '?';
        analysis.databases.push({
          name: objNode ? `${objNode.text}.${nameNode.text}` : nameNode.text,
          type: 'java_db',
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
    walkImports(rootNode, analysis);
    walkDatabases(rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'java',
  extensions: ['.java'],

    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },

  resolveImport(importPath, fromAbsFile, fs, path) {
    // Java imports are package paths — convert dots to slashes for local resolution
    const asPath = importPath.replace(/\./g, '/');
    const base = path.resolve(path.dirname(fromAbsFile), asPath);
    const tries = [base + '.java', path.resolve(fromAbsFile, '..', '..', asPath + '.java')];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
