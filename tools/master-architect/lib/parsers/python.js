/**
 * Python parser adapter for master-architect.
 *
 * Uses tree-sitter-python for AST extraction.
 *
 * Detected:
 *   modules:  top-level class and function definitions (including async)
 *   methods:  members of classes (regular methods, async, static, classmethod)
 *   imports:  `import X` / `from X import Y` with line numbers
 *   databases: `sqlite3.connect('path')` / `Database('path')` opens
 *
 * Limitations:
 *   - Decorators tracked only by name (e.g., @staticmethod marks kind='static_method'),
 *     not preserved beyond their effect on classification.
 *   - Conditional imports inside if/try blocks captured at their declared line.
 *   - Module-level constants not extracted (would inflate the skeleton).
 */

import Parser from 'tree-sitter';
import PY from 'tree-sitter-python';

let _parser = null;
function getPyParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(PY);
  return _parser;
}

function nodeLine(n)    { return n.startPosition.row + 1; }
function nodeLineEnd(n) { return n.endPosition.row + 1; }

function getName(node) {
  const nameNode = node.childForFieldName?.('name');
  return nameNode ? nameNode.text : '(anonymous)';
}

function decoratorNames(decoratedNode) {
  // decorated_definition has decorator children, then the actual definition
  const names = [];
  for (const child of decoratedNode.namedChildren) {
    if (child.type !== 'decorator') continue;
    // decorator → @ + identifier or attribute
    for (const d of child.namedChildren) {
      if (d.type === 'identifier') names.push(d.text);
      else if (d.type === 'attribute') names.push(d.text);
      else if (d.type === 'call') {
        const fn = d.childForFieldName?.('function');
        if (fn) names.push(fn.text);
      }
    }
  }
  return names;
}

function classifyMethodKind(decorators, isAsync) {
  if (decorators.includes('staticmethod')) return 'static_method';
  if (decorators.includes('classmethod'))  return 'class_method';
  if (decorators.includes('property'))     return 'property';
  if (isAsync)                              return 'async_method';
  return 'method';
}

function walkClassMembers(classNode) {
  const methods = [];
  const body = classNode.childForFieldName?.('body');
  if (!body) return methods;

  for (const child of body.namedChildren) {

    if (child.type === 'function_definition') {
      methods.push({
        name: getName(child),
        kind: 'method',
        line_start: nodeLine(child), line_end: nodeLineEnd(child),
      });
    }
    else if (child.type === 'decorated_definition') {
      const decos = decoratorNames(child);
      const inner = child.namedChildren.find(c => c.type === 'function_definition');
      if (inner) {
        const isAsync = inner.children.some(c => c.type === 'async');
        methods.push({
          name: getName(inner),
          kind: classifyMethodKind(decos, isAsync),
          line_start: nodeLine(child), line_end: nodeLineEnd(child),
        });
      }
    }
  }
  return methods;
}

function walkTopLevel(rootNode, analysis) {
  for (const child of rootNode.namedChildren) {
    let target = child;
    let decos = [];

    if (child.type === 'decorated_definition') {
      decos = decoratorNames(child);
      target = child.namedChildren.find(c =>
        c.type === 'class_definition' || c.type === 'function_definition'
      ) || child;
    }

    if (target.type === 'class_definition') {
      analysis.modules.push({
        name: getName(target), kind: 'class',
        line_start: nodeLine(child), line_end: nodeLineEnd(child),
        methods: walkClassMembers(target),
      });
    }
    else if (target.type === 'function_definition') {
      const isAsync = target.children.some(c => c.type === 'async');
      analysis.modules.push({
        name: getName(target),
        kind: isAsync ? 'async_function' : 'function',
        line_start: nodeLine(child), line_end: nodeLineEnd(child),
        methods: [],
      });
    }
  }
}

