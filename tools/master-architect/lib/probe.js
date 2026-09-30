/**
 * Environment-aware external dependency probe.
 *
 * Used by L3 verify to confirm a file's external imports are actually
 * importable in the file's runtime environment (its venv, or system).
 *
 * Pattern: CMake-style configure-time check. Don't trust static analysis
 * to know if `import shapely` will succeed at runtime — try it. The probe
 * spawns the appropriate interpreter, attempts each import, reports back.
 *
 * No persistent cache: probes run on each L3 verify. Fast enough because:
 *   (a) Python startup ~50-100ms, all imports tested in one subprocess
 *   (b) Verify is manual/intentional, not a hot path
 *   (c) Failure messages flow into the verify response; the file's own
 *       verification_status captures the pass/fail outcome
 *
 * Stdlib detection is NOT hardcoded — the probe asks the interpreter for
 * sys.stdlib_module_names (Python 3.10+) so we always have the correct
 * list for whichever Python version we're probing against.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const MAX_WALK_DEPTH = 20;       // safety limit on env-detection ascent
const PROBE_TIMEOUT_MS = 5000;   // give a generous budget; first venv-python launch can be slow
const SENTINEL_SYSTEM_PY = '__system_python3__';   // env_path when no venv was found

// ─── Environment detection ───────────────────────────────────────────────
//
// Walk up from the file looking for pyvenv.cfg. The directory containing
// pyvenv.cfg IS the venv root; its python is at <root>/bin/python.
// If we walk to / without finding one, fall back to system python3.
//
// Conda/Poetry/Pipenv/uv-with-no-venv detection is a v2 concern — they all
// fall through to system python3 in v1 and L3 will probe against that.
// Worst case is a false negative (dep installed in conda env, missing in
// system python) which surfaces clearly in the verify message and the
// user can act on it.

const PROJECT_MARKERS = [
  '.git', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py',
  'setup.cfg', 'package.json',
];

function venvInDirectory(dir) {
  // Return interpreter path if `dir` itself is a venv
  if (existsSync(path.join(dir, 'pyvenv.cfg'))) {
    const py = path.join(dir, 'bin', 'python');
    if (existsSync(py)) return { env_path: dir, interpreter: py };
  }
  // Otherwise scan immediate subdirectories for a venv
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    if (existsSync(path.join(sub, 'pyvenv.cfg'))) {
      const py = path.join(sub, 'bin', 'python');
      if (existsSync(py)) return { env_path: sub, interpreter: py };
    }
  }
  return null;
}

export function detectEnvironment(filePath) {
  const abs = path.resolve(filePath);
  let dir = path.dirname(abs);

  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    // First: is THIS dir a venv root, or does it contain one as a subdir?
    const venv = venvInDirectory(dir);
    if (venv) {
      return { kind: 'venv', ...venv };
    }
    // If we hit a project marker, also stop ascending (the venv would be
    // here or in a subdir; we already checked subdirs above)
    const isProjectRoot = PROJECT_MARKERS.some(m => existsSync(path.join(dir, m)));
    if (isProjectRoot) break;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {
    kind: 'system',
    env_path: SENTINEL_SYSTEM_PY,
    interpreter: 'python3',
  };
}

// ─── Probe execution ─────────────────────────────────────────────────────
//
// Runs a single subprocess that:
//   1. asks the interpreter for its stdlib module names
//   2. for each requested import, tries it (skipping stdlib silently)
//   3. emits a JSON line per result
//
// We pass the import list via stdin to avoid command-line length limits
// and shell escaping issues with weird package names.

const PROBE_SCRIPT = `
import sys, json, importlib.util

# Read the import list from stdin (one per line)
imports = [line.strip() for line in sys.stdin if line.strip()]

# Stdlib filter — authoritative source from the running interpreter
try:
    stdlib = set(sys.stdlib_module_names)   # Python 3.10+
except AttributeError:
    stdlib = set()   # fall back to "no filter" on older interpreters

results = []
for imp in imports:
    # Top-level module name: 'foo.bar.baz' → 'foo' (the importable unit)
    top = imp.split('.')[0]
    if top in stdlib:
        results.append({'import': imp, 'status': 'stdlib'})
        continue
    try:
        spec = importlib.util.find_spec(top)
        if spec is None:
            results.append({'import': imp, 'status': 'missing',
                            'error': f"No module named '{top}'"})
        else:
            origin = getattr(spec, 'origin', None)
            results.append({'import': imp, 'status': 'available',
                            'resolved_to': origin or '(builtin)'})
    except Exception as e:
        results.append({'import': imp, 'status': 'error',
                        'error': f"{type(e).__name__}: {e}"})

print(json.dumps({'env_python': sys.executable,
                  'python_version': sys.version.split()[0],
                  'results': results}))
`;

/**
 * Probe a list of external imports in the appropriate environment for a file.
 *
 * Parameters:
 *   filePath: absolute path to the file whose env we should detect
 *   importNames: array of import names (e.g., ['shapely', 'numpy', 'os'])
 *
 * Returns:
 *   {
 *     ok: true,
 *     env: { kind, env_path, interpreter, python_version },
 *     results: [
 *       { import: 'os',      status: 'stdlib' },
 *       { import: 'numpy',   status: 'available', resolved_to: '...' },
 *       { import: 'shapely', status: 'missing',   error: "No module named 'shapely'" },
 *     ],
 *     missing: ['shapely'],   // convenience: just the missing names
 *     all_ok: false,          // true iff no missing/error entries
 *   }
 *   { ok: false, error: '...' }   on probe machinery failure (timeout, interpreter not found)
 */
export async function probeImports(filePath, importNames) {
  if (!Array.isArray(importNames) || importNames.length === 0) {
    return { ok: true, env: null, results: [], missing: [], all_ok: true };
  }

  const env = detectEnvironment(filePath);

  // Spawn the interpreter, send the script + import list via stdin
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let child;
    try {
      child = spawn(env.interpreter, ['-c', PROBE_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: `cannot spawn ${env.interpreter}: ${err.message}`, env });
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
      resolve({ ok: false, error: `probe spawn failed: ${err.message}`, env });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `probe timed out after ${PROBE_TIMEOUT_MS}ms`, env });
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          error: `probe exited ${code}: ${stderr.trim() || '(no stderr)'}`,
          env,
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (err) {
        resolve({
          ok: false,
          error: `probe output not JSON: ${err.message}; raw: ${stdout.slice(0, 200)}`,
          env,
        });
        return;
      }
      const missing = parsed.results
        .filter(r => r.status === 'missing' || r.status === 'error')
        .map(r => r.import);
      resolve({
        ok: true,
        env: { ...env, python_version: parsed.python_version },
        results: parsed.results,
        missing,
        all_ok: missing.length === 0,
      });
    });

    // Send the import list via stdin
    child.stdin.write(importNames.join('\n') + '\n');
    child.stdin.end();
  });
}
