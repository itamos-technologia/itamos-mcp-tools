/**
 * architect-link — bridge between read_file and master_architect's DB.
 *
 * Loaded lazily by read_file. The hot path (file open) does a cheap in-memory
 * project-root prefix check first; only if that matches does this module
 * actually open the architect DB and query.
 *
 * Per-engine session state (this module's module-scope) tracks which projects
 * have already had their full skeleton shipped to the LLM in this session, so
 * subsequent file opens of the same project return a compact "already_loaded"
 * marker instead of reshipping the skeleton.
 *
 * In production, each user has their own engine process, so module-scope
 * state is naturally per-user. No cross-user leakage possible.
 */

import Database from 'better-sqlite3';
import { probeLmdbEnv } from './probe_lmdb.js';
import path from 'path';
import { existsSync, statSync, readFileSync } from 'fs';
import { parseTree } from '../segmenter.js';
import { parseWithRootNode as jsParseWithRootNode } from '../parsers/javascript.js';
import { parseWithRootNode as pyParseWithRootNode } from '../parsers/python.js';
import { parseWithRootNode as goParseWithRootNode } from '../parsers/go.js';
import { parseWithRootNode as csharpParseWithRootNode } from '../parsers/csharp.js';
import { parseWithRootNode as phpParseWithRootNode } from '../parsers/php.js';
import { parseWithRootNode as swiftParseWithRootNode } from '../parsers/swift.js';
import { parseWithRootNode as shellParseWithRootNode } from '../parsers/shell.js';
import { parseWithRootNode as cParseWithRootNode } from '../parsers/c.js';
import { parseWithRootNode as cppParseWithRootNode } from '../parsers/cpp.js';
import { parseWithRootNode as javaParseWithRootNode } from '../parsers/java.js';
import { parseWithRootNode as kotlinParseWithRootNode } from '../parsers/kotlin.js';
import { parseWithRootNode as rubyParseWithRootNode } from '../parsers/ruby.js';
import { parseWithRootNode as rustParseWithRootNode } from '../parsers/rust.js';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

