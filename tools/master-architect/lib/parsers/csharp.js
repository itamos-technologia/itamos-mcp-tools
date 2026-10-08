/**
 * C# parser adapter for master-architect.
 * Detected: namespaces, classes, interfaces, enums, methods, constructors, properties
 * Imports: using directives
 */
import Parser from 'tree-sitter';
import CSharp from 'tree-sitter-c-sharp/bindings/node/index.js';

let _parser = null;
function getParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(CSharp);
  return _parser;
}

function nodeLine(n)    { return n.startPosition.row + 1; }
function nodeLineEnd(n) { return n.endPosition.row + 1; }
function nameOf(n)      { const c = n.childForFieldName?.('name') || n.namedChildren?.find(c => c.type === 'identifier'); return c ? c.text : '(anonymous)'; }

function walkDeclarationList(listNode, prefix, analysis) {
  for (const node of listNode.namedChildren) {
    switch (node.type) {
      case 'class_declaration':
      case 'struct_declaration':
      case 'record_declaration': {
        const name = prefix ? `${prefix}.${nameOf(node)}` : nameOf(node);
        const kind = node.type === 'class_declaration' ? 'class'
                   : node.type === 'struct_declaration' ? 'struct' : 'record';
        analysis.modules.push({ kind, name, line: nodeLine(node), line_end: nodeLineEnd(node) });
        const body = node.childForFieldName?.('body') || node.namedChildren?.find(c => c.type === 'declaration_list');
        if (body) walkDeclarationList(body, name, analysis);
        break;
      }
      case 'interface_declaration': {
        const name = prefix ? `${prefix}.${nameOf(node)}` : nameOf(node);
        analysis.modules.push({ kind: 'interface', name, line: nodeLine(node), line_end: nodeLineEnd(node) });
        break;
      }
      case 'enum_declaration': {
        const name = prefix ? `${prefix}.${nameOf(node)}` : nameOf(node);
        analysis.modules.push({ kind: 'enum', name, line: nodeLine(node), line_end: nodeLineEnd(node) });
        break;
      }
      case 'method_declaration':
      case 'constructor_declaration':
      case 'operator_declaration': {
        const mname = node.childForFieldName?.('name')?.text || node.type.replace('_declaration','');
        analysis.modules.push({
          kind: node.type === 'constructor_declaration' ? 'constructor' : 'method',
          name: prefix ? `${prefix}.${mname}` : mname,
          line: nodeLine(node), line_end: nodeLineEnd(node),
        });
        break;
      }
      case 'property_declaration': {
        const pname = node.childForFieldName?.('name')?.text || '(prop)';
        analysis.modules.push({
          kind: 'property',
          name: prefix ? `${prefix}.${pname}` : pname,
          line: nodeLine(node), line_end: nodeLineEnd(node),
        });
        break;
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
    for (const node of rootNode.namedChildren) {
      if (node.type === 'using_directive') {
        const raw = node.text.replace(/^using\s+/, '').replace(/;$/, '').trim();
        analysis.imports.push({ import_path: raw, line: nodeLine(node) });
      } else if (node.type === 'namespace_declaration') {
        const nsName = nameOf(node);
        const body = node.childForFieldName?.('body') || node.namedChildren?.find(c => c.type === 'declaration_list');
        if (body) walkDeclarationList(body, nsName, analysis);
      } else if (['class_declaration','struct_declaration','interface_declaration','enum_declaration'].includes(node.type)) {
        walkDeclarationList({ namedChildren: [node] }, '', analysis);
      }
    }
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'csharp',
  extensions: ['.cs'],
    parseFile(content) {
      return parseWithRootNode(getParser().parse(content).rootNode);
    },
  resolveImport(importPath, fromAbsFile, fs, path) {
    const asPath = importPath.replace(/\./g, '/');
    const base = path.resolve(path.dirname(fromAbsFile), asPath);
    for (const t of [base + '.cs']) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