function walkImports(rootNode, analysis) {
  function recurse(node) {
    if (node.type === 'import_statement') {
      // `import a, b.c, d`
      for (const n of node.namedChildren) {
        if (n.type === 'dotted_name' || n.type === 'aliased_import') {
          const nameNode = n.type === 'aliased_import'
            ? n.childForFieldName?.('name')
            : n;
          if (nameNode) {
            analysis.imports.push({
              import_path: nameNode.text,
              line: nodeLine(node),
            });
          }
        }
      }
    }
    else if (node.type === 'import_from_statement') {
      // `from X import Y, Z`
      const moduleNameNode = node.childForFieldName?.('module_name');
      if (moduleNameNode) {
        analysis.imports.push({
          import_path: moduleNameNode.text,
          line: nodeLine(node),
        });
      }
    }
    for (const child of node.namedChildren) recurse(child);
  }
  recurse(rootNode);
}

function walkDatabases(rootNode, analysis) {
  // Recognise:
  //   sqlite3.connect('path')             — sqlite3                → type=sqlite
  //   Database('path')                    — better-sqlite3 / sqlite → type=sqlite
  //   sqlite3.Connection('path')          — sqlite3                → type=sqlite
  //   lmdb.open('path', ...)              — lmdb                   → type=lmdb
  //   pymysql.connect(host=, ...)         — PyMySQL                → type=mysql
  //   mysql.connector.connect(host=, ...) — mysql-connector-python → type=mysql
  //   mariadb.connect(host=, ...)         — mariadb-connector-python→ type=mysql
  //   MySQLdb.connect(host, ...)          — mysqlclient            → type=mysql
  //
  // For MySQL/MariaDB (one adapter handles both), keyword args (host=,
  // port=, user=, password=, database=) get extracted from the call. If
  // the user passes a single dict via **kwargs or passes positional args
  // we don't fully recognize, the connection details are partial and the
  // adapter falls back to defaults.
  function recurse(node) {
    if (node.type === 'call') {
      const fnNode  = node.childForFieldName?.('function');
      const argsNode = node.childForFieldName?.('arguments');
      const firstArg = argsNode?.namedChildren?.[0];
      const fnText  = fnNode?.text || '';

      const looksSqlite =
           /(?:^|\.)connect$/.test(fnText) && /sqlite/.test(fnText)
        || /(?:^|\.)Database$/.test(fnText)
        || /(?:^|\.)Connection$/.test(fnText);

      const looksLmdb = /(?:^|\.)lmdb\.open$/.test(fnText) || fnText === 'lmdb.open';

      if ((looksSqlite || looksLmdb) && firstArg?.type === 'string') {
        const raw = firstArg.text;
        const dbPath = raw.slice(raw.startsWith('"""') || raw.startsWith("'''") ? 3 : 1,
                                raw.endsWith('"""')   || raw.endsWith("'''")   ? -3 : -1);
        analysis.databases.push({
          name: dbPath.split('/').filter(Boolean).pop() || dbPath,
          type: looksLmdb ? 'lmdb' : 'sqlite',
          path_or_uri: dbPath,
          line: nodeLine(node),
        });
      }

      // MySQL/MariaDB connection patterns. All are kwarg-based factory
      // calls. We extract literal-value kwargs (host, port, user, password,
      // database) from the argument list for the L3 adapter to use.
      const mysqlMatch =
           /^pymysql\.connect$/.test(fnText)               ? 'pymysql'
         : /^mysql\.connector\.connect$/.test(fnText)      ? 'mysql.connector'
         : /^mariadb\.connect$/.test(fnText)               ? 'mariadb'
         : /^MySQLdb\.connect$/.test(fnText)               ? 'MySQLdb'
         : null;
      if (mysqlMatch && argsNode) {
        const cfg = extractPyKwargConfig(argsNode);
        cfg._driver = mysqlMatch;
        const host = cfg.host || 'localhost';
        const port = cfg.port || 3306;
        // Note the keyword can be 'database' (mysql.connector, mariadb)
        // or 'db' (MySQLdb, pymysql legacy). Accept either.
        const dbname = cfg.database || cfg.db || '<unspecified>';
        const user = cfg.user || '<unspecified>';
        const uri = `mysql://${user}@${host}:${port}/${dbname}`;
        analysis.databases.push({
          name: dbname !== '<unspecified>' ? dbname : `${host}:${port}`,
          type: 'mysql',
          path_or_uri: uri,
          extra: JSON.stringify(cfg),
          line: nodeLine(node),
        });
      }
    }
    for (const child of node.namedChildren) recurse(child);
  }
  recurse(rootNode);
}