function sha256OfFile(absPath) {
  try {
    const buf = readFileSync(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

// Derive the architect DB path from THIS FILE'S location so the whole tree
// is portable: copy the parent directory anywhere and the DB still resolves.
//   architect-link.js lives at: <root>/lib/editor/architect-link.js
//   architect DB lives at:      <root>/master-architect.db
// (two .. up from this file)
const _THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARCHITECT_DB = path.join(_THIS_DIR, '..', '..', 'master-architect.db');

const ROOTS_REFRESH_MS = 60 * 1000;   // refresh project-roots cache every 60s

let _db = null;
let _dbPathUsed = null;
let _rootsCache = null;
let _rootsCachedAtMs = 0;
const _loadedProjectsThisSession = new Set();   // project_ids whose skeleton has been shipped this session

function resolveDbPath() {
  // Read env var on every call so tests can override after module load.
  return process.env.MASTER_ARCHITECT_DB || DEFAULT_ARCHITECT_DB;
}

/**
 * Open the architect DB read-only. Returns null if it doesn't exist
 * (architect tool not installed / no scans yet) — read_file then degrades
 * gracefully and just skips project info.
 *
 * If the env var changes between calls, reopens against the new path.
 */
function getDb() {
  const targetPath = resolveDbPath();
  if (_db && _dbPathUsed === targetPath) return _db;
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
    _rootsCache = null;
  }
  if (!existsSync(targetPath)) {
    _dbPathUsed = targetPath;
    return null;
  }
  try {
    _db = new Database(targetPath, { readonly: true, fileMustExist: true });
    _dbPathUsed = targetPath;
    return _db;
  } catch (err) {
    console.error(`[architect-link] cannot open ${targetPath}: ${err.message}`);
    _dbPathUsed = targetPath;
    return null;
  }
}

let _wdb = null;
let _wdbPathUsed = null;

/**
 * Write-capable DB connection, used only for the verify-status update path.
 * Kept separate from the read-only handle so that the hot read path stays
 * cheap and any write contention is isolated.
 */
function getWriteDb() {
  const targetPath = resolveDbPath();
  if (_wdb && _wdbPathUsed === targetPath) return _wdb;
  if (_wdb) {
    try { _wdb.close(); } catch {}
    _wdb = null;
  }
  if (!existsSync(targetPath)) {
    _wdbPathUsed = targetPath;
    return null;
  }
  try {
    _wdb = new Database(targetPath, { fileMustExist: true });
    _wdb.pragma('journal_mode = WAL');
    _wdb.pragma('foreign_keys = ON');
    _wdbPathUsed = targetPath;
    return _wdb;
  } catch (err) {
    console.error(`[architect-link] cannot open write handle ${targetPath}: ${err.message}`);
    _wdbPathUsed = targetPath;
    return null;
  }
}

/**
 * In-memory list of known project roots, refreshed every 60s.
 * Cheap pre-filter: a quick prefix scan tells us whether to bother
 * with a real DB lookup. For files in /tmp, /etc, etc. we can answer
 * "definitely not in any project" in microseconds.
 */
function getProjectRoots() {
  const now = Date.now();
  if (_rootsCache && (now - _rootsCachedAtMs) < ROOTS_REFRESH_MS) {
    return _rootsCache;
  }
  const db = getDb();
  if (!db) {
    _rootsCache = [];
    _rootsCachedAtMs = now;
    return _rootsCache;
  }
  try {
    const rows = db.prepare('SELECT id, name, root_path FROM projects').all();
    // Sort by root path length DESC so longest (most specific) match wins
    rows.sort((a, b) => b.root_path.length - a.root_path.length);
    _rootsCache = rows;
    _rootsCachedAtMs = now;
  } catch (err) {
    console.error(`[architect-link] failed to load project roots: ${err.message}`);
    _rootsCache = [];
    _rootsCachedAtMs = now;
  }
  return _rootsCache;
}

/**
 * Cheap pre-filter: does this absolute path live under any known project root?
 * Pure string comparison, no DB query. Returns the matching project row or null.
 * Exported so entry-path orchestration (write_file/read_file) can resolve a
 * file's project group before filing it.
 */
export function matchProjectRoot(absPath) {
  for (const project of getProjectRoots()) {
    // Skip virtual 'unknown://N' roots — they are placeholder clusters, not
    // real disk roots, and must never prefix-match a real path.
    if (project.root_path.startsWith('unknown://')) continue;
    if (absPath === project.root_path ||
        absPath.startsWith(project.root_path + path.sep)) {
      return project;
    }
  }
  return null;
}

/**
 * Look up exact file membership in the architect DB.
 * Returns { project_id, project_name, project_root, file_id, file_address }
 * or null if not found.
 */
function lookupExactFile(absPath) {
  const db = getDb();
  if (!db) return null;
  try {
    return db.prepare(`
      SELECT p.id AS project_id, p.name AS project_name, p.root_path AS project_root,
             f.id AS file_id, f.address AS file_address
      FROM files f
      JOIN projects p ON f.project_id = p.id
      WHERE f.abs_path = ?
    `).get(absPath) || null;
  } catch {
    return null;
  }
}

/**
 * Build the project skeleton — lightweight version of master-architect's
 * `skeleton` command but returned as structured data the LLM can consume.
 *
 * Includes all directories + all files with addresses, names, languages,
 * and per-file structural counts. Does NOT include modules/methods (those
 * are reachable via navigate).
 */
function buildProjectSkeleton(projectId) {
  const db = getDb();
  if (!db) return null;

  const project = db.prepare(
    'SELECT id, name, root_path, last_scan_at FROM projects WHERE id = ?'
  ).get(projectId);
  if (!project) return null;

  const dirs = db.prepare(`
    SELECT id, parent_id, address, name, rel_path
    FROM directories WHERE project_id = ?
    ORDER BY length(rel_path), address
  `).all(projectId);

  const files = db.prepare(`
    SELECT id, directory_id, address, name, language, category, parse_status,
           line_count, byte_size, est_tokens,
           verification_status, version, verified_at_level, verified_at,
           (SELECT COUNT(*) FROM modules WHERE file_id = files.id) AS module_count,
           (SELECT COUNT(*) FROM methods me JOIN modules mo ON me.module_id = mo.id WHERE mo.file_id = files.id) AS method_count
    FROM files WHERE project_id = ?
    ORDER BY directory_id, address
  `).all(projectId);

  const totals = {
    directories: dirs.length,
    files: files.length,
    files_supported:    files.filter(f => f.category === 'supported').length,
    files_coming_soon:  files.filter(f => f.category === 'coming_soon').length,
    files_opaque_text:  files.filter(f => f.category === 'opaque_text').length,
    files_opaque_binary: files.filter(f => f.category === 'opaque_binary').length,
    modules:            files.reduce((s, f) => s + (f.module_count || 0), 0),
    methods:            files.reduce((s, f) => s + (f.method_count || 0), 0),
  };

  return {
    project_id: project.id,
    project_name: project.name,
    project_root: project.root_path,
    last_scan_at: project.last_scan_at,
    totals,
    directories: dirs.map(d => ({
      id: d.id, address: d.address, name: d.name,
      rel_path: d.rel_path, parent_id: d.parent_id,
    })),
    files: files.map(f => ({
      address: f.address,
      name: f.name,
      directory_id: f.directory_id,
      language: f.language,
      category: f.category,
      parse_status: f.parse_status,
      line_count: f.line_count,
      verification_status: f.verification_status,
      version: f.version,
      verified_at_level: f.verified_at_level,
      ...(f.category === 'supported'
        ? { module_count: f.module_count, method_count: f.method_count }
        : { byte_size: f.byte_size, est_tokens: f.est_tokens }),
    })),
  };
}

/**
 * The main entry point read_file calls.
 *
 * Returns one of:
 *   null                                — file is irrelevant (no project, no need to attach anything)
 *   { status: 'loaded_now', ...skeleton }    — file is in a project, skeleton being shipped now
 *   { status: 'already_loaded', ... }        — file is in a project we've already shipped this session
 *   { status: 'in_tree_not_indexed', ... }   — file is under a project root but not yet indexed
 *   { status: 'unassigned', ... }            — file has no project association at all
 *
 * The 'unassigned' case is only returned for files that look code-like
 * (a parseable language). For random text files, scripts in /tmp, etc.
 * we return null to avoid noise.
 */
export function getProjectInfoForFile(absPath) {
  absPath = path.resolve(absPath);

  // Hot path: cheap prefix check first
  const matchedProject = matchProjectRoot(absPath);

  if (matchedProject) {
    // File is under a known project root. Check if it's an indexed file.
    const fileRow = lookupExactFile(absPath);

    if (fileRow) {
      // INDEXED FILE — we know its address.
      const alreadyLoaded = _loadedProjectsThisSession.has(fileRow.project_id);
      if (alreadyLoaded) {
        return {
          status: 'already_loaded',
          project_id: fileRow.project_id,
          project_name: fileRow.project_name,
          project_root: fileRow.project_root,
          file_address: fileRow.file_address,
          hint: `This file is part of project '${fileRow.project_name}' (loaded earlier in this session). Use master_architect navigate/connections to explore.`,
        };
      }
      // First time seeing this project this session — run integrity check
      // first, then ship the skeleton.
      //
      // Integrity check sweeps every 'verified' file and confirms its on-disk
      // fingerprint still matches the snapshot we took when WE verified it.
      // Files modified outside our pipeline (coworker overwrite, git pull,
      // direct IDE save, etc.) get demoted to 'unverified' here — their
      // current content isn't what we verified, even if it might be valid.
      const integrity = runIntegrityCheck(fileRow.project_id);
      const skeleton = buildProjectSkeleton(fileRow.project_id);
      if (!skeleton) {
        return null;
      }
      _loadedProjectsThisSession.add(fileRow.project_id);
      const baseHint = `Project '${fileRow.project_name}' loaded. Numeric addresses (1.2.3) navigate code; letter addresses (1.a) are non-parseable files. Use master_architect navigate/connections from here.`;
      const integrityHint = integrity.demoted > 0
        ? ` Integrity check demoted ${integrity.demoted} file(s) to unverified — see integrity_warnings for details. Re-verify before trusting them.`
        : '';
      return {
        status: 'loaded_now',
        project_id: fileRow.project_id,
        project_name: fileRow.project_name,
        project_root: fileRow.project_root,
        file_address: fileRow.file_address,
        skeleton,
        ...(integrity.demoted > 0
          ? { integrity_warnings: integrity.demoted_files }
          : {}),
        hint: baseHint + integrityHint,
      };
    }

    // File is in tree but not indexed (added since last scan, or in a subdir not scanned).
    return {
      status: 'in_tree_not_indexed',
      project_id: matchedProject.id,
      project_name: matchedProject.name,
      project_root: matchedProject.root_path,
      hint: `This file is inside project '${matchedProject.name}' but not in the index. Call master_architect.associate(path='${absPath}', project_id=${matchedProject.id}) to add it to that project, or master_architect.scan(path='${matchedProject.root_path}') to refresh the whole project from disk.`,
    };
  }

  // No project root match. Only return 'unassigned' for code-like files;
  // skip the noise for random non-code files.
  const codeExts = new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
    '.py', '.pyw', '.go', '.rs', '.java', '.kt', '.swift',
    '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.cs', '.lua',
  ]);
  const ext = path.extname(absPath).toLowerCase();
  if (!codeExts.has(ext)) return null;

  return {
    status: 'unassigned',
    abs_path: absPath,
    hint: `This file isn't part of any known project. Ask the user if they'd like to start one. If yes, call master_architect.register(path='${absPath}', project_name='<name>') — it will crawl imports from this file and create a project from the connected files. Or call master_architect.scan(path='${path.dirname(absPath)}', project_name='<name>') for a full directory scan instead.`,
  };
}

/**
 * For tests / diagnostics: clear the session cache. Real engines reset this
 * on process restart (i.e. when the user's MCP session starts fresh).
 */
export function _resetSession() {
  _loadedProjectsThisSession.clear();
  _rootsCache = null;
  _rootsCachedAtMs = 0;
}

/**
 * For tests / introspection.
 */
export function _getLoadedProjects() {
  return [..._loadedProjectsThisSession];
}


// ─── Write API: verification lifecycle ───────────────────────────────────
//
// These functions are called by read_file's commit/edit/open handlers to
// keep the architect's verification state in sync with the actual file.
// They use the write-capable DB handle (separate from the read handle).

/**
 * Promote a file's verification status to 'verified'. Increments version.
 * Called by read_file after a successful L3 verify+commit cycle.
 *
 * Returns null if the file isn't tracked by any project (silent no-op).
 */
