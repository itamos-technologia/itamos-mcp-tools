/**
 * DuckDB L3 adapter — SHIPPED.
 *
 * For each SQL query a file declares (extracted by the parser at scan time,
 * stored in master-architect's `sql_queries` table) that targets a DuckDB
 * database, opens that database READ-ONLY and validates the query with
 * prepare(). DuckDB binds the statement while preparing, so missing tables,
 * missing columns and syntax errors all surface with the engine's exact
 * message, without executing anything.
 *
 * Diagnostics on success: tables touched (from EXPLAIN) and the tables in
 * the database (from the catalog). Schema-only: never reads or modifies rows.
 *
 * Recognised by the parsers:
 *   JS:     new duckdb.Database('path')      (':memory:' is skipped)
 *   Python: duckdb.connect('path') / duckdb.connect(database='path')
 *
 * Structurally the same as lib/adapters/sqlite/. See _contract.js.
 */

import path from 'path';
import { existsSync } from 'fs';
import { recordPair } from '../../bug_recorder/index.js';

export const type = 'duckdb';
export const implemented = true;
export const description = 'DuckDB query validation via prepare() + EXPLAIN diagnostics';
export const driverHint = 'duckdb (npm package, loaded on demand)';

const preview = (sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 100);

// Sandbox rule shared with the SQLite adapter: a database outside the
// caller's slot is treated as nonexistent (no reading, no existence probing).
function outsideSandbox(p) {
  const slot = globalThis.__sandboxCtx?.getStore?.()?.slotDir;
  return Boolean(globalThis.__sandboxCtx) && !(slot && path.resolve(p).startsWith(slot + '/'));
}

function openReadOnly(duckdb, file) {
  return new Promise((resolve) => {
    const dbh = new duckdb.Database(file, { access_mode: 'READ_ONLY' }, (err) => {
      resolve(err ? { error: err.message } : { dbh });
    });
  });
}

const allRows = (con, sql) => new Promise((resolve) => {
  con.all(sql, (err, rows) => resolve(err ? { error: err.message } : { rows }));
});

function prepareOnly(con, sql) {
  return new Promise((resolve) => {
    try {
      const stmt = con.prepare(sql, (err) => {
        if (err) return resolve({ ok: false, error: err.message });
        try { stmt.finalize(); } catch {}
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

export async function check(absPath, db) {
  absPath = path.resolve(absPath);
  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) return { ok: true, checked: 0, note: 'file not in any project' };

  const queries = db.prepare(`
    SELECT sq.id, sq.line, sq.method, sq.sql,
           d.name AS db_name, d.path_or_uri AS db_path
    FROM sql_queries sq
    JOIN databases d ON sq.inferred_database_id = d.id
    WHERE sq.file_id = ? AND sq.is_dynamic = 0 AND d.type = 'duckdb'
    ORDER BY sq.line
  `).all(fileRow.id);
  if (queries.length === 0) return { ok: true, checked: 0, note: 'no static DuckDB queries to verify' };

  let duckdb;
  try {
    duckdb = (await import('duckdb')).default;
  } catch (err) {
    throw new Error(`DuckDB driver not available (${driverHint}): ${err.message}`);
  }

  const byDb = new Map();
  for (const q of queries) {
    if (!byDb.has(q.db_path)) byDb.set(q.db_path, { db_path: q.db_path, db_name: q.db_name, queries: [] });
    byDb.get(q.db_path).queries.push(q);
  }

  const failures = [];
  const diagnostics = [];
  let checked = 0;
  const failAll = (group, error) => {
    for (const q of group.queries) {
      checked += 1;
      failures.push({ line: q.line, method: q.method, db: group.db_name, sql_preview: preview(q.sql), error });
    }
  };

  for (const [, group] of byDb) {
    if (!group.db_path || group.db_path.startsWith('dynamic:')) {
      failAll(group, `database path is not a literal (${group.db_path || 'none'}), so it cannot be opened for verification`);
      continue;
    }
    if (outsideSandbox(group.db_path) || !existsSync(group.db_path)) {
      failAll(group, `database file does not exist at ${group.db_path}`);
      continue;
    }
    const opened = await openReadOnly(duckdb, group.db_path);
    if (opened.error) {
      failAll(group, `cannot open database for verification: ${opened.error}`);
      continue;
    }
    const con = opened.dbh.connect();
    const dbDiag = { db: group.db_name, path: group.db_path, tables_in_db: [], queries: [] };
    const schemaCompact = {};
    try {
      const cols = await allRows(con, `SELECT table_name, column_name FROM information_schema.columns
                                       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                                       ORDER BY table_name, ordinal_position`);
      for (const r of cols.rows || []) (schemaCompact[r.table_name] ||= []).push(r.column_name);
      dbDiag.tables_in_db = Object.keys(schemaCompact);

      for (const q of group.queries) {
        checked += 1;
        const res = await prepareOnly(con, q.sql);
        if (!res.ok) {
          failures.push({ line: q.line, method: q.method, db: group.db_name, sql_preview: preview(q.sql), error: res.error });
          try {
            recordPair({ adapter_type: 'duckdb', query: q.sql, schema_compact: schemaCompact,
                         schema_full: JSON.stringify(schemaCompact), error: res.error });
          } catch {}
          continue;
        }
        // Tables touched, from the physical plan (skipped for parameterised
        // queries, which EXPLAIN can't run without values).
        const tables = new Set();
        if (!/\?|\$\d/.test(q.sql)) {
          const plan = await allRows(con, `EXPLAIN ${q.sql}`);
          for (const row of plan.rows || []) {
            for (const v of Object.values(row)) {
              for (const m of String(v).matchAll(/Table:\s*([A-Za-z0-9_."]+)/g)) tables.add(m[1].replace(/"/g, ''));
            }
          }
        }
        dbDiag.queries.push({ line: q.line, method: q.method, sql_preview: preview(q.sql), tables_touched: [...tables] });
      }
    } finally {
      try { con.close(); } catch {}
      await new Promise((r) => { try { opened.dbh.close(() => r()); } catch { r(); } });
    }
    diagnostics.push(dbDiag);
  }

  return { ok: failures.length === 0, checked, failures, diagnostics };
}
