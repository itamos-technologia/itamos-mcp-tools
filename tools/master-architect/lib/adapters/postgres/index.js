/**
 * Postgres L3 adapter — SHIPPED.
 *
 * What this adapter does:
 *   For each Postgres-targeted query (extracted at scan time), connects
 *   to the live DB using credentials extracted from the source code,
 *   runs PREPARE + DEALLOCATE per query. PREPARE validates against the
 *   live schema without executing.
 *
 *   Connection failures, auth rejections, and schema mismatches surface
 *   as L3 failures with the actual driver error.
 *
 * Driver: `pg` (npm package, requires parent's package.json to declare it)
 *
 * See _contract.js for the adapter interface specification.
 */

import path from 'path';
import { recordPair } from '../../bug_recorder/index.js';

export const type = 'postgres';
export const implemented = true;
export const description = 'Postgres query validation via PREPARE/DEALLOCATE';
export const driverHint = 'pg (npm package)';

export async function check(absPath, db) {
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) {
    return { ok: true, checked: 0, note: 'file not in any project' };
  }

  const queries = db.prepare(`
    SELECT sq.id, sq.line, sq.method, sq.sql,
           d.name AS db_name, d.path_or_uri AS db_uri, d.extra AS db_extra
    FROM sql_queries sq
    JOIN databases d ON sq.inferred_database_id = d.id
    WHERE sq.file_id = ? AND sq.is_dynamic = 0 AND d.type = 'postgres'
    ORDER BY sq.line
  `).all(fileRow.id);

  if (queries.length === 0) {
    return { ok: true, checked: 0, note: 'no Postgres queries to verify' };
  }

  // Group by connection
  const byConn = new Map();
  for (const q of queries) {
    const key = q.db_uri;
    if (!byConn.has(key)) byConn.set(key, { db_name: q.db_name, db_uri: q.db_uri, db_extra: q.db_extra, queries: [] });
    byConn.get(key).queries.push(q);
  }

  // Lazy load pg
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch (err) {
    return {
      ok: false,
      checked: queries.length,
      failures: queries.map(q => ({
        line: q.line,
        method: q.method,
        db: q.db_name,
        sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
        error: `pg package not available for verification: ${err.message}. Install with: npm install pg`,
      })),
      diagnostics: [],
    };
  }

  const failures = [];
  const diagnostics = [];
  let checked = 0;

  for (const [, group] of byConn) {
    let cfg;
    try {
      cfg = group.db_extra ? JSON.parse(group.db_extra) : {};
    } catch {
      cfg = {};
    }

    const clientCfg = {
      host: cfg.host || undefined,
      port: cfg.port || undefined,
      user: cfg.user || undefined,
      password: cfg.password || undefined,
      database: cfg.database || cfg.dbname || undefined,
      connectionTimeoutMillis: 3000,
      query_timeout: 3000,
      statement_timeout: 3000,
    };

    const client = new pg.Client(clientCfg);
    let connected = false;
    try {
      await client.connect();
      connected = true;
    } catch (err) {
      // Connection failures aren't recordable as bug pairs — they're
      // environmental, not code-error pairs.
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: group.db_name,
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: `cannot connect to ${group.db_name} at ${cfg.host}:${cfg.port}: ${err.message}`,
        });
      }
      try { await client.end(); } catch {}
      continue;
    }

    const dbDiag = {
      db: group.db_name,
      uri: group.db_uri,
      tables_in_db: [],
      queries: [],
    };

    // Schema extracted ONCE per connection. Used for both diagnostics
    // (tables_in_db) and bug-pair recording (schema_compact, schema_full).
    let schemaCompact = {};
    let schemaFull = '';

    try {
      try {
        // One query pulls all public-schema tables + columns + types.
        // Cheaper than per-table introspection.
        const r = await client.query(`
          SELECT table_name, column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position
        `);
        const tables = new Map();
        for (const row of r.rows) {
          if (!tables.has(row.table_name)) tables.set(row.table_name, []);
          tables.get(row.table_name).push({
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable === 'YES',
          });
        }
        for (const [tname, cols] of tables) {
          dbDiag.tables_in_db.push(tname);
          schemaCompact[tname] = cols.map(c => c.name);
          // Build a CREATE TABLE statement for replay
          const colDefs = cols.map(c =>
            `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`
          ).join(',\n');
          schemaFull += `CREATE TABLE ${tname} (\n${colDefs}\n);\n`;
        }
      } catch {}

      for (const q of group.queries) {
        checked += 1;
        const stmtName = `architect_check_${q.id}`;
        try {
          await client.query(`PREPARE ${stmtName} AS ${q.sql}`);
          await client.query(`DEALLOCATE ${stmtName}`);
          dbDiag.queries.push({
            line: q.line,
            method: q.method,
            sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
            status: 'valid',
          });
        } catch (err) {
          failures.push({
            line: q.line,
            method: q.method,
            db: group.db_name,
            sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
            error: err.message,
          });
          // Record the (query, schema, error) pair for replay/debugging.
          // Fire-and-forget — never throws, never blocks.
          try {
            recordPair({
              adapter_type: 'postgres',
              query: q.sql,
              schema_compact: schemaCompact,
              schema_full: schemaFull,
              error: err.message,
            });
          } catch {}
          try { await client.query(`DEALLOCATE ${stmtName}`); } catch {}
        }
      }
    } finally {
      try { await client.end(); } catch {}
    }

    diagnostics.push(dbDiag);
  }

  return {
    ok: failures.length === 0,
    checked,
    failures,
    diagnostics,
  };
}