export function markFileVerified(absPath, level) {
  const db = getWriteDb();
  if (!db) return null;
  absPath = path.resolve(absPath);

  const row = db.prepare(
    'SELECT id, version FROM files WHERE abs_path = ?'
  ).get(absPath);
  if (!row) return null;

  // Snapshot integrity data at verify time. This is the "fingerprint" of
  // exactly what we just verified — used later to detect if the file
  // changed outside our verification pipeline.
  let byteSize = null;
  let mtime = null;
  try {
    const stat = statSync(absPath);
    byteSize = stat.size;
    mtime = stat.mtime.toISOString();
  } catch {}
  const contentHash = sha256OfFile(absPath);

  const newVersion = row.version + 1;
  db.prepare(`
    UPDATE files
    SET verification_status = 'verified',
        version = ?,
        verified_at_level = ?,
        verified_at = datetime('now'),
        last_modified = ?,
        byte_size = ?,
        byte_size_at_verify = ?,
        content_hash = ?
    WHERE id = ?
  `).run(newVersion, level, mtime, byteSize, byteSize, contentHash, row.id);

  return {
    abs_path: absPath,
    file_id: row.id,
    previous_version: row.version,
    current_version: newVersion,
    verified_at_level: level,
    content_hash: contentHash,
    byte_size: byteSize,
  };
}

/**
 * Demote a file's verification status to 'unverified'. Does NOT decrement
 * version — version only increases. Called when file content changes
 * (commit of new edits, mtime drift, etc.).
 */
export function markFileUnverified(absPath) {
  const db = getWriteDb();
  if (!db) return null;
  absPath = path.resolve(absPath);

  const row = db.prepare(
    'SELECT id, verification_status FROM files WHERE abs_path = ?'
  ).get(absPath);
  if (!row) return null;
  if (row.verification_status === 'not_verifiable') return null;   // don't downgrade

  db.prepare(`
    UPDATE files
    SET verification_status = 'unverified',
        last_modified = datetime('now')
    WHERE id = ?
  `).run(row.id);

  return { abs_path: absPath, file_id: row.id };
}
/**
 * PLACEMENT GATE (section H2, step 1). Create a BARE v1 record for a file
 * under an ALREADY-DECIDED project. Project group is decided by the caller
 * (write_file resolves/asks; archivist import maps folder->project) BEFORE
 * this is called — the invariant is: a file enters the architect only with a
 * project group already assigned.
 *
 * The bare record is intentionally minimal: it EXISTS under the project, with
 * its path. address='pending', category='pending', parse_status='pending',
 * no content, no skeleton. The architect assigns the real address + structure
 * later, when the file is skeletonized (on commit / scan). "It gets its address
 * once the architect skeletonizes it."
 *
 * Idempotent: if a row already exists for this abs_path, returns it unchanged
 * (does NOT clobber a real scanned record with a bare one).
 *
 * Returns { filed, file_id, project_id, project_name, already_existed } or
 * null if the architect DB is unavailable.
 */
export function registerBareFile(absPath, projectId) {
  const db = getWriteDb();
  if (!db) return null;
  absPath = path.resolve(absPath);

  const project = db.prepare('SELECT id, name, root_path FROM projects WHERE id = ?').get(projectId);
  if (!project) return { filed: false, error: `no project with id ${projectId}` };

  // Already tracked? Return as-is; never downgrade a real record to bare.
  const existing = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (existing) {
    return { filed: true, file_id: existing.id, project_id: project.id,
             project_name: project.name, already_existed: true };
  }

  // rel_path relative to the project root (or basename if outside, though the
  // caller normally only files paths under the project root).
  let relPath = absPath;
  if (absPath === project.root_path) relPath = path.basename(absPath);
  else if (absPath.startsWith(project.root_path + path.sep)) {
    relPath = absPath.slice(project.root_path.length + 1);
  }
  const name = path.basename(absPath);

  const r = db.prepare(`
    INSERT INTO files
      (project_id, directory_id, address, name, rel_path, abs_path,
       language, category, parse_status, is_readable_text,
       verification_status, version, present_on_disk)
    VALUES (?, NULL, 'pending', ?, ?, ?, NULL, 'pending', 'pending', 1,
            'unverified', 0, 1)
  `).run(project.id, name, relPath, absPath);

  return { filed: true, file_id: r.lastInsertRowid, project_id: project.id,
           project_name: project.name, already_existed: false };
}
/**
 * Get or create an 'unknown_N' project for orphan-linked files (H8). Used
 * when read_file/write_file finds a file that belongs to NO existing project
 * and isn't under any project root. The cluster is captured immediately under
 * a placeholder project; the name self-corrects later (user rename, or
 * auto-absorb via mergeProjects when a chain file links into a real project).
 *
 * root_path uses a virtual sentinel 'unknown://N' (UNIQUE, never matches a
 * real disk path, so matchProjectRoot can't false-match it).
 *
 * Returns { project_id, name, created } or null if DB unavailable.
 */
export function getOrCreateUnknownProject() {
  const db = getWriteDb();
  if (!db) return null;

  // Find the highest existing unknown_N to pick the next N.
  const rows = db.prepare(
    "SELECT name FROM projects WHERE name LIKE 'unknown\\_%' ESCAPE '\\'"
  ).all();
  let maxN = 0;
  for (const r of rows) {
    const m = /^unknown_(\d+)$/.exec(r.name);
    if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
  }
  const n = maxN + 1;
  const name = `unknown_${n}`;
  const rootPath = `unknown://${n}`;

  const r = db.prepare(
    'INSERT INTO projects (name, root_path) VALUES (?, ?)'
  ).run(name, rootPath);
  return { project_id: r.lastInsertRowid, name, created: true };
}

/**
 * Merge/absorb one project's files into another (H8). Re-points project_id of
 * every file from `fromId` to `toId`. NO delete of files — ids, file_content,
 * file_versions all stay intact (consistent with H6.1 never-delete). The
 * now-empty source project row is removed (it references no files). Addresses
 * are stale after this — a scan of the target re-addresses cleanly.
 *
 * Used for: auto-absorb (an unknown_N chain turns out to link into a real
 * project) and manual "rename into existing project".
 *
 * Returns { merged, moved_files, from_id, to_id } or null if DB unavailable.
 */
