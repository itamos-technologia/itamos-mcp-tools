/**
 * SQLite L3 adapter — SHIPPED.
 *
 * What this adapter does:
 *   For each SQL query a file declares (extracted by the parser at scan
 *   time, stored in master-architect's `sql_queries` table), opens the
 *   linked SQLite DB read-only and validates via prepare(). Schema
 *   mismatches, missing tables/columns, and syntax errors all surface
 *   with the engine's exact error message.
 *
 * Diagnostics:
 *   On success, captures EXPLAIN QUERY PLAN to surface tables touched
 *   and (when ANALYZE has been run) estimated row counts.
 *
 * Schema-only by design — never reads or modifies row data.
 *
 * See _contract.js for the adapter interface specification.
 */

import path from 'path';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { recordPair } from '../../bug_recorder/index.js';

export const type = 'sqlite';
export const implemented = true;
export const description = 'SQLite query validation via prepare() + EXPLAIN QUERY PLAN diagnostics';
export const driverHint = 'better-sqlite3 (already required by parent)';

export async function check(absPath, db) {
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) {
    return { ok: true, checked: 0, note: 'file not in any project' };
  }

  // Pull SQLite-targeted queries (excludes postgres, mysql, etc.).
  // Also pulls queries with no inferred DB (those need to surface as
  // failures since strict mode treats unverifiable as failure).
  const queries = db.prepare(`
    SELECT sq.id, sq.line, sq.method, sq.sql,
           d.name AS db_name, d.path_or_uri AS db_path, d.type AS db_type
    FROM sql_queries sq
    LEFT JOIN databases d ON sq.inferred_database_id = d.id
    WHERE sq.file_id = ? AND sq.is_dynamic = 0
      AND (d.type IS NULL OR d.type = 'sqlite')
    ORDER BY sq.line
  `).all(fileRow.id);

  if (queries.length === 0) {
    return { ok: true, checked: 0, note: 'no static SQL queries to verify' };
  }

  // Group by target DB so each connection opens at most once
  const byDb = new Map();
  for (const q of queries) {
    const key = q.db_path || '__no_db_inferred__';
    if (!byDb.has(key)) byDb.set(key, { db_path: q.db_path, db_name: q.db_name, db_type: q.db_type, queries: [] });
    byDb.get(key).queries.push(q);
  }

  const failures = [];
  const diagnostics = [];
  let checked = 0;

  for (const [, group] of byDb) {
    if (!group.db_path) {
      // Strict mode: queries without an inferred DB cannot be verified.
      // Not a recordable bug pair — architecture limitation, not user code.
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: '(none inferred)',
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: 'no database inferred for this query — architect could not determine which DB this query targets',
        });
      }
      continue;
    }
    if (!existsSync(group.db_path)) {
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: group.db_name,
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: `database file does not exist at ${group.db_path}`,
        });
      }
      continue;
    }

    let liveDb;
    try {
      liveDb = new Database(group.db_path, { readonly: true, fileMustExist: true });
    } catch (err) {
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: group.db_name,
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: `cannot open database for verification: ${err.message}`,
        });
      }
      continue;
    }

    const dbDiagnostics = {
      db: group.db_name,
      path: group.db_path,
      tables_in_db: [],
      queries: [],
    };

    // Schema extracted ONCE per DB-open. Used by both the dispatcher's
    // diagnostics output (tables_in_db) AND the bug-pair recorder
    // (schema_compact + schema_full). No second pass needed.
    let schemaCompact = {};
    let schemaFull = '';

    try {
      try {
        const tableRows = liveDb.prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).all();
        for (const t of tableRows) {
          dbDiagnostics.tables_in_db.push(t.name);
          // Skip sqlite-internal tables for the bug-pair schema
          if (t.name.startsWith('sqlite_')) continue;
          try {
            const cols = liveDb.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all().map(c => c.name);
            schemaCompact[t.name] = cols;
          } catch {}
          if (t.sql) schemaFull += t.sql.trim() + ';\n';
        }
      } catch {}

      for (const q of group.queries) {
        const result = explainAgainstSqlite(liveDb, q.sql);
        checked += 1;
        if (!result.ok) {
          failures.push({
            line: q.line,
            method: q.method,
            db: group.db_name,
            sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
            error: result.error,
          });
          // Record the (query, schema, error) pair from already-extracted
          // schema. Fire-and-forget — never throws, never blocks.
          try {
            recordPair({
              adapter_type: 'sqlite',
              query: q.sql,
              schema_compact: schemaCompact,
              schema_full: schemaFull,
              error: result.error,
            });
          } catch {}
        } else {
          dbDiagnostics.queries.push({
            line: q.line,
            method: q.method,
            sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
            tables_touched: result.tables_touched,
            estimated_rows: result.total_estimated_rows,
            plan_steps: result.plan_steps,
          });
        }
      }
    } finally {
      try { liveDb.close(); } catch {}
    }

    diagnostics.push(dbDiagnostics);
  }

  return {
    ok: failures.length === 0,
    checked,
    failures,
    diagnostics,
  };
}

