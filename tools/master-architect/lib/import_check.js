// ─── L3 import check on the content being saved ─────────────────────────────
//
// verifyL3 used to read the imports recorded by the LAST SCAN, so it judged the
// old version of a file: a new file always passed, an edit adding a broken
// import passed, an edit fixing one still failed. This checks the buffer itself:
//
//   1. Parse the content with the scanner's own parser (analyzeContent).
//   2. Resolve each import with that parser's resolveImport/isLocalModule —
//      the exact rules a scan uses — against the files on disk.
//   3. An import that is not a project file must be an installed package
//      (Python: importlib.util.find_spec, JS/TS: Node's resolver). Many
//      languages can't tell "missing local module" from "external package" by
//      syntax alone (`from helpers import x`), so this is what catches it.
//
// Returns { ok, checked, external_imports, unresolved:[{import_path,line,reason}], note? }

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire, isBuiltin } from 'module';
import { analyzeContent } from './scan.js';
import { detectEnvironment } from './probe.js';

const execFileAsync = promisify(execFile);

export async function checkImportsInContent(absPath, content, projectRoot) {
  absPath = path.resolve(absPath);
  let a;
  try {
    a = await analyzeContent(absPath, content);
  } catch (err) {
    return { ok: true, checked: 0, external_imports: 0, unresolved: [], note: `imports not checked (${err.message})` };
  }
  if (!a || !a.analysis || !Array.isArray(a.analysis.imports)) {
    return { ok: true, checked: 0, external_imports: 0, unresolved: [], note: 'no import analysis for this file type' };
  }

  const root = projectRoot || path.dirname(absPath);
  const { parser, language } = a;
  const unresolved = [];
  const externals = [];
  let checked = 0;

  for (const imp of a.analysis.imports) {
    const spec = imp.import_path;
    if (!spec) continue;
    const looksLocal = spec.startsWith('.') || spec.startsWith('/');
    let resolved = null;
    if (parser.resolveImport) {
      try { resolved = parser.resolveImport(spec, absPath, fs, path, root); } catch {}
    }
    let isLocal = looksLocal || !!resolved;
    if (!isLocal && parser.isLocalModule) {
      try { isLocal = !!parser.isLocalModule(spec, absPath, fs, path, root); } catch {}
    }
    if (isLocal) {
      checked += 1;
      if (!resolved) unresolved.push({ import_path: spec, line: imp.line ?? null, reason: 'project file not found' });
    } else {
      externals.push({ import_path: spec, line: imp.line ?? null });
    }
  }

  // Not a project file → must be an installed package, or it goes nowhere.
  const missing = await findMissingPackages(language, externals, absPath, root);
  for (const m of missing) {
    unresolved.push({ import_path: m.import_path, line: m.line,
      reason: `not a project file and not installed${m.env ? ` in ${m.env}` : ''}` });
  }

  return { ok: unresolved.length === 0, checked, external_imports: externals.length, unresolved };
}

// The Python environment a file runs in: its project's venv (pyvenv.cfg, found
// the way probe.js finds it: this folder, a direct subfolder, then upwards to
// the project root), else the server's own python3. Read-only: we only list
// the venv's site-packages folders and read its pyvenv.cfg.
export function pythonEnvFor(absPath) {
  const env = detectEnvironment(absPath);
  if (env.kind !== 'venv') {
    return { kind: 'system', label: 'the server Python', sitePackages: [], includeSystem: true };
  }
  const sitePackages = [];
  for (const lib of ['lib', 'lib64']) {
    let vers = [];
    try { vers = fs.readdirSync(path.join(env.env_path, lib)); } catch {}
    for (const v of vers) {
      const sp = path.join(env.env_path, lib, v, 'site-packages');
      if (/^python\d/.test(v) && fs.existsSync(sp) && !sitePackages.includes(sp)) sitePackages.push(sp);
    }
  }
  let includeSystem = false, version = null;
  try {
    const cfg = fs.readFileSync(path.join(env.env_path, 'pyvenv.cfg'), 'utf8');
    includeSystem = /^\s*include-system-site-packages\s*=\s*true\s*$/mi.test(cfg);
    version = (cfg.match(/^\s*(?:version|version_info)\s*=\s*([\d.]+)/mi) || [])[1] || null;
  } catch {}
  return { kind: 'venv', path: env.env_path, version, sitePackages, includeSystem,
           label: `the venv ${env.env_path}${version ? ` (Python ${version})` : ''}` };
}

async function findMissingPackages(language, externals, absPath, root) {
  if (!externals.length) return [];

  if (language === 'python') {
    const tops = [...new Set(externals.map(e => e.import_path.split('.')[0]).filter(Boolean))];
    const env = pythonEnvFor(absPath);
    // SAFETY: nothing from the user's folder is ever executed. The server's own
    // python3 runs isolated (-I: no cwd on sys.path, no PYTHON* env, no user
    // site; -S: no site.py, so no .pth/sitecustomize) from cwd '/'. The venv is
    // imitated by adding its site-packages to sys.path, and find_spec only
    // LOOKS packages up — it does not import them.
    const script = [
      'import importlib.util, json, sys',
      'names = json.loads(sys.argv[1])',
      'extra = json.loads(sys.argv[2])',
      'if sys.argv[3] == "1":',
      '    import site',
      '    sys.path.extend(site.getsitepackages())',
      'sys.path.extend(extra)',
      'missing = []',
      'for n in names:',
      '    try:',
      '        if importlib.util.find_spec(n) is None: missing.append(n)',
      '    except Exception:',
      '        missing.append(n)',
      'print(json.dumps(missing))',
    ].join('\n');
    try {
      const { stdout } = await execFileAsync('python3',
        ['-I', '-S', '-c', script, JSON.stringify(tops),
         JSON.stringify([...env.sitePackages, path.dirname(absPath), root]), env.includeSystem ? '1' : '0'],
        { timeout: 10000, cwd: '/' });
      const gone = new Set(JSON.parse(stdout.trim() || '[]'));
      return externals.filter(e => gone.has(e.import_path.split('.')[0]))
        .map(e => ({ ...e, env: env.label }));
    } catch {
      return [];   // can't ask Python → don't invent failures
    }
  }

  if (language === 'javascript' || language === 'typescript') {
    const req = createRequire(absPath);
    return externals.filter(e => {
      const spec = e.import_path;
      if (isBuiltin(spec)) return false;
      if (spec.startsWith('@/') || spec.startsWith('~')) return false;   // bundler path aliases: can't judge
      try { req.resolve(spec); return false; } catch { return true; }
    });
  }

  return [];   // other languages: no package check
}