// Extract literal-value kwargs from a Python argument list.
// Returns object like {host: 'localhost', port: 3306, user: 'foo', ...}.
// Only handles literal strings and integers — variable references and
// computed values are skipped (those become 'undefined' in the config
// and the adapter falls back to defaults).
function extractPyKwargConfig(argsNode) {
  const out = {};
  for (const arg of argsNode.namedChildren) {
    if (arg.type !== 'keyword_argument') continue;
    const nameNode = arg.childForFieldName?.('name');
    const valNode  = arg.childForFieldName?.('value');
    if (!nameNode || !valNode) continue;
    const key = nameNode.text;
    if (valNode.type === 'string') {
      const raw = valNode.text;
      out[key] = raw.slice(raw.startsWith('"""') || raw.startsWith("'''") ? 3 : 1,
                          raw.endsWith('"""')   || raw.endsWith("'''")   ? -3 : -1);
    } else if (valNode.type === 'integer') {
      const n = parseInt(valNode.text, 10);
      if (!isNaN(n)) out[key] = n;
    }
    // Skip identifiers, attribute accesses, etc. — those are runtime values
  }
  return out;
}


// SQL query string extractor for Python.
//
// Recognised method-call patterns:
//   <obj>.execute(sql[, params])
//       sqlite3, psycopg2, mysql.connector, pyodbc, sqlalchemy
//   <obj>.executemany(sql, list_of_params)
//   <obj>.executescript(sql)         (sqlite3 multi-statement)
//   <obj>.execute(text(sql))         (sqlalchemy text() wrapper, unwrapped)
//
// `execute` in Python is overwhelmingly SQL-related (unlike JS where
// get/run/all overlap with Express, child_process, fetch). The method
// name itself is the signal; no content sniff needed. f-strings and
// other interpolated forms are marked dynamic since their structure
// isn't fully known at scan time.

const PY_SQL_METHOD_NAMES = new Set([
  'execute', 'executemany', 'executescript',
]);

function walkSqlQueries(rootNode, analysis) {
  function recurse(node) {
    if (node.type === 'call') {
      const fnNode = node.childForFieldName?.('function');
      let methodName = null;
      // attribute: <obj>.<method>
      if (fnNode?.type === 'attribute') {
        const children = fnNode.namedChildren || [];
        const last = children[children.length - 1];
        if (last?.type === 'identifier') methodName = last.text;
      }
      if (methodName && PY_SQL_METHOD_NAMES.has(methodName)) {
        const argsNode = node.childForFieldName?.('arguments');
        const firstArg = argsNode?.namedChildren?.[0];
        const captured = extractPythonSqlString(firstArg);
        if (captured) {
          analysis.sql_queries.push({
            method: methodName,
            sql: captured.text,
            dynamic: captured.dynamic,
            line: nodeLine(node),
          });
        }
      }
    }
    for (const child of node.namedChildren) recurse(child);
  }
  recurse(rootNode);
}

// Extract SQL text from various Python string-shaped argument nodes.
// Handles: regular strings, triple-quoted, f-strings (marked dynamic),
// and SQLAlchemy text(...) wrappers. Returns {text, dynamic} or null.
function extractPythonSqlString(node) {
  if (!node) return null;

  if (node.type === 'string') {
    let textParts = '';
    let dynamic = false;
    for (const child of node.namedChildren) {
      if (child.type === 'string_content') {
        textParts += child.text;
      } else if (child.type === 'interpolation') {
        dynamic = true;
        // preserve approximate structure with a placeholder
        textParts += '?';
      }
    }
    if (textParts.length === 0) return null;
    return { text: textParts, dynamic };
  }

  // SQLAlchemy text(...) wrapper: peek inside and recurse
  if (node.type === 'call') {
    const fnNode = node.childForFieldName?.('function');
    if (fnNode?.type === 'identifier' && fnNode.text === 'text') {
      const argsNode = node.childForFieldName?.('arguments');
      const inner = argsNode?.namedChildren?.[0];
      if (inner) return extractPythonSqlString(inner);
    }
  }

  return null;
}