// Validates a SQL query against a live SQLite DB and (on success) captures
// EXPLAIN QUERY PLAN diagnostics. Schema-only; never executes.
function explainAgainstSqlite(liveDb, sql) {
  const statements = splitSqlStatements(sql);
  const tables = new Set();
  let totalEstimatedRows = 0;
  const planSteps = [];

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (!stmt) continue;
    try {
      liveDb.prepare(stmt);
    } catch (err) {
      return { ok: false, error: err.message, statement_index: i };
    }
    try {
      const planStmt = liveDb.prepare(`EXPLAIN QUERY PLAN ${stmt}`);
      const paramMatches = stmt.match(/\?/g);
      const paramCount = paramMatches ? paramMatches.length : 0;
      const dummyParams = Array(paramCount).fill(null);
      const planRows = planStmt.all(...dummyParams);
      for (const row of planRows) {
        const detail = row.detail || '';
        planSteps.push(detail);
        const m = detail.match(/^(?:SCAN|SEARCH)\s+(\S+)(?:\s|$)/);
        if (m) tables.add(m[1]);
      }
    } catch {}
  }

  for (const t of tables) {
    try {
      const stat = liveDb.prepare(
        "SELECT stat FROM sqlite_stat1 WHERE tbl = ? AND idx IS NULL"
      ).get(t);
      if (stat && stat.stat) {
        const rows = parseInt(stat.stat.split(/\s+/)[0], 10);
        if (!isNaN(rows)) totalEstimatedRows += rows;
      }
    } catch {}
  }

  return {
    ok: true,
    tables_touched: [...tables],
    total_estimated_rows: totalEstimatedRows,
    plan_steps: planSteps,
  };
}

// Split a SQL string on top-level semicolons. Respects single/double-quoted
// strings, bracket identifiers, and SQL comments.
function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let inSingle = false, inDouble = false, inBracket = false;
  let inLineC = false, inBlockC = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (inLineC) { buf += c; if (c === '\n') inLineC = false; continue; }
    if (inBlockC) { buf += c; if (c === '*' && next === '/') { buf += next; i++; inBlockC = false; } continue; }
    if (inSingle) { buf += c; if (c === "'" && next === "'") { buf += next; i++; } else if (c === "'") inSingle = false; continue; }
    if (inDouble) { buf += c; if (c === '"' && next === '"') { buf += next; i++; } else if (c === '"') inDouble = false; continue; }
    if (inBracket) { buf += c; if (c === ']') inBracket = false; continue; }
    if (c === "'") { inSingle = true; buf += c; continue; }
    if (c === '"') { inDouble = true; buf += c; continue; }
    if (c === '[') { inBracket = true; buf += c; continue; }
    if (c === '-' && next === '-') { inLineC = true; buf += c; continue; }
    if (c === '/' && next === '*') { inBlockC = true; buf += c; continue; }
    if (c === ';') { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.length === 0 ? [sql] : out;
}
