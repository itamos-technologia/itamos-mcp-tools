/**
 * Bug Pair Recorder
 * =================
 *
 * Records (code, schema, error) pairs from adapter failures into a local
 * SQLite DB. Each row is a reproducible bug — replay by loading the schema,
 * running the query, observing the error.
 *
 * Design principles:
 *   - Fire-and-forget: never throws, never blocks the caller. If recording
 *     fails, the caller never knows. The verifier returning a failure to
 *     the user is more important than the bug being logged.
 *   - Dedup by (adapter_type, query, schema_compact, error). Same failure
 *     across many users becomes one row with count++, not a flood.
 *   - Self-contained: no auth, no network, no tenant tracking. Bugs are
 *     just bugs, owned by us, queried by us, fixed by us.
 *   - Schema-aware: stores both compact (JSON of {table: [columns]}) for
 *     fast dedup/search AND full (CREATE TABLE statements) for replay.
 *
 * Schema:
 *   id                  PRIMARY KEY
 *   adapter_type        sqlite | postgres | lmdb | mysql | ...
 *   query               the failing SQL/sub-DB-name/etc.
 *   schema_compact      JSON {table: [columns]} for dedup
 *   schema_full         CREATE TABLE statements or equivalent for replay
 *   error               the engine's exact error message
 *   count               how many times this pair has been seen
 *   first_seen          ISO timestamp
 *   last_seen           ISO timestamp
 *   status              new | investigating | fixed | wont_fix
 *   notes               manual annotations during triage
 *
 * Unique index on (adapter_type, query, schema_compact, error) for dedup.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import Database from 'better-sqlite3';import _http from 'http';
import _https from 'https';

const _THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// pair DB lives at <root>/bugs/pairs.db. _THIS_DIR is <root>/lib/bug_recorder/
const PAIRS_DB_PATH = path.join(_THIS_DIR, '..', '..', 'bugs', 'pairs.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  try {
    const dir = path.dirname(PAIRS_DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _db = new Database(PAIRS_DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS pairs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        adapter_type    TEXT NOT NULL,
        query           TEXT NOT NULL,
        schema_compact  TEXT NOT NULL DEFAULT '{}',
        schema_full     TEXT NOT NULL DEFAULT '',
        error           TEXT NOT NULL,
        count           INTEGER NOT NULL DEFAULT 1,
        first_seen      TEXT NOT NULL,
        last_seen       TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'new',
        notes           TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_dedup
        ON pairs (adapter_type, query, schema_compact, error);
      CREATE INDEX IF NOT EXISTS idx_status ON pairs (status);
      CREATE INDEX IF NOT EXISTS idx_adapter ON pairs (adapter_type);
      CREATE INDEX IF NOT EXISTS idx_count ON pairs (count DESC);
    `);
    return _db;
  } catch (err) {
    // If the DB can't be opened, recording silently no-ops. We don't want
    // bug recording itself to be a source of bugs that crash the verifier.
    return null;
  }
}

/**
 * Record a (query, schema, error) pair from an adapter failure.
 *
 * @param {object} pair
 * @param {string} pair.adapter_type      e.g. 'sqlite' | 'postgres' | 'lmdb'
 * @param {string} pair.query             the failing SQL or reference
 * @param {object} pair.schema_compact    {table: [columns]} or similar; will be JSON.stringified
 * @param {string} pair.schema_full       CREATE TABLE statements or equivalent
 * @param {string} pair.error             the engine's exact error message
 *
 * Fire-and-forget. Never throws. Returns true on insert/update, false on
 * skip (e.g., DB unavailable). Caller should not await this and should
 * not branch on its return value.
 *
 * If ITAMOS_BUG_COLLECT_URL is set, the pair is ALSO shipped anonymously to
 * that endpoint (no identity, no file content — just the flat command/replay
 * pair). The ship is fire-and-forget and never affects the local path.
 */
export function recordPair(pair) {
  try {
    const db = getDb();
    if (!db) return false;

    const adapter_type = String(pair.adapter_type || 'unknown').slice(0, 64);
    const query = String(pair.query || '').slice(0, 8192);
    const error = String(pair.error || '').slice(0, 2048);
    const schema_compact = JSON.stringify(pair.schema_compact || {}).slice(0, 16384);
    const schema_full = String(pair.schema_full || '').slice(0, 65536);
    const now = new Date().toISOString();

    if (!query || !error) return false;   // empty pairs aren't useful

    // INSERT ... ON CONFLICT DO UPDATE for atomic dedup
    const stmt = db.prepare(`
      INSERT INTO pairs (adapter_type, query, schema_compact, schema_full, error, count, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (adapter_type, query, schema_compact, error)
      DO UPDATE SET count = count + 1, last_seen = excluded.last_seen
    `);
    stmt.run(adapter_type, query, schema_compact, schema_full, error, now, now);

    // Optional anonymous ship-to-server. No identity, no file content.
    shipAnon({ adapter_type, query, schema_compact, schema_full, error, ts: now });
    return true;
  } catch (err) {
    // Recording failed — silently swallow. The user's verify call must not
    // be affected by bug-recorder errors.
    return false;
  }
}

/**
 * Fire-and-forget anonymous upload of a pair to the central collector.
 * Flat, anonymous: no user id, no paths, no file bodies — just the command/
 * replay pair the engine already deemed content-safe. Never throws, never
 * blocks. Silently does nothing if no collector URL is configured.
 */
function shipAnon(payload) {
  try {
    const url = process.env.ITAMOS_BUG_COLLECT_URL;
    if (!url) return;
    const body = Buffer.from(JSON.stringify(payload));
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? _https : _http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 3000,
    }, (res) => { res.resume(); });   // drain & ignore response
    req.on('error', () => {});         // swallow — never affect caller
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.end(body);
  } catch { /* swallow */ }
}

/**
 * Inspection helpers (used at triage time, not in the hot path).
 */

export function listPairs({ status, adapter_type, limit = 50 } = {}) {
  try {
    const db = getDb();
    if (!db) return [];
    const conditions = [];
    const params = [];
    if (status) { conditions.push('status = ?'); params.push(status); }
    if (adapter_type) { conditions.push('adapter_type = ?'); params.push(adapter_type); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`
      SELECT id, adapter_type, query, error, count, first_seen, last_seen, status, notes
      FROM pairs ${where}
      ORDER BY count DESC, last_seen DESC
      LIMIT ?
    `).all(...params, limit);
  } catch {
    return [];
  }
}

export function getPair(id) {
  try {
    const db = getDb();
    if (!db) return null;
    return db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) || null;
  } catch {
    return null;
  }
}

export function pairStats() {
  try {
    const db = getDb();
    if (!db) return null;
    const total = db.prepare('SELECT COUNT(*) AS c FROM pairs').get().c;
    const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM pairs GROUP BY status').all();
    const byAdapter = db.prepare('SELECT adapter_type, COUNT(*) AS c, SUM(count) AS occurrences FROM pairs GROUP BY adapter_type').all();
    const totalOccurrences = db.prepare('SELECT SUM(count) AS c FROM pairs').get().c || 0;
    return { total_unique_pairs: total, total_occurrences: totalOccurrences, by_status: byStatus, by_adapter: byAdapter };
  } catch {
    return null;
  }
}
