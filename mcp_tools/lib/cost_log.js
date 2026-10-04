// Shared cost/savings logger. Every tool calls logCost() to record a call.
// Append-only daily buckets in /tank/db/itamos_costs.db (WAL). The DB is never
// wiped: "today" is a display filter (day = current date), all-time total is the
// SUM across all rows. One row per (day, tool), upserted per call.
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';

const COSTS_DB = process.env.ITAMOS_COSTS_DB || '/tank/db/itamos_costs.db';
let _db = null;
let _stmt = null;

function db() {
  if (!_db) {
    try { mkdirSync(path.dirname(COSTS_DB), { recursive: true }); } catch {}
    _db = new Database(COSTS_DB);
    _db.pragma('journal_mode = WAL');
    _db.exec(`CREATE TABLE IF NOT EXISTS daily_costs (
      day TEXT NOT NULL, tool TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0,
      raw INTEGER NOT NULL DEFAULT 0, act INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, tool));`);
    _stmt = _db.prepare(`
      INSERT INTO daily_costs (day, tool, calls, saved, raw, act)
      VALUES (@day, @tool, 1, @saved, @raw, @act)
      ON CONFLICT(day, tool) DO UPDATE SET
        calls = calls + 1,
        saved = saved + @saved,
        raw   = raw   + @raw,
        act   = act   + @act`);
  }
  return _db;
}

function today() {
  // local date YYYY-MM-DD
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/**
 * Record one tool call's cost.
 * @param {string} tool  tool name (read_file | cmd | web_skeleton | memory | memory_investigation ...)
 * @param {number} raw   baseline tokens (what it'd cost without the tool)
 * @param {number} act   actual tokens consumed
 * saved is computed here as max(0, raw - act) — floored once, at the source.
 */
export function logCost(tool, raw, act) {
  try {
    db();
    const r = Math.max(0, Math.round(raw || 0));
    const a = Math.max(0, Math.round(act || 0));
    const saved = Math.max(0, r - a);
    _stmt.run({ day: today(), tool, saved, raw: r, act: a });
  } catch (e) {
    // never let cost logging break a tool
  }
}