export function mergeProjects(fromId, toId) {
  const db = getWriteDb();
  if (!db) return null;
  if (fromId === toId) return { merged: false, reason: 'same project', moved_files: 0, from_id: fromId, to_id: toId };

  const from = db.prepare('SELECT id FROM projects WHERE id = ?').get(fromId);
  const to   = db.prepare('SELECT id FROM projects WHERE id = ?').get(toId);
  if (!from) return { merged: false, reason: `no source project ${fromId}` };
  if (!to)   return { merged: false, reason: `no target project ${toId}` };

  const tx = db.transaction(() => {
    // A file's abs_path is globally UNIQUE, so no collision risk on re-point.
    const res = db.prepare(
      'UPDATE files SET project_id = ? WHERE project_id = ?'
    ).run(toId, fromId);
    // Source now references no files; drop the empty placeholder project.
    db.prepare('DELETE FROM directories WHERE project_id = ?').run(fromId);
    db.prepare('DELETE FROM databases WHERE project_id = ?').run(fromId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(fromId);
    return res.changes;
  });
  const moved = tx();
  return { merged: true, moved_files: moved, from_id: fromId, to_id: toId };
}
/**
 * ENTRY ORCHESTRATOR (paths 2 & 3, H7/H8). Resolve a file's project group and
 * file it as a bare record — NEVER prompts. Decision:
 *   - path under a known project root  -> file under that project.
 *   - else if linkedProjectId given (read_file found it linked to a file
 *     already in a real project)        -> file under that project.
 *   - else                              -> auto-create/find an unknown_N
 *                                          project and file there.
 * registerBareFile is idempotent, so calling this on an already-tracked file
 * is a no-op that returns the existing record.
 *
 * @param absPath          absolute path of the file to file
 * @param opts.linkedProjectId  optional: a real project id discovered via links
 * @returns { filed, file_id, project_id, project_name, placement } where
 *          placement is 'root_match' | 'linked' | 'unknown' | 'existing'
 */
export function fileIntoProject(absPath, opts = {}) {
  const db = getWriteDb();
  if (!db) return null;
  absPath = path.resolve(absPath);

  // Already tracked? Return as-is (idempotent, no re-placement).
  const existing = db.prepare('SELECT id, project_id FROM files WHERE abs_path = ?').get(absPath);
  if (existing) {
    const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(existing.project_id);
    return { filed: true, file_id: existing.id, project_id: existing.project_id,
             project_name: proj?.name ?? null, placement: 'existing' };
  }

  // 1. Under a known project root?
  const rootProject = matchProjectRoot(absPath);
  if (rootProject) {
    const r = registerBareFile(absPath, rootProject.id);
    return { ...r, placement: 'root_match' };
  }

  // 2. Linked to a file already in a real project? (read_file passes this in.)
  if (opts.linkedProjectId) {
    const lp = db.prepare('SELECT id FROM projects WHERE id = ?').get(opts.linkedProjectId);
    if (lp) {
      const r = registerBareFile(absPath, opts.linkedProjectId);
      return { ...r, placement: 'linked' };
    }
  }

  // 3. Orphan -> unknown_N cluster (self-corrects later via mergeProjects).
  const unknown = getOrCreateUnknownProject();
  if (!unknown) return null;
  const r = registerBareFile(absPath, unknown.project_id);
  return { ...r, placement: 'unknown' };
}
/**
 * PATH 3 (H7/H8/H9): file an opened file into a project by its KNOWN links,
 * and auto-absorb. Works from imports already in the DB (a file the architect
 * has parsed/scanned). For a brand-new unparsed file this is a no-op until the
 * crawl parses it (H9). Never prompts.
 *
 * Logic:
 *   - resolve the file's row; gather projects of its resolved links (both
 *     outgoing imports with resolved_file_id, and files that import IT).
 *   - pick the first REAL (non-unknown) linked project as the home.
 *   - file is UNPLACED -> file under that home (or unknown via fileIntoProject).
 *   - file in an unknown_N cluster AND a real linked project exists
 *     -> mergeProjects(unknown -> real) (auto-absorb).
 *
 * Returns { acted, action, ... } (action: 'none' | 'filed_linked' |
 * 'absorbed' | 'already_real').
 */
export function discoverAndFileByLinks(absPath) {
  const db = getWriteDb();
  if (!db) return null;
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id, project_id FROM files WHERE abs_path = ?').get(absPath);

  const isUnknownProject = (pid) => {
    const p = db.prepare('SELECT root_path FROM projects WHERE id = ?').get(pid);
    return !p || p.root_path.startsWith('unknown://');
  };

  let realLinkedProjectId = null;
  if (fileRow) {
    const linkRows = db.prepare(`
      SELECT f.project_id AS pid
      FROM imports i JOIN files f ON f.id = i.resolved_file_id
      WHERE i.file_id = ? AND i.resolved_file_id IS NOT NULL
      UNION
      SELECT f.project_id AS pid
      FROM imports i JOIN files f ON f.id = i.file_id
      WHERE i.resolved_file_id = ?
    `).all(fileRow.id, fileRow.id);
    for (const r of linkRows) {
      if (r.pid && !isUnknownProject(r.pid)) { realLinkedProjectId = r.pid; break; }
    }
  }

  // Case A: file already tracked.
  if (fileRow) {
    const inUnknown = isUnknownProject(fileRow.project_id);
    if (inUnknown && realLinkedProjectId) {
      const m = mergeProjects(fileRow.project_id, realLinkedProjectId);
      return { acted: true, action: 'absorbed', file_id: fileRow.id,
               into_project: realLinkedProjectId, merge: m };
    }
    return { acted: false, action: inUnknown ? 'none' : 'already_real',
             file_id: fileRow.id, project_id: fileRow.project_id };
  }

  // Case B: not tracked yet -> file it (linked real project if any, else
  // fileIntoProject decides root_match/unknown).
  const r = fileIntoProject(absPath, { linkedProjectId: realLinkedProjectId });
  return { acted: true, action: 'filed_linked', ...r };
}
/**
 * CHAIN-REACTION CRAWL (H7/H8/H9). Given a seed file already in project
 * `projectId`, walk the resolved-import graph (both directions) and pull every
 * transitively-connected file into the same project. Placement-only: this does
 * NOT parse (scan is the parser, H9) — it ensures membership, then the caller
 * can run a scan to parse any newly-absorbed files.
 *
 * Traversal uses the imports table edges that scan already populated:
 *   - outgoing: imports.resolved_file_id (files this file imports)
 *   - incoming: imports.file_id where resolved_file_id = me (files importing me)
 * Only edges to TRACKED files are followed (unparsed/untracked files have no
 * edges yet — they get edges after a scan, so re-running converges).
 *
 * Per neighbour that is NOT already in projectId:
 *   - if it is already TRACKED (in another project): use discoverAndFileByLinks,
 *     which absorbs an unknown_N cluster into the real project via mergeProjects
 *     (fileIntoProject alone would short-circuit on 'existing' and never move
 *     an already-tracked file — the absorb lives in discoverAndFileByLinks).
 *   - if it is UNTRACKED: fileIntoProject({linkedProjectId}) files a bare record
 *     under the target project.
 * Depth-limited; never prompts.
 *
 * Returns { ok, absorbed:[{abs_path, action}], visited, depth_reached }.
 */
export function chainReactionCrawl(seedAbsPath, projectId, opts = {}) {
  const db = getWriteDb();
  if (!db) return null;
  const maxDepth = opts.maxDepth ?? 6;
  seedAbsPath = path.resolve(seedAbsPath);

  const seedRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(seedAbsPath);
  if (!seedRow) return { ok: false, error: 'seed not tracked', absorbed: [], visited: 0 };

  const outStmt = db.prepare(
    'SELECT resolved_file_id AS fid FROM imports WHERE file_id = ? AND resolved_file_id IS NOT NULL'
  );
  const inStmt = db.prepare(
    'SELECT file_id AS fid FROM imports WHERE resolved_file_id = ?'
  );
  const absOf = db.prepare('SELECT abs_path, project_id FROM files WHERE id = ?');
  const projRoot = db.prepare('SELECT root_path FROM projects WHERE id = ?');
  const isUnknown = (pid) => {
    const p = projRoot.get(pid);
    return !p || p.root_path.startsWith('unknown://');
  };

  const visited = new Set([seedRow.id]);
  const queue = [{ id: seedRow.id, depth: 0 }];
  const absorbed = [];
  let depthReached = 0;

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth > depthReached) depthReached = depth;
    if (depth >= maxDepth) continue;

    const neighbours = [...outStmt.all(id), ...inStmt.all(id)].map(r => r.fid);
    for (const fid of neighbours) {
      if (fid == null || visited.has(fid)) continue;
      visited.add(fid);
      const row = absOf.get(fid);
      if (!row) continue;

      if (row.project_id !== projectId) {
        // Already tracked but in another project. If that project is an
        // unknown_N cluster, absorb it into the target via discoverAndFileByLinks
        // (it resolves the real linked project from this file's links and
        // mergeProjects's the cluster in). If it's a real different project,
        // leave it — crawling must not steal files across real projects.
        if (isUnknown(row.project_id)) {
          const d = discoverAndFileByLinks(row.abs_path);
          if (d && d.acted) absorbed.push({ abs_path: row.abs_path, action: d.action });
        }
        // (untracked files don't reach here — they have no id/row; they get
        // filed by write_file/read_file paths, then a scan gives them edges.)
      }
      queue.push({ id: fid, depth: depth + 1 });
    }
  }

  return { ok: true, absorbed, visited: visited.size, depth_reached: depthReached,
           needs_scan: absorbed.length > 0 };
}
/**
 * STORAGE LAYER (H, build step 4). Persist a file's committed content +
 * segment skeleton into the architect store, and append a version-history row.
 * Called from read_file's opCommit AFTER the disk write succeeds, on EVERY
 * commit (the bytes on disk are the truth regardless of verify level).
 *
 * file_content holds the CURRENT snapshot (one row per file, upserted).
 * file_versions appends an immutable row per commit (version_number
 * monotonically increasing per file). Content is stored as text; segments is
 * a JSON skeleton (structure only — addresses/kinds/names/lines — NOT raw
 * segment text, which would duplicate `content`).
 *
 * Idempotent on identical content: if the stored hash already matches, the
 * file_content row is left as-is and NO new version row is appended (avoids
 * version churn from no-op commits).
 *
 * @param absPath        absolute path of the committed file
 * @param content        the full committed text (buffer.assembleText())
 * @param segmentsJson    JSON string of the segment skeleton (or null)
 * @param opts.verifiedLevel  verify level at commit (1|2|3)
 * @param opts.hasParseErrors  whether the file had parse errors
 * @param opts.changeType      'created' | 'edit' | ... (default 'edit')
 * @param opts.changeSummary   optional human summary
 * @returns { stored, file_id, version_number, hash, unchanged } or null
 */