// LMDB sub-database (named DB) reference extractor.
//
// LMDB has no SQL — instead, an env contains named sub-DBs that act like
// tables. Files that work with LMDB call env.open_db(b'name') to get a
// handle on a specific sub-DB. We capture each such reference so L3
// verify can confirm those sub-DBs actually exist in the live LMDB env.
//
// Recognised pattern: any call whose function ends in '.open_db' (handles
// env.open_db, self.env.open_db, etc.) and whose first argument is a
// bytes literal b'...' or a regular string '...'.

function walkLmdbSubDbs(rootNode, analysis) {
  function recurse(node) {
    if (node.type === 'call') {
      const fnNode = node.childForFieldName?.('function');
      const fnText = fnNode?.text || '';
      // Match 'open_db' as the trailing method (after any chain of attributes)
      if (/(?:^|\.)open_db$/.test(fnText)) {
        const argsNode = node.childForFieldName?.('arguments');
        const firstArg = argsNode?.namedChildren?.[0];
        if (firstArg?.type === 'string') {
          // Extract the string content (strips b prefix and quotes naturally)
          let textParts = '';
          for (const child of firstArg.namedChildren) {
            if (child.type === 'string_content') textParts += child.text;
          }
          if (textParts) {
            analysis.lmdb_subdbs.push({
              name: textParts,
              line: nodeLine(node),
            });
          }
        }
      }
    }
    for (const child of node.namedChildren) recurse(child);
  }
  recurse(rootNode);
}

/**
 * Run Python analysis walkers over an externally-supplied rootNode (shared
 * parse from the worker). Mirrors parseFile exactly, including walkLmdbSubDbs.
 */
export function parseWithRootNode(rootNode) {
  const analysis = { modules: [], imports: [], databases: [], sql_queries: [], lmdb_subdbs: [] };
  try {
    walkTopLevel(rootNode, analysis);
    walkImports(rootNode, analysis);
    walkDatabases(rootNode, analysis);
    walkSqlQueries(rootNode, analysis);
    walkLmdbSubDbs(rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'python',
  extensions: ['.py', '.pyw'],

  parseFile(content) {
    const analysis = { modules: [], imports: [], databases: [], sql_queries: [], lmdb_subdbs: [] };
    try {
      const tree = getPyParser().parse(content);
      walkTopLevel(tree.rootNode, analysis);
      walkImports(tree.rootNode, analysis);
      walkDatabases(tree.rootNode, analysis);
      walkSqlQueries(tree.rootNode, analysis);
      walkLmdbSubDbs(tree.rootNode, analysis);
    } catch (err) {
      analysis.parse_error = err.message;
    }
    return analysis;
  },

  /**
   * Resolve a Python import to an absolute path within the project.
   * Returns null for stdlib / third-party packages or unresolvable imports.
   *
   * Tries: relative-to-file (for `from .x import y`), then project-rooted dotted path.
   * Conservative: if it can't find a matching .py file, returns null.
   */
  resolveImport(importPath, fromAbsFile, fs, path, projectRoot) {
    // Heuristic: only try to resolve if it looks like it could be local
    // (starts with . OR matches a directory under projectRoot)
    const fromDir = path.dirname(fromAbsFile);

    if (importPath.startsWith('.')) {
      // Relative import: count leading dots
      let dots = 0;
      while (dots < importPath.length && importPath[dots] === '.') dots++;
      const rest = importPath.slice(dots).replace(/\./g, '/');
      let base = fromDir;
      for (let i = 1; i < dots; i++) base = path.dirname(base);
      const candidate = path.join(base, rest);
      const tries = [
        candidate + '.py',
        path.join(candidate, '__init__.py'),
      ];
      for (const t of tries) {
        try { if (fs.statSync(t).isFile()) return t; } catch {}
      }
      return null;
    }

    if (!projectRoot) return null;

    // Absolute-ish import: try treating it as project-rooted
    const asPath = importPath.replace(/\./g, '/');
    const tries = [
      path.join(projectRoot, asPath + '.py'),
      path.join(projectRoot, asPath, '__init__.py'),
    ];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
