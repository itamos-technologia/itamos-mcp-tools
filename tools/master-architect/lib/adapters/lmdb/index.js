/**
 * LMDB L3 adapter — SHIPPED.
 *
 * What this adapter does:
 *   For each `env.open_db(b'name')` reference in a file (extracted at
 *   scan time, stored in master-architect's `lmdb_subdb_refs` table),
 *   opens the linked LMDB env read-only via a Python subprocess and
 *   confirms the named sub-DB exists.
 *
 * Schema-only by design — bounded by master-DB size, never iterates
 * data sub-DBs. Safe against multi-TB envs.
 *
 * Driver: spawns python3 with the system-installed `lmdb` package.
 * The probe script lives next to this adapter (./probe.py).
 *
 * See _contract.js for the adapter interface specification.
 */

import path from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { recordPair } from '../../bug_recorder/index.js';

const _THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE_SCRIPT_PATH = path.join(_THIS_DIR, 'probe.py');
const PROBE_TIMEOUT_MS = 5000;

export const type = 'lmdb';
export const implemented = true;
export const description = 'LMDB named sub-DB existence check via Python subprocess probe';
export const driverHint = 'system python3 + python3-lmdb package';

export async function check(absPath, db) {
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) {
    return { ok: true, checked: 0, note: 'file not in any project' };
  }

  const refs = db.prepare(`
    SELECT r.id, r.line, r.name,
           d.id   AS db_id,
           d.name AS db_name,
           d.path_or_uri AS db_path,
           d.type AS db_type
    FROM lmdb_subdb_refs r
    LEFT JOIN databases d ON r.inferred_database_id = d.id
    WHERE r.file_id = ?
    ORDER BY r.line
  `).all(fileRow.id);

  if (refs.length === 0) {
    return { ok: true, checked: 0, note: 'no LMDB sub-DB references in this file' };
  }

  // Group by env so we probe each env once
  const byEnv = new Map();
  for (const r of refs) {
    const key = r.db_path || '__no_env_inferred__';
    if (!byEnv.has(key)) byEnv.set(key, { db_path: r.db_path, db_name: r.db_name, refs: [] });
    byEnv.get(key).refs.push(r);
  }

  const failures = [];
  const diagnostics = [];
  let checked = 0;

  for (const [, group] of byEnv) {
    if (!group.db_path) {
      // Architecture limitation, not a recordable bug pair
      for (const r of group.refs) {
        checked += 1;
        failures.push({
          line: r.line,
          name: r.name,
          env: '(none inferred)',
          error: 'no LMDB env inferred — architect could not determine which env this sub-DB reference belongs to',
        });
      }
      continue;
    }

    const probe = await probeLmdbEnv(group.db_path);

    if (!probe.ok) {
      for (const r of group.refs) {
        checked += 1;
        failures.push({
          line: r.line,
          name: r.name,
          env: group.db_name,
          error: `cannot probe LMDB env: ${probe.error}`,
        });
      }
      continue;
    }

    if (!probe.exists) {
      for (const r of group.refs) {
        checked += 1;
        failures.push({
          line: r.line,
          name: r.name,
          env: group.db_name,
          error: `LMDB env does not exist at ${group.db_path}`,
        });
      }
      continue;
    }

    const present = new Set(probe.sub_dbs || []);
    const envDiag = {
      env: group.db_name,
      path: group.db_path,
      sub_dbs_in_env: probe.sub_dbs || [],
      refs: [],
    };

    // Schema for LMDB pairs is the list of sub-DBs that exist in the env.
    // schema_compact is the JSON of available names; schema_full is the
    // env path plus the names (enough info to recreate the env layout).
    const schemaCompact = { sub_dbs: probe.sub_dbs || [] };
    const schemaFull = `LMDB env at ${group.db_path}\nNamed sub-DBs: ${(probe.sub_dbs || []).join(', ') || '(none — single-namespace env)'}`;

    for (const r of group.refs) {
      checked += 1;
      if (!present.has(r.name)) {
        const errorMsg = `sub-DB '${r.name}' does not exist in env (env has: ${[...present].join(', ') || '(none — single-namespace env)'})`;
        failures.push({
          line: r.line,
          name: r.name,
          env: group.db_name,
          error: errorMsg,
        });
        // Record the (sub-DB-name, env-schema, error) pair
        try {
          recordPair({
            adapter_type: 'lmdb',
            query: r.name,
            schema_compact: schemaCompact,
            schema_full: schemaFull,
            error: errorMsg,
          });
        } catch {}
      } else {
        envDiag.refs.push({ line: r.line, name: r.name, status: 'exists' });
      }
    }

    diagnostics.push(envDiag);
  }

  return {
    ok: failures.length === 0,
    checked,
    failures,
    diagnostics,
  };
}

// Spawn the Python probe to list named sub-DBs in an LMDB env
async function probeLmdbEnv(envPath) {
  // Sandbox: only probe LMDB envs inside the caller's slot; treat anything else
  // as nonexistent so user code can't read or probe host paths.
  if ((globalThis.__sandboxCtx && !(globalThis.__sandboxCtx.getStore()?.slotDir && path.resolve(envPath).startsWith(globalThis.__sandboxCtx.getStore().slotDir + '/')))) {
    return { ok: true, exists: false, env_path: envPath };
  }
  if (!existsSync(envPath)) {
    return { ok: true, exists: false, env_path: envPath };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;

    try {
      child = spawn('python3', [PROBE_SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: `cannot spawn python3: ${err.message}`, env_path: envPath });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, PROBE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `probe spawn error: ${err.message}`, env_path: envPath });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `probe timed out after ${PROBE_TIMEOUT_MS}ms`, env_path: envPath });
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          error: `probe exited ${code}: ${stderr.trim() || '(no stderr)'}`,
          env_path: envPath,
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        resolve({
          ok: false,
          error: `probe output not JSON: ${err.message}; raw: ${stdout.slice(0, 200)}`,
          env_path: envPath,
        });
      }
    });

    child.stdin.write(envPath + '\n');
    child.stdin.end();
  });
}