export function storeFileContent(absPath, content, segmentsJson, opts = {}) {
  const db = getWriteDb();
  if (!db) return null;
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) return { stored: false, reason: 'file not tracked' };
  const fileId = fileRow.id;

  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  const size = Buffer.byteLength(content, 'utf8');
  const verifiedLevel = opts.verifiedLevel ?? null;
  const hasParseErrors = opts.hasParseErrors ? 1 : 0;
  const language = opts.language ?? null;

  // No-op guard: if current stored content matches, don't churn versions.
  const existing = db.prepare('SELECT hash FROM file_content WHERE file_id = ?').get(fileId);
  if (existing && existing.hash === hash) {
    return { stored: true, file_id: fileId, hash, unchanged: true };
  }

  const tx = db.transaction(() => {
    // Upsert the current snapshot.
    db.prepare(`
      INSERT INTO file_content
        (file_id, hash, size, is_binary, language, content, segments, has_parse_errors, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(file_id) DO UPDATE SET
        hash = excluded.hash,
        size = excluded.size,
        language = excluded.language,
        content = excluded.content,
        segments = excluded.segments,
        has_parse_errors = excluded.has_parse_errors,
        updated_at = datetime('now')
    `).run(fileId, hash, size, language, content, segmentsJson ?? null, hasParseErrors);

    // Append a version row (version_number = max+1 for this file).
    const maxV = db.prepare(
      'SELECT COALESCE(MAX(version_number), 0) AS v FROM file_versions WHERE file_id = ?'
    ).get(fileId).v;
    const nextV = maxV + 1;
    db.prepare(`
      INSERT INTO file_versions
        (file_id, version_number, hash, size, content, segments,
         change_type, change_summary, verified_at_level, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(fileId, nextV, hash, size, content, segmentsJson ?? null,
           opts.changeType ?? (maxV === 0 ? 'created' : 'edit'),
           opts.changeSummary ?? null, verifiedLevel);

    // Keep files.version in sync with the latest version_number.
    db.prepare('UPDATE files SET version = ? WHERE id = ?').run(nextV, fileId);
    return nextV;
  });
  const versionNumber = tx();

  return { stored: true, file_id: fileId, version_number: versionNumber, hash, unchanged: false };
}
/**
 * H5 — read-from-store getter. Companion to storeFileContent. Pure DB, no disk
 * I/O: the caller passes the CURRENT content hash (it already has the bytes on
 * a read), and this reports whether the stored snapshot is fresh (hash match)
 * and hands back the stored skeleton + metadata.
 *
 * The stored `segments` JSON is byte-identical in shape to what opSkeleton
 * emits (both come from `buffer.segments.map((s,i)=>({n:i+1,...segmentToSummary(s)}))`),
 * so a fresh stored skeleton can be served in place of a live re-parse.
 *
 * @param absPath      absolute file path
 * @param currentHash  sha256 hex of the current on-disk/buffer content (or null
 *                     to skip the freshness check and just return what's stored)
 * @returns {found, fresh, hash, version, segments, has_parse_errors, language,
 *           size} | null if DB unavailable. `segments` is the PARSED array
 *          (not the raw JSON string); null if absent or unparseable.
 */
export function getStoredSkeleton(absPath, currentHash = null) {
  const db = getWriteDb();
  if (!db) return null;
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id, version FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) return { found: false, fresh: false, reason: 'file not tracked' };

  const row = db.prepare(
    'SELECT hash, size, language, segments, has_parse_errors FROM file_content WHERE file_id = ?'
  ).get(fileRow.id);
  if (!row) return { found: false, fresh: false, reason: 'no stored content' };

  const fresh = currentHash != null && row.hash === currentHash;

  let segments = null;
  if (row.segments) {
    try { segments = JSON.parse(row.segments); }
    catch { segments = null; }
  }

  return {
    found: true,
    fresh,
    hash: row.hash,
    version: fileRow.version,
    segments,
    has_parse_errors: !!row.has_parse_errors,
    language: row.language ?? null,
    size: row.size ?? null,
  };
}

/**
 * Refresh the modules/methods rows for a SINGLE file from its current content,
 * so navigate is fresh-per-file without a full project scan. Uses the shared
 * parse (worker parseTree -> architect walkers) for JS; falls back to skipping
 * for non-JS (caller can run a normal scan for those). Returns {refreshed, count}.
 *
 * Mirrors scan.js module-write semantics: clear existing rows for the file, then
 * insert fresh modules + methods addressed as <fileAddress>.<n>.
 */
export function refreshFileModules(absPath, content, language) {
  const db = getWriteDb();
  if (!db) return { refreshed: false, reason: "no db" };
  absPath = path.resolve(absPath);
  const fileRow = db.prepare("SELECT id, address FROM files WHERE abs_path = ?").get(absPath);
  if (!fileRow) return { refreshed: false, reason: "file not tracked" };
  // Shared-parse dispatch: languages whose extraction runs over the worker tree.
  const SHARED = {
    javascript: (rootNode, content) => jsParseWithRootNode(rootNode, content),
    python: (rootNode) => pyParseWithRootNode(rootNode),
    go: (rootNode) => goParseWithRootNode(rootNode),
    csharp: (rootNode) => csharpParseWithRootNode(rootNode),
    php: (rootNode) => phpParseWithRootNode(rootNode),
    swift: (rootNode) => swiftParseWithRootNode(rootNode),
    shell: (rootNode) => shellParseWithRootNode(rootNode),
    c: (rootNode) => cParseWithRootNode(rootNode),
    cpp: (rootNode) => cppParseWithRootNode(rootNode),
    java: (rootNode) => javaParseWithRootNode(rootNode),
    kotlin: (rootNode) => kotlinParseWithRootNode(rootNode),
    ruby: (rootNode) => rubyParseWithRootNode(rootNode),
    rust: (rootNode) => rustParseWithRootNode(rootNode),
  };
  const sharedFn = SHARED[language];
  if (!sharedFn) return { refreshed: false, reason: "lang not shared-parse yet: " + language };

  let analysis;
  try {
    const { rootNode } = parseTree(content, language);
    analysis = sharedFn(rootNode, content);
  } catch (err) {
    return { refreshed: false, reason: "parse error: " + err.message };
  }
  if (analysis.parse_error) return { refreshed: false, reason: analysis.parse_error };

  const clearMethods = db.prepare("DELETE FROM methods WHERE module_id IN (SELECT id FROM modules WHERE file_id = ?)");
  const clearModules = db.prepare("DELETE FROM modules WHERE file_id = ?");
  const insertModule = db.prepare("INSERT INTO modules (file_id, address, name, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)");
  const insertMethod = db.prepare("INSERT INTO methods (module_id, address, name, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)");
  const setHashStmt = db.prepare("UPDATE files SET content_hash = ? WHERE id = ?");
  // Match the hash scan computes (sha256 of utf8 content) so the next scan sees
  // this committed file as UNCHANGED and skips re-parsing it (Step 5 gate).
  const _committedHash = createHash("sha256").update(content, "utf8").digest("hex");

  const fileAddr = fileRow.address && fileRow.address !== "pending" ? fileRow.address : String(fileRow.id);
  const tx = db.transaction(() => {
    clearMethods.run(fileRow.id);
    clearModules.run(fileRow.id);
    setHashStmt.run(_committedHash, fileRow.id);
    analysis.modules.forEach((mod, modIdx) => {
      const modAddr = `${fileAddr}.${modIdx + 1}`;
      const mr = insertModule.run(fileRow.id, modAddr, mod.name, mod.kind, mod.line_start, mod.line_end);
      const modId = mr.lastInsertRowid;
      (mod.methods || []).forEach((m, mIdx) => {
        insertMethod.run(modId, `${modAddr}.${mIdx + 1}`, m.name, m.kind, m.line_start, m.line_end);
      });
    });
  });
  tx();
  return { refreshed: true, count: analysis.modules.length };
}








/**
 * On file open, check if disk mtime is newer than what we have in the DB.
 * If so, the file was edited out-of-band — flag as unverified.
 *
 * Returns { drifted: boolean } so the caller knows whether to surface it.
 */
export function checkAndHandleDrift(absPath) {
  const db = getDb();
  if (!db) return { drifted: false };
  absPath = path.resolve(absPath);

  const row = db.prepare(
    'SELECT id, last_modified, verification_status FROM files WHERE abs_path = ?'
  ).get(absPath);
  if (!row) return { drifted: false };
  if (row.verification_status === 'not_verifiable') return { drifted: false };
  if (!row.last_modified) return { drifted: false };

  let mtime;
  try { mtime = statSync(absPath).mtime; }
  catch { return { drifted: false }; }

  const dbMtime = new Date(row.last_modified);
  if (mtime <= dbMtime) return { drifted: false };

  // Drift detected
  if (row.verification_status === 'verified') {
    markFileUnverified(absPath);
    return { drifted: true, was_verified: true };
  }
  return { drifted: false };   // already unverified, nothing to do
}


// ─── Integrity check sweep ───────────────────────────────────────────────
//
// On first load of a project skeleton in a session, sweep every 'verified'
// file and confirm its on-disk fingerprint matches what we recorded at
// verify time. If anything differs (size, hash, or file gone), demote that
// file to 'unverified' — its current state is not the one WE verified,
// regardless of whether it might be valid in some other sense.
//
// Cheap stages so we don't pay full hash cost when we don't need to:
//   1. file missing on disk     → demote (file deleted or moved)
//   2. byte_size differs        → demote (any non-trivial edit)
//   3. content_hash differs     → demote (edit that preserved size — rare but possible)
//
// mtime is intentionally NOT used as a demotion trigger here. mtime drift
// is checked separately (per-file open) for cheap freshness detection.
// Integrity check is the slower, content-based truth.
//
// Returns a summary { checked, demoted, demoted_files: [...] } for logging.

export function runIntegrityCheck(projectId) {
  const db = getWriteDb();
  if (!db) return { checked: 0, demoted: 0, demoted_files: [] };

  const files = db.prepare(`
    SELECT id, abs_path, address, name, byte_size_at_verify, content_hash
    FROM files
    WHERE project_id = ?
      AND verification_status = 'verified'
  `).all(projectId);

  if (files.length === 0) return { checked: 0, demoted: 0, demoted_files: [] };

  const demoteStmt = db.prepare(`
    UPDATE files
    SET verification_status = 'unverified',
        last_modified = datetime('now')
    WHERE id = ?
  `);

  let demoted = 0;
  const demotedFiles = [];

  for (const f of files) {
    let reason = null;

    // Stage 1: still on disk?
    let stat;
    try {
      stat = statSync(f.abs_path);
    } catch {
      reason = 'file_missing';
    }

    // Stage 2: size match
    if (!reason && f.byte_size_at_verify != null && stat.size !== f.byte_size_at_verify) {
      reason = `size_changed (was ${f.byte_size_at_verify}, now ${stat.size})`;
    }

    // Stage 3: content hash match (only if we have a baseline hash to check against)
    if (!reason && f.content_hash) {
      const currentHash = sha256OfFile(f.abs_path);
      if (currentHash !== f.content_hash) {
        reason = 'content_changed';
      }
    }

    if (reason) {
      demoteStmt.run(f.id);
      demoted += 1;
      demotedFiles.push({
        address: f.address,
        name: f.name,
        abs_path: f.abs_path,
        reason,
      });
    }
  }

  return {
    checked: files.length,
    demoted,
    demoted_files: demotedFiles,
  };
}


// ─── L3 import-resolution check ──────────────────────────────────────────
//
// Used by read_file's verifyL3 to confirm that every local import in the
// buffer resolves to a known project file. External imports (npm/pip
// packages) and stdlib are ignored — we can't verify those without
// installing/checking the package, which is out of scope.
//
// Two paths:
//   - File is in a known project: query architect's existing imports table
//     filtered to is_external=0 AND resolved_file_id IS NULL → that's the
//     unresolved set
//   - File is NOT in any project: nothing to check, vacuously passes (the
//     verified flag is meaningless for files outside any project anyway,
//     so this is the right behavior)
//
// Returns:
//   { ok: true, checked, unresolved: [] }
//   { ok: false, checked, unresolved: [{import_path, line}, ...] }

export function checkImportResolution(absPath) {
  const db = getDb();
  if (!db) return { ok: true, checked: 0, unresolved: [], note: 'architect db unavailable, skipping check' };
  absPath = path.resolve(absPath);

  const fileRow = db.prepare(
    'SELECT id, project_id FROM files WHERE abs_path = ?'
  ).get(absPath);

  if (!fileRow) {
    return { ok: true, checked: 0, unresolved: [], note: 'file not in any project, no imports to check' };
  }

  // Get all imports for this file
  const imports = db.prepare(`
    SELECT import_path, line, resolved_file_id, is_external
    FROM imports
    WHERE file_id = ?
  `).all(fileRow.id);

  const localImports = imports.filter(i => i.is_external === 0);
  const unresolved = localImports
    .filter(i => i.resolved_file_id == null)
    .map(i => ({ import_path: i.import_path, line: i.line }));

  return {
    ok: unresolved.length === 0,
    checked: localImports.length,
    total_imports: imports.length,
    external_imports: imports.length - localImports.length,
    unresolved,
  };
}


// ─── L3 SQL query check (schema-only, never data-level) ────────────────
//
// Runs the SQL queries this file declared (extracted at scan time) against
// the linked database, asking SQLite to PARSE+PLAN them. We use prepare()
// rather than EXPLAIN because prepare validates against the live schema
// and never executes — same effect, cleaner API.
//
// Schema-only by design. Even against a 3TB SQLite DB, prepare cost is
// bounded by schema size, not data size.
//
// Returns:
//   { ok: true,  checked: N, failures: [], skipped: {...} }
//   { ok: false, checked: N, failures: [{ line, sql_preview, error, db }, ...] }
//   { ok: true,  note: "..." }   when nothing to check
//
// Like other L3 checks: gates the verified flag, NOT commit-to-disk.

export async function checkSqlQueries(absPath) {
  const db = getDb();
  if (!db) return { ok: true, note: 'architect db unavailable, skipping check' };
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) {
    return { ok: true, note: 'file not in any project, no SQL check' };
  }

  // Only fetch queries that are either unlinked (no inferred DB → we still
  // surface those as failures) or linked to a SQLite DB. Postgres queries
  // are handled by checkPostgresQueries — keeping the responsibilities split
  // so we don't double-report and so each adapter owns its own DB type.
  const queries = db.prepare(`
    SELECT sq.id, sq.line, sq.method, sq.sql,
           d.name AS db_name, d.path_or_uri AS db_path, d.type AS db_type
    FROM sql_queries sq
    LEFT JOIN databases d ON sq.inferred_database_id = d.id
    WHERE sq.file_id = ? AND sq.is_dynamic = 0
      AND (d.type IS NULL OR d.type = 'sqlite')
    ORDER BY sq.line
  `).all(fileRow.id);

  if (queries.length === 0) {
    return { ok: true, checked: 0, note: 'no static SQL queries to verify' };
  }

  // Group by target DB so we open each connection once
  const byDb = new Map();
  for (const q of queries) {
    const key = q.db_path || '__no_db_inferred__';
    if (!byDb.has(key)) byDb.set(key, { db_path: q.db_path, db_name: q.db_name, db_type: q.db_type, queries: [] });
    byDb.get(key).queries.push(q);
  }

  const failures = [];
  const diagnostics = [];
  let checked = 0;

  for (const [, group] of byDb) {
    // STRICT: a query without a verifiable DB cannot be "operational in
    // current state." Fail every such query rather than silently skipping.
    if (!group.db_path) {
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: '(none inferred)',
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: 'no database inferred for this query — architect could not determine which DB this query targets',
        });
      }
      continue;
    }
    if (group.db_type !== 'sqlite') {
      // For non-SQLite DBs we don't have a check yet. Treat as failure with
      // a clear "no adapter" message rather than silently passing.
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: group.db_name,
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: `no L3 adapter for db type '${group.db_type}' yet — query cannot be verified`,
        });
      }
      continue;
    }
    if (!existsSync(group.db_path)) {
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: group.db_name,
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: `database file does not exist at ${group.db_path}`,
        });
      }
      continue;
    }

    let liveDb;
    try {
      liveDb = new Database(group.db_path, { readonly: true, fileMustExist: true });
    } catch (err) {
      for (const q of group.queries) {
        checked += 1;
        failures.push({
          line: q.line,
          method: q.method,
          db: group.db_name,
          sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
          error: `cannot open database for verification: ${err.message}`,
        });
      }
      continue;
    }

    const dbDiagnostics = {
      db: group.db_name,
      path: group.db_path,
      tables_in_db: [],
      queries: [],
    };

    try {
      // Snapshot tables present in the DB so the LLM sees what was inspected
      try {
        dbDiagnostics.tables_in_db = liveDb.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        ).all().map(r => r.name);
      } catch {}

      for (const q of group.queries) {
        const result = explainAgainstSqlite(liveDb, q.sql);
        checked += 1;
        if (!result.ok) {
          failures.push({
            line: q.line,
            method: q.method,
            db: group.db_name,
            sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
            error: result.error,
          });
        } else {
          dbDiagnostics.queries.push({
            line: q.line,
            method: q.method,
            sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
            tables_touched: result.tables_touched,
            estimated_rows: result.total_estimated_rows,
            plan_steps: result.plan_steps,
          });
        }
      }
    } finally {
      try { liveDb.close(); } catch {}
    }

    diagnostics.push(dbDiagnostics);
  }

  return {
    ok: failures.length === 0,
    checked,
    failures,
    diagnostics,
  };
}

function explainAgainstSqlite(liveDb, sql) {
  const statements = splitSqlStatements(sql);
  const tables = new Set();
  let totalEstimatedRows = 0;
  const planSteps = [];

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (!stmt) continue;
    try {
      // prepare() validates the SQL against the live schema without executing
      liveDb.prepare(stmt);
    } catch (err) {
      return { ok: false, error: err.message, statement_index: i };
    }
    // Capture EXPLAIN QUERY PLAN to surface tables + estimated rows.
    // Only meaningful for read-shaped statements; failures here are silent
    // because we already know prepare() succeeded.
    //
    // Statements may have ? placeholders; better-sqlite3 requires every
    // placeholder be bound before .all() runs. Count them and bind nulls.
    try {
      const planStmt = liveDb.prepare(`EXPLAIN QUERY PLAN ${stmt}`);
      const paramMatches = stmt.match(/\?/g);
      const paramCount = paramMatches ? paramMatches.length : 0;
      const dummyParams = Array(paramCount).fill(null);
      const planRows = planStmt.all(...dummyParams);
      for (const row of planRows) {
        const detail = row.detail || '';
        planSteps.push(detail);
        // Extract table names from "SCAN <name>" or "SEARCH <name>" detail strings
        const m = detail.match(/^(?:SCAN|SEARCH)\s+(\S+)(?:\s|$)/);
        if (m) tables.add(m[1]);
      }
    } catch {}
  }

  // For each touched table, look up estimated row count from sqlite_stat1
  // if ANALYZE was run on this DB. Don't COUNT(*) — that's O(N) and we
  // promised never to read data.
  for (const t of tables) {
    try {
      const stat = liveDb.prepare(
        "SELECT stat FROM sqlite_stat1 WHERE tbl = ? AND idx IS NULL"
      ).get(t);
      if (stat && stat.stat) {
        const rows = parseInt(stat.stat.split(/\s+/)[0], 10);
        if (!isNaN(rows)) totalEstimatedRows += rows;
      }
    } catch {}
  }

  return {
    ok: true,
    tables_touched: [...tables],
    total_estimated_rows: totalEstimatedRows,
    plan_steps: planSteps,
  };
}

function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let inSingle = false, inDouble = false, inBracket = false;
  let inLineC = false, inBlockC = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (inLineC) { buf += c; if (c === '\n') inLineC = false; continue; }
    if (inBlockC) { buf += c; if (c === '*' && next === '/') { buf += next; i++; inBlockC = false; } continue; }
    if (inSingle) { buf += c; if (c === "'" && next === "'") { buf += next; i++; } else if (c === "'") inSingle = false; continue; }
    if (inDouble) { buf += c; if (c === '"' && next === '"') { buf += next; i++; } else if (c === '"') inDouble = false; continue; }
    if (inBracket) { buf += c; if (c === ']') inBracket = false; continue; }
    if (c === "'") { inSingle = true; buf += c; continue; }
    if (c === '"') { inDouble = true; buf += c; continue; }
    if (c === '[') { inBracket = true; buf += c; continue; }
    if (c === '-' && next === '-') { inLineC = true; buf += c; continue; }
    if (c === '/' && next === '*') { inBlockC = true; buf += c; continue; }
    if (c === ';') { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.length === 0 ? [sql] : out;
}


// ─── L3 LMDB sub-DB existence check (schema-only, never reads data) ────
//
// LMDB has no SQL. An env contains named sub-DBs (think: tables). Files
// that work with LMDB call env.open_db(b'name'). We capture each such
// reference at scan time, then at L3 verify we open the live env read-only
// and confirm the named sub-DBs actually exist.
//
// Schema-only by design. We list the env's named sub-DBs (registry only)
// without reading any data inside them. Even against multi-TB envs, this
// is bounded by the master-DB size (typically a dozen entries).
//
// Strict mode: missing env or missing sub-DB → L3 fails. Same contract as
// SQL: a query/reference against a non-existent target is not operational.

export async function checkLmdbSubDbs(absPath) {
  const db = getDb();
  if (!db) return { ok: true, note: 'architect db unavailable, skipping check' };
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) {
    return { ok: true, note: 'file not in any project, no LMDB check' };
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

  // Group by env so we probe each env once (probe is a subprocess; not free)
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
      // No inferred env — strict failure with explanation
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

    for (const r of group.refs) {
      checked += 1;
      if (!present.has(r.name)) {
        failures.push({
          line: r.line,
          name: r.name,
          env: group.db_name,
          error: `sub-DB '${r.name}' does not exist in env (env has: ${[...present].join(', ') || '(none — single-namespace env)'})`,
        });
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


// ─── L3 Postgres query check (schema-only, never executes the query) ───
//
// For Postgres-targeted queries: connect to the live DB using credentials
// extracted from the source code (the database row's `extra` JSON blob
// holds host/port/user/password/database), then run PREPARE+DEALLOCATE for
// each query. PREPARE validates syntax and schema references against the
// live database; DEALLOCATE cleans up the prepared statement. Neither
// reads or modifies row data.
//
// Connection failures (Postgres not running, network unreachable, auth
// rejected) are reported as failures with the connection error as the
// reason — same strict-mode philosophy as SQLite: unverifiable means
// L3 fails, force the user to fix the situation rather than silently pass.

export async function checkPostgresQueries(absPath) {
  const db = getDb();
  if (!db) return { ok: true, note: 'architect db unavailable, skipping check' };
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) {
    return { ok: true, note: 'file not in any project, no Postgres check' };
  }

  // Pull queries linked to a Postgres database (excludes sqlite-linked queries)
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

  // Group by connection (different files might use different DBs)
  const byConn = new Map();
  for (const q of queries) {
    const key = q.db_uri;
    if (!byConn.has(key)) byConn.set(key, { db_name: q.db_name, db_uri: q.db_uri, db_extra: q.db_extra, queries: [] });
    byConn.get(key).queries.push(q);
  }

  // Lazy load pg — only spin up the dep when we actually need it
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
        error: `pg package not available for verification: ${err.message}`,
      })),
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

    // Build pg client config. Falls back to libpq env-var defaults
    // (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) for missing fields.
    const clientCfg = {
      host: cfg.host || undefined,
      port: cfg.port || undefined,
      user: cfg.user || undefined,
      password: cfg.password || undefined,
      database: cfg.database || cfg.dbname || undefined,
      // Aggressive timeouts — verifier should be fast or fail fast
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
      // Connection failure → all this group's queries fail with reason
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

    try {
      // List tables for diagnostic
      try {
        const r = await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
        );
        dbDiag.tables_in_db = r.rows.map(row => row.table_name);
      } catch {}

      for (const q of group.queries) {
        checked += 1;
        const stmtName = `architect_check_${q.id}`;
        try {
          // PREPARE validates the query against the live schema without executing
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
          // Try to clean up the prepared statement in case of partial state
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


// Update the shared external-dependency inventory from a committing file.
// refs = output of gatherSpecs(): [{kind,name,locator,line,version,resolvedPath,extra}].
// Upserts each shared node by (kind, locator), refreshes version + resolvedPath,
// ensures the file's project membership + the file->ref edge. Best-effort.
export function updateExternalSpecs(absPath, refs) {
  const db = getWriteDb();
  if (!db || !Array.isArray(refs) || !refs.length) return null;
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id, project_id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) return null;

  const upsert = db.prepare(
    'INSERT INTO external_refs (kind, name, locator, version, extra) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(kind, locator) DO UPDATE SET ' +
    '  name = excluded.name, ' +
    '  version = COALESCE(excluded.version, external_refs.version), ' +
    '  extra = COALESCE(excluded.extra, external_refs.extra)'
  );
  const getId = db.prepare('SELECT id FROM external_refs WHERE kind = ? AND locator = ?');
  const addProj = db.prepare('INSERT OR IGNORE INTO external_ref_projects (external_ref_id, project_id) VALUES (?, ?)');
  const hasEdge = db.prepare('SELECT 1 FROM file_external_refs WHERE file_id = ? AND external_ref_id = ? LIMIT 1');
  const addEdge = db.prepare('INSERT INTO file_external_refs (file_id, external_ref_id, line) VALUES (?, ?, ?)');

  let updated = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      // fold resolvedPath into extra JSON (the key inventory signal for binaries)
      let extra = null;
      try {
        const base = r.extra ? JSON.parse(r.extra) : {};
        if (r.resolvedPath) base.resolved_path = r.resolvedPath;
        extra = Object.keys(base).length ? JSON.stringify(base) : null;
      } catch { extra = r.resolvedPath ? JSON.stringify({ resolved_path: r.resolvedPath }) : (r.extra || null); }

      upsert.run(r.kind, r.name, r.locator, r.version ?? null, extra);
      const row = getId.get(r.kind, r.locator);
      if (row) {
        addProj.run(row.id, fileRow.project_id);
        if (!hasEdge.get(fileRow.id, row.id)) addEdge.run(fileRow.id, row.id, r.line ?? null);
        updated++;
      }
    }
  });
  try { tx(refs); } catch (e) { console.error(`[architect-link] updateExternalSpecs error: ${e.message}`); return null; }
  return { updated, file_id: fileRow.id };
}
