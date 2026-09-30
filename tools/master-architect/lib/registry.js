/**
 * Language registry — extension → parser dispatcher with lazy loading.
 *
 * Loaded once. Parser modules loaded on-demand the first time a file of
 * that language is encountered.
 *
 * Files fall into four categories based on their extension:
 *   supported    → parser exists, file gets numeric address, full analysis
 *   coming_soon  → recognised code language, no parser yet, letter address
 *   opaque       → recognised but inanalysable (binary / asset / doc), letter address
 *   unrecognized → not in registry, no address, skipped from skeleton
 *
 * Directory ignoring works at three levels:
 *   1. Literal name match (`node_modules`, `.git`)
 *   2. Pattern match (`^\.venv.*$` catches `.venv`, `.venv-shopbot`, etc.)
 *   3. Marker file presence (e.g., a directory containing `pyvenv.cfg` is a venv)
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, '_languages.json');

let _registry = null;
const _parserCache = new Map();

function loadRegistry() {
  if (_registry) return _registry;
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));

  const byExt = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    byExt[key.toLowerCase()] = val;
  }

  _registry = {
    byExt,
    ignoredDirs:        new Set(raw._ignored_dirs || []),
    ignoredDirPatterns: (raw._ignored_dir_patterns || []).map(p => new RegExp(p)),
    ignoredDirMarkers:  raw._ignored_dir_markers || [],
    ignoredFiles:       new Set(raw._ignored_files || []),
  };
  return _registry;
}

export function detectLanguage(filePath) {
  const reg = loadRegistry();
  // Location-based nginx detection FIRST. nginx vhosts in sites-enabled/
  // sites-available/ conf.d/ are conventionally extensionless (e.g. "mcp2"),
  // so extension lookup misses them. Any file directly under one of those
  // directories — or named nginx.conf — is treated as nginx config regardless
  // of extension. Path separators are normalized so this works on the dir
  // component whether filePath is a full path or just a name.
  const norm = String(filePath).replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  const parentDir = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
  const parentName = parentDir.slice(parentDir.lastIndexOf('/') + 1);
  const NGINX_DIRS = new Set(['sites-enabled', 'sites-available', 'conf.d']);
  if (base === 'nginx.conf' || NGINX_DIRS.has(parentName)) {
    return { kind: 'supported', language: 'nginx', parserFile: 'nginx.js' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const entry = reg.byExt[ext];
  if (!entry) return { kind: 'unrecognized' };

  if (entry.parser) {
    return { kind: 'supported', language: entry.language, parserFile: entry.parser };
  }
  if (entry.opaque) {
    return { kind: 'opaque', language: entry.language, isBinary: !!entry.binary };
  }
  if (entry.comingSoon) {
    return { kind: 'coming_soon', language: entry.language };
  }
  return { kind: 'unrecognized' };
}

/**
 * Should this directory be skipped during a project scan?
 * Three checks:
 *   1. Literal name match
 *   2. Pattern match against directory name
 *   3. Marker-file presence (e.g., pyvenv.cfg → it's a venv even if name is custom)
 *
 * @param {string} dirName  - basename of the directory
 * @param {string} dirPath  - absolute path (used for marker file check; pass null to skip)
 */
export function isIgnoredDir(dirName, dirPath = null) {
  const reg = loadRegistry();
  if (reg.ignoredDirs.has(dirName)) return true;
  for (const pat of reg.ignoredDirPatterns) {
    if (pat.test(dirName)) return true;
  }
  if (dirPath) {
    for (const marker of reg.ignoredDirMarkers) {
      if (existsSync(path.join(dirPath, marker))) return true;
    }
  }
  return false;
}

export function isIgnoredFile(fileName) {
  return loadRegistry().ignoredFiles.has(fileName);
}

export async function getParser(language, parserFile) {
  if (_parserCache.has(language)) return _parserCache.get(language);
  try {
    const mod = await import(path.join(__dirname, 'parsers', parserFile));
    _parserCache.set(language, mod.default);
    return mod.default;
  } catch (err) {
    console.error(`[registry] Failed to load parser for ${language}: ${err.message}`);
    _parserCache.set(language, null);
    return null;
  }
}

export function listLanguages() {
  const reg = loadRegistry();
  const seen = new Map();
  for (const [ext, entry] of Object.entries(reg.byExt)) {
    if (!seen.has(entry.language)) {
      let status = 'unknown';
      if (entry.parser)         status = 'supported';
      else if (entry.opaque)    status = entry.binary ? 'opaque_binary' : 'opaque_text';
      else if (entry.comingSoon) status = 'coming_soon';
      seen.set(entry.language, { language: entry.language, status, extensions: [] });
    }
    seen.get(entry.language).extensions.push(ext);
  }
  return [...seen.values()].sort((a, b) => a.language.localeCompare(b.language));
}
