/**
 * MySQL / MariaDB L3 adapter — SHIPPED.
 *
 * What this adapter does:
 *   For each MySQL/MariaDB-targeted query (extracted at scan time),
 *   connects to the live DB using credentials extracted from the source
 *   code, runs PREPARE + DEALLOCATE per query. PREPARE validates against
 *   the live schema without executing.
 *
 *   Treats MySQL and MariaDB as one DB type ('mysql'). They share the
 *   wire protocol, PREPARE syntax, and information_schema layout. If
 *   they ever diverge meaningfully, this adapter can be split into two.
 *   The original driver name (mysql / mysql2 / mariadb / pymysql /
 *   mysql.connector / etc.) is preserved in databases.extra._driver
 *   for future divergence handling.
 *
 *   Connection failures, auth rejections, and schema mismatches surface
 *   as L3 failures with the actual driver error.
 *
 * Driver: `mysql2` (npm package, supports promises natively, works
 * against both MySQL and MariaDB).
 *
 * See _contract.js for the adapter interface specification.
 */

import path from 'path';
import { recordPair } from '../../bug_recorder/index.js';

export const type = 'mysql';
export const implemented = true;
export const description = 'MySQL/MariaDB query validation via PREPARE/DEALLOCATE (one adapter handles both)';
export const driverHint = 'mysql2 (npm package — works against MySQL and MariaDB)';

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
    WHERE sq.file_id = ? AND sq.is_dynamic = 0 AND d.type = 'mysql'
    ORDER BY sq.line
  `).all(fileRow.id);

  if (queries.length === 0) {
    return { ok: true, checked: 0, note: 'no MySQL/MariaDB queries to verify' };
  }

  // Group by connection
  const byConn = new Map();
  for (const q of queries) {
    const key = q.db_uri;
    if (!byConn.has(key)) byConn.set(key, { db_name: q.db_name, db_uri: q.db_uri, db_extra: q.db_extra, queries: [] });
    byConn.get(key).queries.push(q);
  }

  // Lazy load mysql2
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch (err) {
    return {
      ok: false,
      checked: queries.length,
      failures: queries.map(q => ({
        line: q.line,
        method: q.method,
        db: q.db_name,
        sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
        error: `mysql2 package not available for verification: ${err.message}. Install with: npm install mysql2`,
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

    const connCfg = {
      host: cfg.host || 'localhost',
      port: cfg.port || 3306,
      user: cfg.user || undefined,
      password: cfg.password || undefined,
      database: cfg.database || cfg.db || undefined,
      connectTimeout: 3000,
      // mysql2 supports prepared statements only for the binary protocol,
      // which it uses by default for execute(). PREPARE/DEALLOCATE work
      // for both MySQL and MariaDB.
    };

    let connection;
    try {
      if (globalThis.__sandboxCtx) throw new Error('network database checks are disabled in the sandbox');
      connection = await mysql.createConnection(connCfg);
    } catch (err) {
      // Connection failures aren't recordable as bug pairs — environmental.
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: group.db_name,
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: `cannot connect to ${group.db_name} at ${connCfg.host}:${connCfg.port}: ${err.message}`,
        });
      }
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
        // information_schema.columns gives us tables + columns + types
        // in one query, restricted to the target database.
        const [rows] = await connection.query(`
          SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME, ORDINAL_POSITION
        `, [connCfg.database]);
        const tables = new Map();
        for (const row of rows) {
          if (!tables.has(row.TABLE_NAME)) tables.set(row.TABLE_NAME, []);
          tables.get(row.TABLE_NAME).push({
            name: row.COLUMN_NAME,
            type: row.DATA_TYPE,
            nullable: row.IS_NULLABLE === 'YES',
          });
        }
        for (const [tname, cols] of tables) {
          dbDiag.tables_in_db.push(tname);
          schemaCompact[tname] = cols.map(c => c.name);
          const colDefs = cols.map(c =>
            `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`
          ).join(',\n');
          schemaFull += `CREATE TABLE ${tname} (\n${colDefs}\n);\n`;
        }
      } catch {}

      for (const q of group.queries) {
        checked += 1;
        // MySQL/MariaDB PREPARE syntax is identical to Postgres in spirit
        // but requires a name + statement. We use a unique architect_check
        // prefix per query to avoid any collision.
        const stmtName = `architect_check_${q.id}`;
        try {
          // Note: MariaDB requires PREPARE statements via a string literal
          // OR via a session variable. The literal form works for static
          // SQL like ours.
          await connection.query(`PREPARE ${stmtName} FROM ?`, [q.sql]);
          await connection.query(`DEALLOCATE PREPARE ${stmtName}`);
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
          // Record (query, schema, error) pair for replay/debugging.
          // Fire-and-forget — never throws, never blocks.
          try {
            recordPair({
              adapter_type: 'mysql',
              query: q.sql,
              schema_compact: schemaCompact,
              schema_full: schemaFull,
              error: err.message,
            });
          } catch {}
          try { await connection.query(`DEALLOCATE PREPARE ${stmtName}`); } catch {}
        }
      }
    } finally {
      try { await connection.end(); } catch {}
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
