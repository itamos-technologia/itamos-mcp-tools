/**
 * Adapter Dispatcher
 * ==================
 *
 * Convention-based discovery + lazy loading + result aggregation for
 * L3 verification adapters.
 *
 * Discovery rules:
 *   - Looks at lib/adapters/* (sibling directories of this file)
 *   - Any directory whose name doesn't start with "_" and which contains
 *     an index.js is considered an adapter
 *   - Each adapter must conform to the contract in _contract.js
 *
 * Lazy loading:
 *   - Adapters are NOT imported at startup
 *   - When runAdapters() is called for a file, the dispatcher first
 *     queries the architect DB to find which DB types the file uses
 *   - Only adapters matching those types get dynamically imported
 *   - This means installing pg, lmdb python, etc. is only needed for
 *     adapters whose DB types appear in the user's codebase
 *
 * Routing:
 *   - The architect DB's `databases` table has a `type` column
 *     ('sqlite', 'postgres', 'lmdb', etc.)
 *   - Dispatcher matches type against each loaded adapter's exported
 *     `type` value and calls the adapter's `check(absPath, db)`
 *
 * Aggregation:
 *   - Each adapter returns the standard { ok, checked, failures,
 *     diagnostics } shape
 *   - Dispatcher aggregates into a single result that verifyL3 can
 *     use to build the final response message
 *
 * Adding a new adapter:
 *   1. Create lib/adapters/<type>/index.js conforming to _contract.js
 *   2. Add any deps to parent's package.json
 *   3. Done — dispatcher picks it up automatically on next run
 *
 * No edits to this file are needed when adding adapters.
 */

import path from 'path';
import { readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

const _THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

// Discover adapter directories (one-time at module load — the directory
// listing is cheap, the actual imports are deferred).
function discoverAdapters() {
  const adapters = new Map();   // type → { dir, indexPath, instance: null }
  let entries;
  try {
    entries = readdirSync(_THIS_DIR, { withFileTypes: true });
  } catch (err) {
    return adapters;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    const dir = path.join(_THIS_DIR, entry.name);
    const indexPath = path.join(dir, 'index.js');
    try {
      statSync(indexPath);
    } catch {
      continue;   // no index.js, not an adapter
    }
    // We use the directory name as the expected type. The adapter MUST
    // export a matching `type` value for routing to work. We verify on
    // first load.
    adapters.set(entry.name, { dir, indexPath, instance: null, type: entry.name });
  }
  return adapters;
}

const _adapters = discoverAdapters();

// Lazily import an adapter and validate it conforms to the contract.
// Returns the adapter module on success, throws on contract violation.
async function loadAdapter(type) {
  const entry = _adapters.get(type);
  if (!entry) {
    throw new Error(`no adapter registered for type '${type}' — checked /tank/.../lib/adapters/${type}/`);
  }
  if (entry.instance) return entry.instance;

  let mod;
  try {
    mod = await import(entry.indexPath);
  } catch (err) {
    throw new Error(`adapter '${type}' failed to load: ${err.message}`);
  }

  // Contract checks
  if (mod.type !== type) {
    throw new Error(`adapter at ${entry.indexPath} declares type='${mod.type}' but lives in directory '${type}' — must match`);
  }
  if (typeof mod.check !== 'function') {
    throw new Error(`adapter '${type}' missing required export: check(absPath, db)`);
  }
  if (mod.implemented === undefined) {
    throw new Error(`adapter '${type}' missing required export: implemented (true|false)`);
  }

  entry.instance = mod;
  return mod;
}

/**
 * Determine which DB types a file actually uses, by querying the architect DB.
 * Returns a Set of type strings.
 */
function detectFileDbTypes(db, absPath) {
  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) return new Set();

  const types = new Set();

  // Types from sql_queries → databases (sqlite, postgres, mysql, etc.)
  const sqlTypes = db.prepare(`
    SELECT DISTINCT d.type
    FROM sql_queries sq
    LEFT JOIN databases d ON sq.inferred_database_id = d.id
    WHERE sq.file_id = ? AND sq.is_dynamic = 0
  `).all(fileRow.id);
  for (const r of sqlTypes) {
    if (r.type) types.add(r.type);
    else types.add('sqlite');   // unlinked queries: route to sqlite (which strict-fails them)
  }

  // Types from lmdb_subdb_refs → databases (always lmdb)
  const lmdbCount = db.prepare(
    'SELECT COUNT(*) AS c FROM lmdb_subdb_refs WHERE file_id = ?'
  ).get(fileRow.id);
  if (lmdbCount.c > 0) types.add('lmdb');

  return types;
}

/**
 * Run all relevant adapters for a file's DB usage.
 *
 * @param {string} absPath — absolute path to the file being verified
 * @param {Database} db — open architect DB connection (read-only OK)
 * @returns {{ ok, by_adapter: Map<type, result>, summary }}
 */
export async function runAdapters(absPath, db) {
  const types = detectFileDbTypes(db, absPath);

  if (types.size === 0) {
    return {
      ok: true,
      by_adapter: new Map(),
      summary: 'no DB references found in this file',
    };
  }

  const by_adapter = new Map();
  let allOk = true;

  for (const type of types) {
    let result;
    try {
      const adapter = await loadAdapter(type);
      if (!adapter.implemented) {
        // Stub adapter — surface as failure with helpful pointer
        result = {
          ok: false,
          checked: 0,
          failures: [{
            error: `adapter for type '${type}' not implemented yet — see ${_adapters.get(type)?.indexPath} for spec (${adapter.description || 'no description'})`,
          }],
          adapter_unimplemented: true,
        };
      } else {
        result = await adapter.check(absPath, db);
      }
    } catch (err) {
      result = {
        ok: false,
        checked: 0,
        failures: [{ error: `adapter '${type}' error: ${err.message}` }],
        adapter_error: true,
      };
    }
    by_adapter.set(type, result);
    if (!result.ok) allOk = false;
  }

  // Build a one-line summary
  const parts = [];
  for (const [t, r] of by_adapter) {
    if (r.checked === 0 && r.note) {
      parts.push(`${t}: ${r.note}`);
    } else if (r.ok) {
      parts.push(`${t}: ${r.checked} checked, all valid`);
    } else {
      parts.push(`${t}: ${r.failures.length} of ${r.checked} failed`);
    }
  }
  const summary = parts.join('; ');

  return { ok: allOk, by_adapter, summary };
}

/**
 * For diagnostics / debugging: list all registered adapters and their status.
 */
export function listAdapters() {
  const out = [];
  for (const [type, entry] of _adapters) {
    out.push({
      type,
      dir: entry.dir,
      loaded: entry.instance !== null,
    });
  }
  return out;
}
