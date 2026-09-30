/**
 * JavaScript / JSX parser adapter for master-architect.
 *
 * Uses tree-sitter-javascript for accurate AST extraction. Returns a
 * normalised analysis object that scan.js then writes into the DB.
 *
 * Detected:
 *   modules:  top-level class declarations and function/arrow-function declarations
 *             (also top-level `const X = function(...)` and `const X = () => {}`)
 *   methods:  members of classes (methods, getters, setters, static)
 *   imports:  `import ... from 'X'` and `require('X')` with line numbers
 *   databases: `new Database('path')`, `sqlite3.Database('path')`, similar opens
 *
 * Notes / known limitations:
 *   - Re-exports (`export { foo } from './x'`) currently captured as imports.
 *   - Dynamic `import('x')` not captured (rare in production source).
 *   - JSX components (capitalised function declarations) appear as functions; no
 *     special "component" classification yet.
 */

import Parser from 'tree-sitter';
import JS from 'tree-sitter-javascript';

let _parser = null;
function getJsParser() {
  if (_parser) return _parser;
  _parser = new Parser();
  _parser.setLanguage(JS);
  return _parser;
}

function nodeLine(node) {
  return node.startPosition.row + 1;
}
function nodeLineEnd(node) {
  return node.endPosition.row + 1;
}

function extractName(node) {
  // Try common name-bearing children
  const nameNode = node.childForFieldName?.('name');
  if (nameNode) return nameNode.text;
  for (const child of node.namedChildren || []) {
    if (child.type === 'identifier' || child.type === 'property_identifier') {
      return child.text;
    }
  }
  return '(anonymous)';
}

function walkClassMembers(classNode) {
  const methods = [];
  const body = classNode.childForFieldName?.('body');
  if (!body) return methods;
  for (const child of body.namedChildren) {
    if (child.type === 'method_definition') {
      const isStatic = child.children.some(c => c.type === 'static');
      methods.push({
        name: extractName(child),
        kind: isStatic ? 'static_method' : 'method',
        line_start: nodeLine(child),
        line_end:   nodeLineEnd(child),
      });
    } else if (child.type === 'field_definition') {
      methods.push({
        name: extractName(child),
        kind: 'field',
        line_start: nodeLine(child),
        line_end:   nodeLineEnd(child),
      });
    }
  }
  return methods;
}

function walkTopLevel(rootNode, analysis) {
  for (const child of rootNode.namedChildren) {
    switch (child.type) {

      case 'class_declaration': {
        const name = extractName(child);
        analysis.modules.push({
          name, kind: 'class',
          line_start: nodeLine(child), line_end: nodeLineEnd(child),
          methods: walkClassMembers(child),
        });
        break;
      }

      case 'function_declaration':
      case 'generator_function_declaration': {
        analysis.modules.push({
          name: extractName(child), kind: 'function',
          line_start: nodeLine(child), line_end: nodeLineEnd(child),
          methods: [],
        });
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        // const/let/var X = function(...) { ... }  OR  X = (...) => ...
        for (const declarator of child.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const nameNode = declarator.childForFieldName?.('name');
          const valueNode = declarator.childForFieldName?.('value');
          if (!nameNode || !valueNode) continue;
          if (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression') {
            analysis.modules.push({
              name: nameNode.text,
              kind: valueNode.type === 'arrow_function' ? 'arrow_function' : 'function',
              line_start: nodeLine(child), line_end: nodeLineEnd(child),
              methods: [],
            });
          } else if (valueNode.type === 'class_expression') {
            analysis.modules.push({
              name: nameNode.text, kind: 'class',
              line_start: nodeLine(child), line_end: nodeLineEnd(child),
              methods: walkClassMembers(valueNode),
            });
          }
        }
        break;
      }

      case 'export_statement': {
        // recurse into the inner declaration
        for (const inner of child.namedChildren) {
          if (['class_declaration', 'function_declaration',
               'lexical_declaration', 'variable_declaration'].includes(inner.type)) {
            walkTopLevel({ namedChildren: [inner] }, analysis);
          }
        }
        // Also catch `export { foo } from './x'` as an import
        const sourceNode = child.childForFieldName?.('source');
        if (sourceNode) {
          analysis.imports.push({
            import_path: sourceNode.text.slice(1, -1), // strip quotes
            line: nodeLine(child),
          });
        }
        break;
      }
    }
  }
}

