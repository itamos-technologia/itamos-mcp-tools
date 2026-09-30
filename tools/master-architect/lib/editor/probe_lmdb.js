/**
 * LMDB environment probe — schema-only check for named sub-DB existence.
 *
 * LMDB has no SQL. An env contains named sub-DBs that act like tables. To
 * verify "does sub-DB X exist in env Y?" we open the env read-only and
 * iterate the master DB (the registry of named sub-DBs).
 *
 * Schema-only by design. We never read the data inside the sub-DBs — we
 * only list their names. Even against a 3TB LMDB env, this is bounded by
 * the small master-DB size (typically dozens of named sub-DBs, not millions).
 *
 * Implementation: spawns python3 with the lmdb package (which IS installed
 * system-wide on Monster) to do the probe. Same pattern as the import
 * resolution probe — keeps the JS side dependency-free.
 *
 * Returns:
 *   { ok: true,  env_path, exists: true,  sub_dbs: [...names] }
 *   { ok: true,  env_path, exists: false }                    — env doesn't exist
 *   { ok: false, env_path, error: '...' }                     — could not open
 */

import { existsSync } from 'fs';
import { spawn } from 'child_process';

const PROBE_TIMEOUT_MS = 5000;

const PROBE_SCRIPT = `
import sys, json
try:
    import lmdb
except ImportError:
    print(json.dumps({'ok': False, 'error': 'lmdb python package not available'}))
    sys.exit(0)

env_path = sys.stdin.readline().strip()

import os
if not os.path.exists(env_path):
    print(json.dumps({'ok': True, 'exists': False, 'env_path': env_path}))
    sys.exit(0)

try:
    # Open read-only. max_dbs=128 is generous; real envs rarely exceed a dozen.
    # readonly=True + lock=False means we don't disturb concurrent writers.
    env = lmdb.open(env_path, readonly=True, lock=False, max_dbs=128, subdir=os.path.isdir(env_path))
except lmdb.Error as e:
    print(json.dumps({'ok': False, 'error': f'cannot open lmdb env: {e}', 'env_path': env_path}))
    sys.exit(0)

sub_dbs = []
try:
    # The master DB contains BOTH named-sub-DB pointers AND data keys
    # (when the env is used in single-namespace mode, the master DB is
    # the data). To distinguish: try env.open_db(key) for each key.
    # Real sub-DBs open successfully; data keys raise lmdb.Error
    # (typically MDB_INCOMPATIBLE → IncompatibleError).
    with env.begin() as txn:
        cursor = txn.cursor()
        for key, _ in cursor:
            try:
                env.open_db(key, txn=txn)
                # Successful open means it's a real named sub-DB
                try:
                    sub_dbs.append(key.decode('utf-8'))
                except UnicodeDecodeError:
                    sub_dbs.append('hex:' + key.hex())
            except lmdb.Error:
                # Not a sub-DB — just a data key in the master namespace
                pass
except lmdb.Error as e:
    env.close()
    print(json.dumps({'ok': False, 'error': f'cannot iterate master db: {e}', 'env_path': env_path}))
    sys.exit(0)

env.close()
print(json.dumps({
    'ok': True,
    'exists': True,
    'env_path': env_path,
    'sub_dbs': sub_dbs,
}))
`;

/**
 * Probe an LMDB env for its named sub-DBs.
 *
 * @param {string} envPath  absolute path to the lmdb env (file or dir)
 * @returns Promise<{ok, exists?, sub_dbs?, error?, env_path}>
 */
export async function probeLmdbEnv(envPath) {
  if (!existsSync(envPath)) {
    return { ok: true, exists: false, env_path: envPath };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;

    try {
      child = spawn('python3', ['-c', PROBE_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
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