function walkImports(rootNode, content, analysis) {
  // import_statement: import X from 'Y'   /   import { X } from 'Y'
  function recurse(node) {
    if (node.type === 'import_statement') {
      const sourceNode = node.childForFieldName?.('source');
      if (sourceNode) {
        analysis.imports.push({
          import_path: sourceNode.text.slice(1, -1),
          line: nodeLine(node),
        });
      }
    }
    if (node.type === 'call_expression') {
      const fnNode = node.childForFieldName?.('function');
      if (fnNode?.text === 'require') {
        const argsNode = node.childForFieldName?.('arguments');
        const firstArg = argsNode?.namedChildren?.[0];
        if (firstArg?.type === 'string') {
          analysis.imports.push({
            import_path: firstArg.text.slice(1, -1),
            line: nodeLine(node),
          });
        }
      }
    }
    for (const child of node.namedChildren) recurse(child);
  }
  recurse(rootNode);
}
// DYNAMIC PLUGIN-LOAD DETECTION.
// Modular servers load tools by directory convention, not by static import:
//   const dir = path.join(__dirname, 'mcp_tools');
//   const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
//   for (const file of files) await import(pathToFileURL(path.join(dir,file)).href);
// There is NO static import edge, so the loaded tools look disconnected. This
// walk detects the anchor — a readdirSync(X) result filtered to a JS extension —
// and records the directory expression X plus the extension filter. The scan's
// second pass resolves X to a real directory (relative to the loader file) and
// emits a 'loads' edge to every matching real file it finds there. If X cannot
// be resolved statically, the scan emits nothing (honest, no guess).
//
// Emits into analysis.dynamic_loads: { dir_expr, ext, line }
//   dir_expr : source text of the directory argument to readdirSync, e.g.
//              "path.join(__dirname, 'mcp_tools')" or "dir" (a variable, which
//              the scan resolves via the same value-tracing used elsewhere) or
//              a string literal.
//   ext      : the extension the filter restricts to ('.js', '.mjs', ...), or
//              null if a filter is present but the extension isn't a plain
//              endsWith literal (scan then takes all files).
function walkDynamicLoads(rootNode, analysis) {
  function recurse(node) {
    // anchor: a call expression whose function is `<something>.readdirSync`
    // or bare `readdirSync`.
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName?.('function');
      const fnText = fn?.text || '';
      const isReaddir = /(?:^|\.)readdirSync$/.test(fnText) || /(?:^|\.)readdir$/.test(fnText);
      if (isReaddir) {
        const args = node.childForFieldName?.('arguments');
        const dirArg = args?.namedChildren?.[0];
        if (dirArg) {
          // The readdir result is typically immediately .filter(...)'d. Walk UP
          // to find an enclosing member call chain and capture the extension
          // restriction if it is an endsWith('.ext') / endsWith(".ext") literal
          // or a /\.ext$/ regex.
          let ext = null;
          let p = node.parent;
          let hops = 0;
          let chainText = '';
          while (p && hops < 6) {
            chainText = p.text || '';
            const m = chainText.match(/endsWith\(\s*['"](\.[A-Za-z0-9]+)['"]\s*\)/)
                   || chainText.match(/\/\\\.([A-Za-z0-9]+)\$\//)
                   || chainText.match(/\.([A-Za-z0-9]+)['"]\s*\)\s*$/);
            if (m) { ext = m[1].startsWith('.') ? m[1] : ('.' + m[1]); break; }
            p = p.parent; hops += 1;
          }
          // Resolve the dir expression. If readdir's argument is a plain
          // identifier (e.g. `dir`), trace it to its `const dir = <value>`
          // assignment anywhere in the file and use that value instead, so the
          // scan receives the real path expression (e.g.
          // `path.join(__dirname, 'mcp_tools')`) rather than a bare variable it
          // cannot resolve. Literal/`path.join(...)` arguments pass through as-is.
          let dirExpr = (dirArg.text || '').slice(0, 200);
          if (dirArg.type === 'identifier') {
            const resolved = resolveVarValue(rootNode, dirArg.text);
            if (resolved) dirExpr = resolved.slice(0, 200);
          }
          analysis.dynamic_loads.push({
            dir_expr: dirExpr,
            ext: ext,
            line: nodeLine(node),
          });
        }
      }
    }
    for (const child of node.namedChildren) recurse(child);
  }

  // Find `const|let|var <name> = <value>` anywhere under root and return the
  // source text of <value>. First match wins (loaders define the dir once).
  // Returns null if not found.
  function resolveVarValue(root, name) {
    let found = null;
    (function scan(n) {
      if (found) return;
      if (n.type === 'variable_declarator') {
        const nm = n.childForFieldName?.('name');
        const val = n.childForFieldName?.('value');
        if (nm && val && nm.text === name) { found = val.text; return; }
      }
      for (const c of n.namedChildren) scan(c);
    })(root);
    return found;
  }
  recurse(rootNode);
}
// HTTP LISTENER DETECTION.
// A file that binds a network port is a SERVER endpoint — the thing the
// outside world (or a reverse proxy like nginx) connects TO. Detecting these
// lets the graph link an nginx `upstream 127.0.0.1:8200` to the actual code
// file that listens on :8200, completing the internet -> nginx -> code chain.
//
// Matched idioms:
//   app.listen(PORT, '127.0.0.1', cb)      (Express)
//   server.listen(3000)                    (http.Server)
//   http.createServer(...).listen(PORT)    (chained)
//   new HTTPServer(...).listen(port)
// The port argument is frequently a variable:
//   const PORT = process.env.MCP_PORT || 3101;  app.listen(PORT, ...)
// so we resolve an identifier port through resolveVarValue and then pull a
// numeric literal out of the resolved expression — including the `||` fallback
// of a `process.env.X || NNNN` idiom. When no literal can be found (port is
// purely env-driven with no fallback), we emit the listener with port=null
// rather than guessing — honest unknown.
//
// Emits into analysis.listeners: { port, host, line, port_expr }
//   port      : integer port if statically resolvable, else null
//   host      : '127.0.0.1' / '0.0.0.0' if a string-literal host arg is present,
//               else null (Express defaults to 0.0.0.0 but we don't assume)
//   port_expr : the raw port argument text (for diagnostics / honest display)
function walkListeners(rootNode, analysis) {
  // Pull the first integer literal out of an expression's source text. For
  // `process.env.MCP_PORT || 3101` this returns 3101; for `3000` returns 3000.
  // Ignores numbers that are part of an identifier (e.g. won't grab the 6 from
  // `ipv6`). Returns null if none.
  function literalPort(text) {
    if (!text) return null;
    // Prefer an explicit `|| NNNN` fallback if present (the conventional default).
    const fb = text.match(/\|\|\s*(\d{2,5})\b/);
    if (fb) return Number(fb[1]);
    const m = text.match(/(?:^|[^\w.])(\d{2,5})\b/);
    return m ? Number(m[1]) : null;
  }
  function resolveVarValue(root, name) {
    let found = null;
    (function scan(n) {
      if (found) return;
      if (n.type === 'variable_declarator') {
        const nm = n.childForFieldName?.('name');
        const val = n.childForFieldName?.('value');
        if (nm && val && nm.text === name) { found = val.text; return; }
      }
      for (const c of n.namedChildren) scan(c);
    })(root);
    return found;
  }
  function recurse(node) {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName?.('function');
      const fnText = fn?.text || '';
      // a `.listen(...)` call (app.listen, server.listen, createServer().listen)
      if (/(?:^|\.)listen$/.test(fnText)) {
        const args = node.childForFieldName?.('arguments');
        const portArg = args?.namedChildren?.[0];
        const hostArg = args?.namedChildren?.[1];
        if (portArg) {
          let portExpr = (portArg.text || '').slice(0, 120);
          let resolvedExpr = portExpr;
          if (portArg.type === 'identifier') {
            const rv = resolveVarValue(rootNode, portArg.text);
            if (rv) resolvedExpr = rv;
          }
          const port = literalPort(resolvedExpr);
          let host = null;
          if (hostArg && (hostArg.type === 'string')) {
            host = (hostArg.text || '').replace(/^['"]|['"]$/g, '');
          }
          analysis.listeners.push({
            port: port,
            host: host,
            line: nodeLine(node),
            port_expr: portExpr,
          });
        }
      }
    }
    for (const child of node.namedChildren) recurse(child);
  }
  recurse(rootNode);
}



function walkDatabases(rootNode, analysis) {
  // Recognise:
  //   new Database('path')              — better-sqlite3 / sqlite3 → type=sqlite
  //   new sqlite3.Database('path')      — sqlite3                  → type=sqlite
  //   new Pool({...config...})          — pg                       → type=postgres
  //   new Client({...config...})        — pg                       → type=postgres
  //   new pg.Pool({...config...})       — pg                       → type=postgres
  //   mysql.createConnection({...})     — mysql/mysql2 driver       → type=mysql
  //   mysql.createPool({...})           — mysql/mysql2 driver       → type=mysql
  //   mysql2.createConnection({...})    — mysql2 driver             → type=mysql
  //   mysql2.createPool({...})          — mysql2 driver             → type=mysql
  //   mariadb.createConnection({...})   — mariadb-connector-nodejs  → type=mysql (one adapter)
  //   mariadb.createPool({...})         — mariadb-connector-nodejs  → type=mysql
  //
  // For network DBs (postgres, mysql) we extract host/port/database/user/
  // password from the literal config object so the L3 adapter can connect.
  // If config is a variable or uses env vars, the connection details are
  // null and the adapter falls back to env-var defaults.
  //
  // Note: MariaDB and MySQL share the same wire protocol and PREPARE
  // syntax; one adapter handles both. driver name preserved in extra.
  function recurse(node) {
    // new-expression patterns: SQLite, Postgres
    if (node.type === 'new_expression') {
      const ctor = node.childForFieldName?.('constructor');
      const argsNode = node.childForFieldName?.('arguments');
      const firstArg = argsNode?.namedChildren?.[0];
      const ctorName = ctor?.text || '';

      // Resolve the variable this `new X(...)` is assigned to, so queries can be
      // linked to the specific handle later. Walk up: new_expression →
      // variable_declarator (`const db = new ...`) or assignment_expression
      // (`db = new ...`). Returns the identifier text, or null when the handle
      // isn't bound to a simple name (e.g. `return new Database(...)`).
      const handleVar = (() => {
        let p = node.parent;
        // skip an enclosing `await`/parenthesis if present
        while (p && (p.type === 'await_expression' || p.type === 'parenthesized_expression')) p = p.parent;
        if (p?.type === 'variable_declarator') {
          return p.childForFieldName?.('name')?.text || null;
        }
        if (p?.type === 'assignment_expression') {
          return p.childForFieldName?.('left')?.text || null;
        }
        return null;
      })();

      // Capture a readonly flag from the options object, when present:
      // `new Database(path, { readonly: true })`. A readonly connection is an
      // INPUT by definition; recorded so direction logic can treat it as
      // authoritative regardless of nearby query attribution.
      const optsArg = argsNode?.namedChildren?.[1];
      let readonly = false;
      if (optsArg?.type === 'object') {
        const t = optsArg.text || '';
        readonly = /\breadonly\s*:\s*true\b/.test(t);
      }

      // SQLite — better-sqlite3 / sqlite3 `new Database(...)` / `new sqlite3.Database(...)`.
      // The path argument is frequently NOT a string literal — it is commonly a
      // variable or computed expression (e.g. `new Database(DB_PATH)`,
      // `new Database(path.join(home, 'x.db'))`). Detecting only string-literal
      // args silently dropped those connections, so the DB never registered.
      // Now: register on ANY first argument.
      //   - string literal  → capture the literal path (resolved, as before).
      //   - identifier/expr → register with the SOURCE TEXT as the name and mark
      //                       the path dynamic (path_or_uri = `dynamic:<expr>`),
      //                       so the DB is visible and its origin is named rather
      //                       than guessed. A later value-resolver can resolve it.
      // handle_var (the variable the connection is bound to) is recorded on every
      // SQLite DB so the scan can attribute each SQL query to the RIGHT handle
      // instead of "first DB wins".
      if (/(?:^|\.)Database$/.test(ctorName) && firstArg) {
        if (firstArg.type === 'string') {
          const dbPath = firstArg.text.slice(1, -1);
          analysis.databases.push({
            name: dbPath.split('/').pop() || dbPath,
            type: 'sqlite',
            path_or_uri: dbPath,
            handle_var: handleVar,
            extra: JSON.stringify({ handle_var: handleVar, readonly }),
            line: nodeLine(node),
          });
        } else {
          // Non-literal argument: keep the DB visible, name it after the
          // expression that supplies the path, and flag it as unresolved.
          const expr = (firstArg.text || '').slice(0, 120);
          analysis.databases.push({
            name: expr || '<dynamic>',
            type: 'sqlite',
            path_or_uri: `dynamic:${expr}`,
            handle_var: handleVar,
            extra: JSON.stringify({ path_source: expr, path_resolved: false, arg_kind: firstArg.type, handle_var: handleVar, readonly }),
            line: nodeLine(node),
          });
        }
      }

      // Postgres — Pool/Client with config object
      const isPgCtor = /(?:^|\.)(Pool|Client)$/.test(ctorName);
      if (isPgCtor && firstArg?.type === 'object') {
        const cfg = extractPgObjectConfig(firstArg);
        const host = cfg.host || 'localhost';
        const port = cfg.port || 5432;
        const dbname = cfg.database || cfg.dbname || '<unspecified>';
        const user = cfg.user || '<unspecified>';
        const uri = `postgres://${user}@${host}:${port}/${dbname}`;
        cfg.handle_var = handleVar;
        analysis.databases.push({
          name: cfg.database || cfg.dbname || `${host}:${port}`,
          type: 'postgres',
          path_or_uri: uri,
          handle_var: handleVar,
          extra: JSON.stringify(cfg),
          line: nodeLine(node),
        });
      }
    }

    // call-expression patterns: MySQL/MariaDB factory functions
    if (node.type === 'call_expression') {
      const fnNode = node.childForFieldName?.('function');
      const argsNode = node.childForFieldName?.('arguments');
      const firstArg = argsNode?.namedChildren?.[0];
      const fnText = fnNode?.text || '';

      // mysql / mysql2 / mariadb factories — match "<driver>.<factory>"
      // where driver is one of mysql, mysql2, mariadb and factory is
      // createConnection or createPool. Use a single regex to keep this
      // tight and easy to extend later.
      const mysqlFactoryMatch = /^(mysql|mysql2|mariadb)\.(createConnection|createPool)$/.exec(fnText);
      if (mysqlFactoryMatch && firstArg?.type === 'object') {
        const driverName = mysqlFactoryMatch[1];
        const cfg = extractPgObjectConfig(firstArg);   // same shape: host, port, user, password, database
        cfg._driver = driverName;
        const host = cfg.host || 'localhost';
        const port = cfg.port || 3306;
        const dbname = cfg.database || '<unspecified>';
        const user = cfg.user || '<unspecified>';
        const uri = `mysql://${user}@${host}:${port}/${dbname}`;
        analysis.databases.push({
          name: cfg.database || `${host}:${port}`,
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

// Extract { host, port, database, user, password } from a JS object literal
// node as it appears in `new Pool({...})`. Only literal values (strings/
// numbers) are extractable. Variable references and computed values are
// skipped — the adapter will fall back to env-var defaults for missing fields.
function extractPgObjectConfig(objectNode) {
  const out = {};
  for (const pair of objectNode.namedChildren) {
    if (pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName?.('key');
    const valNode = pair.childForFieldName?.('value');
    if (!keyNode || !valNode) continue;
    const key = keyNode.type === 'property_identifier' || keyNode.type === 'identifier'
      ? keyNode.text
      : keyNode.type === 'string' ? keyNode.text.slice(1, -1) : null;
    if (!key) continue;
    if (valNode.type === 'string') {
      out[key] = valNode.text.slice(1, -1);
    } else if (valNode.type === 'number') {
      const n = parseInt(valNode.text, 10);
      if (!isNaN(n)) out[key] = n;
    }
    // Skip everything else (member_expression, identifier refs, etc.)
  }
  return out;
}


// SQL query string extractor.
//
// Heuristic: any string literal passed as the first arg to a method call
// matching the better-sqlite3 / common SQL-client surface (prepare, exec,
// run, query, get, all, iterate, executeSync). Captures the SQL text plus
// the line of the call. Template literals with NO interpolations are
// treated as static strings and captured; templates WITH interpolations
// are recorded with dynamic=true so the L3 check can skip them gracefully
// (we can't EXPLAIN a query whose structure isn't fully known).
//
// We do NOT try to identify which database the query runs against here —
// that's done at the architect-storage layer where we already track the
// (file, db) connection from walkDatabases.

const SQL_METHOD_NAMES = new Set([
  'prepare', 'exec', 'run', 'query', 'get', 'all', 'iterate', 'executeSync',
  'execute',
]);

const SQL_VERB_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|WITH|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH|EXPLAIN|REINDEX|ANALYZE)\b/i;

// Sniff a string to decide if it's actually SQL. Only strings that begin with
// a SQL keyword (after whitespace and SQL comments) are kept. This rejects
// Express routes ('/health'), shell commands ('ls -la'), file paths, etc.
function looksLikeSql(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length < 6) return false;   // shortest meaningful: 'BEGIN' / 'VACUUM'
  return SQL_VERB_RE.test(text);
}

function walkSqlQueries(rootNode, analysis) {
  function recurse(node) {
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName?.('function');
      let methodName = null;
      let receiver = null;
      if (fn?.type === 'member_expression') {
        const prop = fn.childForFieldName?.('property');
        methodName = prop?.text || null;
        // The OBJECT the SQL method is called on (e.g. `dbPath` in
        // `dbPath.prepare(...)`). This is the join key that links a query to the
        // specific DB handle it runs against. For plain identifiers it is the
        // handle variable name; for indirection (`this.db`, `getDb()`) it is the
        // source text, which simply won't match a handle var and falls back to
        // the scan's heuristic — honest by construction.
        receiver = fn.childForFieldName?.('object')?.text || null;
      }
      if (methodName && SQL_METHOD_NAMES.has(methodName)) {
        const argsNode = node.childForFieldName?.('arguments');
        const firstArg = argsNode?.namedChildren?.[0];
        const captured = extractSqlString(firstArg);
        if (captured) {
          // Method-based filter:
          //   - prepare/exec/executeSync: unambiguously SQL methods (better-sqlite3,
          //     pg, mysql2, etc.). Capture the string verbatim and let the live DB
          //     be the judge. This catches typos in SQL keywords ('SELEKT') that
          //     a content sniff would reject as not-SQL.
          //   - get/run/all/iterate/query: ambiguous — also used by Express,
          //     child_process, fetch, redis, knex, etc. Only capture if the
          //     string content sniffs as SQL.
          const unambiguouslySql = (
            methodName === 'prepare' || methodName === 'exec' || methodName === 'executeSync'
          );
          if (!unambiguouslySql && !captured.dynamic && !looksLikeSql(captured.text)) {
            // ambiguous method + non-dynamic + not-SQL-looking → skip (e.g., app.get('/health'))
            for (const child of node.namedChildren) recurse(child);
            return;
          }
          if (!unambiguouslySql && captured.dynamic) {
            // ambiguous method + dynamic template → can't tell, skip to avoid false captures
            for (const child of node.namedChildren) recurse(child);
            return;
          }
          analysis.sql_queries.push({
            method: methodName,
            sql: captured.text,
            dynamic: captured.dynamic,
            receiver,
            line: nodeLine(node),
          });
        }
      }
    }
    function advance() { /* fall through to children */ }
    for (const child of node.namedChildren) recurse(child);
  }
  recurse(rootNode);
}

function extractSqlString(node) {
  if (!node) return null;
  if (node.type === 'string') {
    // Single/double-quoted string. Strip the quotes.
    const raw = node.text;
    if (raw.length >= 2) {
      return { text: raw.slice(1, -1), dynamic: false };
    }
    return null;
  }
  if (node.type === 'template_string') {
    // Backtick template. If there are no template_substitution children,
    // it's effectively static.
    let hasInterpolation = false;
    for (const child of node.namedChildren) {
      if (child.type === 'template_substitution') {
        hasInterpolation = true;
        break;
      }
    }
    if (hasInterpolation) {
      return { text: node.text, dynamic: true };
    }
    // No interpolations: drop the backticks
    return { text: node.text.slice(1, -1), dynamic: false };
  }
  return null;
}

// Named exports for reuse by other JS-shaped languages (typescript, etc.)
// The walks operate on tree-sitter AST nodes, which TypeScript's grammar
// produces with the same shape for the constructs we care about
// (new_expression, call_expression, member_expression, string, object, etc.).
export { walkTopLevel, walkImports, walkDatabases, walkSqlQueries, walkDynamicLoads, walkListeners };

/**
 * Parse JS/TS-shaped content using a caller-supplied tree-sitter Parser.
 * The parser must already have setLanguage() called with the appropriate
 * grammar (tree-sitter-javascript for JS, tree-sitter-typescript for TS).
 *
 * Returns the standard analysis shape: { modules, imports, databases, sql_queries, dynamic_loads, parse_error? }
 *
 * Used by typescript.js to share all walk logic with javascript.js without
 * duplication. The only thing that differs between JS and TS parsing is
 * which grammar gets loaded; the walk logic is identical because both
 * languages produce ASTs with the same node types for the constructs we
 * care about.
 */
export function parseWithParser(parser, content) {
  const analysis = { modules: [], imports: [], databases: [], sql_queries: [], dynamic_loads: [], listeners: [] };
  try {
    const tree = parser.parse(content);
    walkTopLevel(tree.rootNode, analysis);
    walkImports(tree.rootNode, content, analysis);
    walkDatabases(tree.rootNode, analysis);
    walkSqlQueries(tree.rootNode, analysis);
    walkDynamicLoads(tree.rootNode, analysis);
    walkListeners(tree.rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

/**
 * Run the analysis walkers over an EXTERNALLY-supplied tree-sitter rootNode
 * (e.g. from the shared worker segmenter, which already parsed the file once).
 * This is the "one parse, many projections" hook: identical output to
 * parseWithParser, but it reuses a tree that was already produced instead of
 * parsing again.
 */
export function parseWithRootNode(rootNode, content) {
  const analysis = { modules: [], imports: [], databases: [], sql_queries: [], dynamic_loads: [], listeners: [] };
  try {
    walkTopLevel(rootNode, analysis);
    walkImports(rootNode, content, analysis);
    walkDatabases(rootNode, analysis);
    walkSqlQueries(rootNode, analysis);
    walkDynamicLoads(rootNode, analysis);
    walkListeners(rootNode, analysis);
  } catch (err) {
    analysis.parse_error = err.message;
  }
  return analysis;
}

export default {
  language: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'],

  /**
   * Parse a JavaScript file's content.
   * @param {string} content
   * @returns {{ modules, imports, databases, parse_error?: string }}
   */
  parseFile(content) {
    return parseWithParser(getJsParser(), content);
  },

  /**
   * Resolve a relative import path to an absolute filesystem path.
   * Returns null if the import is external (npm package, etc.) or unresolvable.
   *
   * Tries common JS resolution: bare path, +.js, +.mjs, +.cjs, +.jsx, +/index.js
   */
  resolveImport(importPath, fromAbsFile, fs, path) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null; // external pkg
    const baseDir = path.dirname(fromAbsFile);
    const candidate = path.resolve(baseDir, importPath);
    const tries = [
      candidate,
      candidate + '.js', candidate + '.mjs', candidate + '.cjs', candidate + '.jsx',
      path.join(candidate, 'index.js'),
      path.join(candidate, 'index.mjs'),
    ];
    for (const t of tries) {
      try { if (fs.statSync(t).isFile()) return t; } catch {}
    }
    return null;
  },
};
