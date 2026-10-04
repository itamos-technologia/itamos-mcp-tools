/**
 * Project scanner — walks a directory tree, classifies each file, populates the DB.
 *
 * Per-file lifecycle (memory-bounded):
 *   read content → parse → write file row + modules + methods → drop content + analysis
 *
 * Only a tiny "pending resolution" record is kept per file (imports + db decls)
 * for the second pass that resolves cross-file references.
 *
 * Address generation per directory:
 *   - `supported` files get numeric addresses: 1.1, 1.2, 1.3, ...
 *   - `coming_soon` and `opaque_*` files get letter addresses: 1.a, 1.b, ...
 *   - `unrecognized` files get no address and are skipped from the DB entirely
 *
 * Concurrency: per-user lock prevents the same user from running multiple
 * simultaneous scans (which would corrupt addressing). Different users are
 * independent (in production they have separate DBs).
 */

import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import {
  detectLanguage, isIgnoredDir, isIgnoredFile, getParser,
} from './registry.js';
import { getDb, estimateTokens, initialVerificationStatus, PARSER_VERSION } from './db.js';
import { parseTree } from './segmenter.js';
import { parseWithRootNode as jsParseWithRootNode } from './parsers/javascript.js';
import { parseWithRootNode as pyParseWithRootNode } from './parsers/python.js';
import { parseWithRootNode as goParseWithRootNode } from './parsers/go.js';
import { parseWithRootNode as csharpParseWithRootNode } from './parsers/csharp.js';
import { parseWithRootNode as phpParseWithRootNode } from './parsers/php.js';
import { parseWithRootNode as swiftParseWithRootNode } from './parsers/swift.js';
import { parseWithRootNode as shellParseWithRootNode } from './parsers/shell.js';
import { parseWithRootNode as cParseWithRootNode } from './parsers/c.js';
import { parseWithRootNode as cppParseWithRootNode } from './parsers/cpp.js';
import { parseWithRootNode as javaParseWithRootNode } from './parsers/java.js';
import { parseWithRootNode as kotlinParseWithRootNode } from './parsers/kotlin.js';
import { parseWithRootNode as rubyParseWithRootNode } from './parsers/ruby.js';
import { parseWithRootNode as rustParseWithRootNode } from './parsers/rust.js';
// Languages whose module/import/db extraction runs over the worker's shared parse
// tree (one parse, many projections). Each value takes (rootNode, content).
const SHARED_PARSERS = {
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

// ─── Concurrency control ─────────────────────────────────────────────────

const _activeScans = new Map();   // userId → { startedAt, startedAtMs, expectedMs }
const STALE_LOCK_MS = 10 * 60 * 1000;

function lockKey(userId) {
  // Sandbox: every user is "default", so scope the lock to the caller's slot,
  // or one user's scan would block everyone else's.
  const slot = globalThis.__sandboxCtx?.getStore?.()?.slotDir;
  return slot ? `${slot}|${userId || 'default'}` : (userId || 'default');
}

function tryAcquireScanLock(userId, expectedMs) {
  const key = lockKey(userId);
  const existing = _activeScans.get(key);
  if (existing) {
    const ageMs = Date.now() - existing.startedAtMs;
    if (ageMs < STALE_LOCK_MS) {
      const progressPct = existing.expectedMs
        ? Math.min(99, Math.floor((ageMs / existing.expectedMs) * 100))
        : null;
      return {
        acquired: false,
        existing_started_at: existing.startedAt,
        existing_elapsed_ms: ageMs,
        expected_total_ms: existing.expectedMs,
        progress_pct: progressPct,
      };
    }
    console.warn(`[scan] Overriding stale lock for user=${key} (age ${Math.round(ageMs/1000)}s)`);
  }
  _activeScans.set(key, {
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    expectedMs: expectedMs || null,
  });
  return { acquired: true };
}

function releaseScanLock(userId) {
  _activeScans.delete(lockKey(userId));
}

export function listActiveScans(userId) {
  const out = [];
  for (const [uid, info] of _activeScans.entries()) {
    if (userId && uid !== lockKey(userId)) continue;
    const _slot = globalThis.__sandboxCtx?.getStore?.()?.slotDir;
    if (_slot && !uid.startsWith(_slot + '|')) continue;
    out.push({
      user_id: uid,
      started_at: info.startedAt,
      elapsed_ms: Date.now() - info.startedAtMs,
    });
  }
  return out;
}

// ─── Address helpers ─────────────────────────────────────────────────────

function letterFor(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ─── File-level helpers ──────────────────────────────────────────────────

function readSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}
function statSafe(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function classifyForDb(detection) {
  switch (detection.kind) {
    case 'supported':
      return { category: 'supported', parse_status: 'parsed',
               is_readable_text: 1, language: detection.language };
    case 'coming_soon':
      return { category: 'coming_soon', parse_status: 'pending_language_support',
               is_readable_text: 1, language: detection.language };
    case 'opaque':
      return { category: detection.isBinary ? 'opaque_binary' : 'opaque_text',
               parse_status: 'not_analysed',
               is_readable_text: detection.isBinary ? 0 : 1,
               language: detection.language };
    default:
      return null;
  }
}

// ─── Walk ────────────────────────────────────────────────────────────────

function walk(rootAbs) {
  const directories = [];
  const files = [];

  function recurse(absDir, relDir, parentRelDir) {
    const dirName = relDir === '' ? path.basename(rootAbs) : path.basename(relDir);
    if (relDir !== '' && isIgnoredDir(dirName, absDir)) return;
    directories.push({ absPath: absDir, relPath: relDir, parentRelPath: parentRelDir, name: dirName });

    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const entryAbs = path.join(absDir, entry.name);
      const entryRel = relDir === '' ? entry.name : path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        recurse(entryAbs, entryRel, relDir);
      } else if (entry.isFile()) {
        if (isIgnoredFile(entry.name)) continue;
        const detection = detectLanguage(entryAbs);
        if (detection.kind === 'unrecognized') continue;
        files.push({
          absPath: entryAbs,
          relPath: entryRel,
          dirRelPath: relDir,
          name: entry.name,
          detection,
        });
      }
    }
  }

  recurse(rootAbs, '', null);
  return { directories, files };
}

// ─── Main scan ───────────────────────────────────────────────────────────

import { detectExternalRefs } from './external_detect.js';

// Project names are UNIQUE in the DB. Return `desired` if free (or already
// owned by excludeId), otherwise the first free "desired-N".
function uniqueProjectName(db, desired, excludeId = null) {
  const taken = (n) => {
    const row = db.prepare('SELECT id FROM projects WHERE name = ?').get(n);
    return !!row && row.id !== excludeId;
  };
  if (!taken(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!taken(candidate)) return candidate;
  }
}


export async function scanProject(rootPath, projectName, opts = {}) {
  const startMs = Date.now();
  const db = getDb();
  const userId = opts.userId || process.env.MCP_USER_ID || 'default';

  rootPath = path.resolve(rootPath);
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }
  const nameGiven = !!projectName;
  projectName = projectName || path.basename(rootPath);

  // Per-user scan lock
  const lock = tryAcquireScanLock(userId, opts.expectedMs);
  if (!lock.acquired) {
    return {
      ok: false,
      reason: 'already_running',
      user_id: userId,
      root_path: rootPath,
      project_name: projectName,
      started_at: lock.existing_started_at,
      elapsed_ms: lock.existing_elapsed_ms,
      expected_total_ms: lock.expected_total_ms,
      progress_pct: lock.progress_pct,
      message: lock.progress_pct !== null
        ? `Scan already in progress for user ${userId} (${lock.progress_pct}% complete, ~${Math.max(0, Math.round((lock.expected_total_ms - lock.existing_elapsed_ms)/1000))}s remaining). Do not retry; wait for completion.`
        : `Scan already in progress for user ${userId} (started ${Math.round(lock.existing_elapsed_ms/1000)}s ago). Do not retry; wait for completion.`,
    };
  }

  // Project upsert + RECONCILE prior data (never wipe files).
  // This runs BEFORE the try/finally below, so on any error release the
  // scan lock here, otherwise it stays held until STALE_LOCK_MS.
  let projectId, scanId, nameNote = null;
  try {
    const existing = db.prepare('SELECT id, name FROM projects WHERE root_path = ?').get(rootPath);
    // Rescan with no explicit name: keep the project's current name.
    if (existing && !nameGiven) projectName = existing.name;
    const freeName = uniqueProjectName(db, projectName, existing ? existing.id : null);
    if (freeName !== projectName) {
      nameNote = `Another project already uses the name '${projectName}', so this one was registered as '${freeName}'.`;
      projectName = freeName;
    }
    if (existing) {
      projectId = existing.id;
      db.prepare("UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(projectName, projectId);
      // RECONCILE, never wipe files. files rows are the stable identity that
      // file_content / file_versions hang off (ON DELETE CASCADE) — deleting
      // them would destroy the content store + version history.
      //
      // CRITICAL — DB-derived data (databases, db_connections, sql_queries,
      // lmdb_subdb_refs) is NO LONGER wiped project-wide here. The skip-gate
      // below leaves unchanged files un-reparsed, so a project-wide wipe would
      // permanently delete the DB picture of every skipped file (it is only
      // repopulated in the per-file parse path, which skips never reach). So:
      //   - directories: safe to wipe (re-addressed fresh each scan, nothing
      //     hangs off them).
      //   - databases / db_connections / sql_queries / lmdb_subdb_refs: cleared
      //     PER FILE inside the parse path (so a re-parsed file refreshes its own
      //     rows and a skipped file keeps them), with an end-of-scan GC removing
      //     databases that no longer have any connection. Mirrors how modules are
      //     handled.
      //   - files: mark ALL present_on_disk=0 now; the walk below flips back to
      //     1 (via upsert) for every file found. Anything still 0 at the end
      //     genuinely vanished from disk — kept, not deleted.
      db.prepare('DELETE FROM directories WHERE project_id = ?').run(projectId);
      db.prepare('UPDATE files SET present_on_disk = 0 WHERE project_id = ?').run(projectId);
    } else {
      const r = db.prepare('INSERT INTO projects (name, root_path) VALUES (?, ?)')
        .run(projectName, rootPath);
      projectId = r.lastInsertRowid;
    }
    scanId = db.prepare('INSERT INTO scans (project_id) VALUES (?)').run(projectId).lastInsertRowid;
  } catch (e) {
    releaseScanLock(userId);
    throw e;
  }

  const summary = {
    files_total: 0, files_parsed: 0, files_pending_lang: 0,
    files_opaque: 0, files_skipped: 0, files_errored: 0, files_unchanged: 0,
  };

  try {
    const { directories, files } = walk(rootPath);

    // ── Insert directories with addresses ──
    // ADDRESSING SCHEME (letters = dirs, numbers = files): a directory's
    // address segment is always a LETTER (a, b, ... z, aa, ...) and that
    // letter prefixes everything underneath it. A file's own (final) segment
    // is always a NUMBER. So directories and files can NEVER collide, and you
    // can tell at a glance: letter segment = dir, trailing number = file.
    // e.g. a.c.2 = file #2 in subdir c of top-level dir a.
    directories.sort((a, b) => {
      const da = a.relPath.split(path.sep).filter(Boolean).length;
      const db_ = b.relPath.split(path.sep).filter(Boolean).length;
      if (da !== db_) return da - db_;
      return a.relPath.localeCompare(b.relPath);
    });

    const dirIdByRelPath = new Map();
    const dirAddressByRelPath = new Map();
    const dirChildCounters = new Map();
    dirAddressByRelPath.set('', '');

    const insertDir = db.prepare(
      'INSERT INTO directories (project_id, parent_id, address, name, rel_path) VALUES (?, ?, ?, ?, ?)'
    );

    for (const d of directories) {
      if (d.relPath === '') continue;
      const parentAddr = dirAddressByRelPath.get(d.parentRelPath ?? '') ?? '';
      const counterKey = d.parentRelPath ?? '';
      const idx = (dirChildCounters.get(counterKey) ?? 0);   // 0-based for letterFor
      dirChildCounters.set(counterKey, idx + 1);
      const letter = letterFor(idx);                          // a, b, c, ...
      const addr = parentAddr === '' ? letter : `${parentAddr}.${letter}`;
      dirAddressByRelPath.set(d.relPath, addr);

      const parentId = d.parentRelPath ? dirIdByRelPath.get(d.parentRelPath) ?? null : null;
      const r = insertDir.run(projectId, parentId, addr, d.name, d.relPath);
      dirIdByRelPath.set(d.relPath, r.lastInsertRowid);
    }

    // ── Sort files for deterministic addressing ──
    files.sort((a, b) => {
      if (a.dirRelPath !== b.dirRelPath) return a.dirRelPath.localeCompare(b.dirRelPath);
      const aSupported = a.detection.kind === 'supported' ? 0 : 1;
      const bSupported = b.detection.kind === 'supported' ? 0 : 1;
      if (aSupported !== bSupported) return aSupported - bSupported;
      return a.name.localeCompare(b.name);
    });

    // ── Per-file: read → parse → write → drop ──
    // UPSERT on abs_path so an existing file keeps its id (and its
    // file_content / file_versions). present_on_disk flips back to 1 here.
    const upsertFile = db.prepare(`
      INSERT INTO files
        (project_id, directory_id, address, name, rel_path, abs_path,
         language, category, parse_status, is_readable_text,
         line_count, byte_size, est_tokens, last_modified,
         verification_status, version, present_on_disk)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)
      ON CONFLICT(abs_path) DO UPDATE SET
        project_id    = excluded.project_id,
        directory_id  = excluded.directory_id,
        address       = excluded.address,
        name          = excluded.name,
        rel_path      = excluded.rel_path,
        language      = excluded.language,
        category      = excluded.category,
        parse_status  = excluded.parse_status,
        is_readable_text = excluded.is_readable_text,
        line_count    = excluded.line_count,
        byte_size     = excluded.byte_size,
        est_tokens    = excluded.est_tokens,
        last_modified = excluded.last_modified,
        present_on_disk = 1
    `);
    const getFileId = db.prepare('SELECT id FROM files WHERE abs_path = ?');
    // Clear prior per-file structure (the row persists; its modules/methods
    // are re-derived each scan). Methods cascade via their module FK. DB-derived
    // rows are cleared here too (not project-wide) so skipped files keep theirs.
    const clearModules = db.prepare('DELETE FROM modules WHERE file_id = ?');
    const clearImports = db.prepare('DELETE FROM imports WHERE file_id = ?');
    const clearDbConns = db.prepare('DELETE FROM db_connections WHERE file_id = ?');
    const clearSqlQueries = db.prepare('DELETE FROM sql_queries WHERE file_id = ?');
    const clearLmdbRefs = db.prepare('DELETE FROM lmdb_subdb_refs WHERE file_id = ?');
    const clearFileExtRefs = db.prepare('DELETE FROM file_external_refs WHERE file_id = ?');
    // STEP 5 gate: read stored content_hash + parser_version + module count to
    // decide skip. A file is only skipped when content AND parser version are
    // both unchanged — so a PARSER_VERSION bump forces a one-time re-parse of
    // every file, the clean rollout path for detection-logic changes.
    const getHashAndModCount = db.prepare('SELECT content_hash AS h, parser_version AS pv, (SELECT COUNT(*) FROM modules WHERE file_id = files.id) AS mc FROM files WHERE id = ?');
    // Record both the content hash and the parser version that produced this
    // parse, so the next scan's gate can compare against the current version.
    const setContentHash = db.prepare('UPDATE files SET content_hash = ?, parser_version = ? WHERE id = ?');
    // Unchanged (skipped) files that still have unresolved imports: re-linked
    // after the second pass, since a file added in this scan may satisfy them.
    const hasUnresolved = db.prepare('SELECT 1 FROM imports WHERE file_id = ? AND resolved_file_id IS NULL LIMIT 1');
    const relinkLater = [];
    const insertModule = db.prepare(
      'INSERT INTO modules (file_id, address, name, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertMethod = db.prepare(
      'INSERT INTO methods (module_id, address, name, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const updateFileStatus = db.prepare(
      'UPDATE files SET parse_status = ?, verification_status = ? WHERE id = ?'
    );

    const fileCountersByDir = new Map();
    const fileIdByAbsPath = new Map();
    // Cross-project fallback: an import can resolve to a real file that lives
    // outside this project's root but is already scanned under another project.
    // Look it up globally by abs_path so the edge resolves instead of dangling.
    const globalFileByAbsPath = db.prepare('SELECT id FROM files WHERE abs_path = ? LIMIT 1');
    const externalRefsByFile = new Map();  // fileId -> [{kind,name,locator,line,extra}]
    // Lightweight pending-resolution data: just imports + databases per file.
    // Modules/methods already written, content already dropped.
    const pendingResolution = new Map();   // fileId → { imports: [...], databases: [...], parserName, fromAbsFile }

    for (const f of files) {
      summary.files_total += 1;
      const cls = classifyForDb(f.detection);
      if (!cls) { summary.files_skipped += 1; continue; }

      const dirAddr = dirAddressByRelPath.get(f.dirRelPath) ?? '';
      // ALL files (supported AND opaque) get NUMBER addresses now — the
      // letter namespace belongs exclusively to directories, so files and
      // dirs can never share an address. Single counter per directory.
      const nextNum = (fileCountersByDir.get(f.dirRelPath) ?? 0) + 1;
      fileCountersByDir.set(f.dirRelPath, nextNum);
      const fileAddr = dirAddr === '' ? String(nextNum) : `${dirAddr}.${nextNum}`;

      const stat = statSafe(f.absPath);
      const byteSize = stat?.size ?? 0;
      const lastModified = stat ? stat.mtime.toISOString() : null;
      const estTokens = estimateTokens(byteSize);

      // Read file content (skip for binary). This is the only point we hold content.
      let content = null;
      let lineCount = null;
      if (cls.is_readable_text) {
        content = readSafe(f.absPath);
        if (content !== null) {
          lineCount = content.length === 0 ? 0 : content.split('\n').length;
        }
      }

      // Upsert file row (keeps id + content/versions if it already existed).
      const dirId = f.dirRelPath ? dirIdByRelPath.get(f.dirRelPath) : null;
      const initialStatus = initialVerificationStatus(cls.category, cls.parse_status);
      upsertFile.run(
        projectId, dirId ?? null, fileAddr, f.name, f.relPath, f.absPath,
        cls.language, cls.category, cls.parse_status, cls.is_readable_text,
        lineCount, byteSize, estTokens, lastModified,
        initialStatus,
      );
      const fileId = getFileId.get(f.absPath).id;
      fileIdByAbsPath.set(f.absPath, fileId);

      // STEP 5 version+hash gate: skip the clear+parse+reinsert ONLY when the
      // file's content is unchanged (stored content_hash matches) AND it was
      // parsed by the CURRENT parser version (stored parser_version matches)
      // AND it already has modules. If detection logic changed (PARSER_VERSION
      // bumped), pv won't match and the file re-parses exactly once. Only gate
      // supported, readable files that have content (so we can hash).
      //
      // Because DB-derived rows are no longer wiped project-wide, a skipped
      // file's databases / db_connections / sql_queries / lmdb_subdb_refs all
      // remain intact here — which is exactly the point of this change.
      if (cls.category === 'supported' && content !== null) {
        const curHash = createHash('sha256').update(content, 'utf8').digest('hex');
        const row = getHashAndModCount.get(fileId);
        if (row && row.h && row.h === curHash && row.pv === PARSER_VERSION && row.mc > 0) {
          summary.files_unchanged += 1;
          summary.files_parsed += 1;  // count it as 'covered' for totals parity
          content = null;  // drop reference for GC
          if (hasUnresolved.get(fileId)) relinkLater.push({ fileId, absPath: f.absPath, detection: f.detection });
          continue;        // keep existing modules/imports/db rows intact
        }
        // changed, never-hashed, or parser-version-stale → record the new hash
        // + current parser version, then fall through to reparse.
        setContentHash.run(curHash, PARSER_VERSION, fileId);
      }

      // Clear stale structure for this (possibly pre-existing) file row. This is
      // the ONLY place DB-derived rows get cleared now — per file, on re-parse.
      clearModules.run(fileId);
      clearImports.run(fileId);
      clearDbConns.run(fileId);
      clearSqlQueries.run(fileId);
      clearLmdbRefs.run(fileId);
      clearFileExtRefs.run(fileId);

      // Parse if supported
      if (cls.category === 'supported' && content !== null) {
        try {
          const parser = await getParser(f.detection.language, f.detection.parserFile);
          if (!parser) {
            updateFileStatus.run('parse_error', 'not_verifiable', fileId);
            summary.files_errored += 1;
            content = null;   // drop reference for GC
            continue;
          }
          // SHARED-PARSE (boss/worker unification): for JS, parse ONCE via the
          // worker and run the architect's walkers over that same rootNode. Proven
          // byte-identical to parseFile. Other languages keep their own parseFile.
          let analysis;
          const sharedFn = SHARED_PARSERS[f.detection.language];
          if (sharedFn) {
            const { rootNode } = parseTree(content, f.detection.language);
            analysis = sharedFn(rootNode, content);
          } else {
            analysis = parser.parseFile(content);
          }
          // External refs (servers/models/services/binaries/ports) — detect from
          // raw content BEFORE dropping it. Stashed for the second pass.
          try {
            const _ext = detectExternalRefs(content, f.detection.language);
            // Merge any external refs the PARSER itself produced (e.g. the nginx
            // parser emits listen/proxy_pass endpoints with role metadata that
            // generic text detection can't see). Parser refs carry `extra` as an
            // object; normalize to the JSON-string form the store expects.
            const _parserExt = (analysis.external_refs || []).map(r => ({
              kind: r.kind, name: r.name, locator: r.locator, line: r.line,
              extra: r.extra == null ? null : (typeof r.extra === 'string' ? r.extra : JSON.stringify(r.extra)),
            }));
            // Code listeners (app.listen / createServer().listen) become
            // external refs with role='listen', SAME shape as an nginx `listen`.
            // locator = host:port (host defaults to 0.0.0.0 when not a literal),
            // so an nginx upstream pointing at 127.0.0.1:<port> can be matched to
            // the code file that listens on that port. port=null (env-only, no
            // literal) is stored honestly with locator host:'?' and no match.
            for (const L of (analysis.listeners || [])) {
              const host = L.host || '0.0.0.0';
              const locator = L.port != null ? `${host}:${L.port}` : `${host}:?`;
              _parserExt.push({
                kind: 'server', name: locator, locator, line: L.line,
                extra: JSON.stringify({ role: 'listen', host, port: L.port, port_expr: L.port_expr, source: 'code' }),
              });
            }
            // The global external_refs table is keyed by (kind, locator), so two
            // refs with the same kind+locator collapse to one row there — the
            // richer one must win. Parser-supplied refs (role=listen/upstream,
            // ssl, etc.) are authoritative over generic text detection, which
            // produces the same host:port with no role. So we take parser refs
            // FIRST and only add a generic ref when its kind+locator isn't
            // already covered by a parser ref.
            const _merged = [];
            const _byKL = new Set();          // kind|locator already taken
            for (const r of _parserExt) {
              const k = r.kind + '|' + r.locator;
              if (_byKL.has(k)) continue;     // collapse parser-internal dupes
              _byKL.add(k); _merged.push(r);
            }
            for (const r of (_ext || [])) {
              const k = r.kind + '|' + r.locator;
              if (_byKL.has(k)) continue;     // parser already owns this endpoint
              _byKL.add(k); _merged.push(r);
            }
            if (_merged.length) externalRefsByFile.set(fileId, _merged);
          } catch (_e) { /* detection must never break a scan */ }
          // Drop content immediately — we don't need it anymore.
          content = null;

          if (analysis.parse_error) {
            updateFileStatus.run('parse_error', 'not_verifiable', fileId);
            summary.files_errored += 1;
            continue;
          }

          // Write modules + methods to DB right now, then drop the analysis tree.
          analysis.modules.forEach((mod, modIdx) => {
            const modAddr = `${fileAddr}.${modIdx + 1}`;
            const mr = insertModule.run(fileId, modAddr, mod.name, mod.kind,
                                        mod.line_start, mod.line_end);
            const modId = mr.lastInsertRowid;
            (mod.methods || []).forEach((m, mIdx) => {
              insertMethod.run(modId, `${modAddr}.${mIdx + 1}`,
                               m.name, m.kind, m.line_start, m.line_end);
            });
          });

          // Keep ONLY the small lists for second pass (imports + db decls).
          // Modules/methods are already written. Drop everything else.
          if (analysis.imports.length > 0 ||
              analysis.databases.length > 0 ||
              (analysis.sql_queries && analysis.sql_queries.length > 0) ||
              (analysis.lmdb_subdbs && analysis.lmdb_subdbs.length > 0) ||
              (analysis.dynamic_loads && analysis.dynamic_loads.length > 0) ||
              externalRefsByFile.has(fileId)) {
            pendingResolution.set(fileId, {
              imports: analysis.imports,
              databases: analysis.databases,
              sql_queries: analysis.sql_queries || [],
              lmdb_subdbs: analysis.lmdb_subdbs || [],
              dynamic_loads: analysis.dynamic_loads || [],
              parserResolveImport: parser.resolveImport,
              parserIsLocalModule: parser.isLocalModule,
              fromAbsFile: f.absPath,
            });
          }
          summary.files_parsed += 1;

        } catch (err) {
          updateFileStatus.run('parse_error', 'not_verifiable', fileId);
          summary.files_errored += 1;
          content = null;
        }
      } else if (cls.category === 'coming_soon') {
        summary.files_pending_lang += 1;
        content = null;
      } else {
        summary.files_opaque += 1;
        content = null;
      }
    }

    // ── Second pass: resolve imports + record db connections ──
    const insertDatabase = db.prepare(
      'INSERT INTO databases (project_id, address, name, type, path_or_uri, extra) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertSqlQuery = db.prepare(
      'INSERT INTO sql_queries (file_id, line, method, sql, is_dynamic, inferred_database_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertLmdbRef = db.prepare(
      'INSERT INTO lmdb_subdb_refs (file_id, line, name, inferred_database_id) VALUES (?, ?, ?, ?)'
    );
    const insertDbConn = db.prepare(
      'INSERT INTO db_connections (file_id, database_id, line) VALUES (?, ?, ?)'
    );
    const insertImport = db.prepare(
      'INSERT INTO imports (file_id, import_path, resolved_file_id, is_external, line, edge_kind) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // Database identity is (project_id, path_or_uri). Because databases are no
    // longer wiped project-wide, SEED dbByPath from rows that already exist so a
    // re-parsed file REUSES the existing database row instead of inserting a
    // duplicate. New paths still get a fresh row. Stale rows (no connections
    // left after this scan) are GC'd at the end.
    const dbByPath = new Map();
    for (const r of db.prepare('SELECT id, path_or_uri FROM databases WHERE project_id = ?').all(projectId)) {
      if (r.path_or_uri != null) dbByPath.set(r.path_or_uri, r.id);
    }
    // dbCounter only feeds the synthetic `99.N` address for NEW databases; start
    // it past any existing count to avoid address collisions.
    let dbCounter = db.prepare('SELECT COUNT(*) AS c FROM databases WHERE project_id = ?').get(projectId).c;

    // Prepared statements for external refs (shared nodes, global identity).
    const upsertExtRef = db.prepare(
      'INSERT INTO external_refs (kind, name, locator, version, extra) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(kind, locator) DO UPDATE SET ' +
      '  name  = excluded.name, ' +
      // Refresh extra when the incoming row carries metadata (e.g. the nginx
      // parser's role=listen/upstream + ssl). A null/absent incoming extra must
      // NOT wipe an existing one, so COALESCE keeps the old value in that case.
      // This lets a richer parser ref upgrade a generic role-less row that was
      // inserted first (text detection, or another project).
      '  extra = COALESCE(excluded.extra, external_refs.extra) ' +
      'WHERE external_refs.name != excluded.name ' +
      '   OR (excluded.extra IS NOT NULL AND IFNULL(external_refs.extra, \'\') != excluded.extra)'
    );
    const getExtRefId = db.prepare('SELECT id FROM external_refs WHERE kind = ? AND locator = ?');
    const addExtRefProject = db.prepare(
      'INSERT OR IGNORE INTO external_ref_projects (external_ref_id, project_id) VALUES (?, ?)'
    );
    const insertFileExtRef = db.prepare(
      'INSERT INTO file_external_refs (file_id, external_ref_id, line) VALUES (?, ?, ?)'
    );

    for (const [fileId, pr] of pendingResolution.entries()) {
      // External refs first (shared nodes deduped globally by kind+locator).
      const extRefs = externalRefsByFile.get(fileId);
      if (extRefs) {
        for (const er of extRefs) {
          upsertExtRef.run(er.kind, er.name, er.locator, er.version ?? null, er.extra ?? null);
          const row = getExtRefId.get(er.kind, er.locator);
          if (row) {
            addExtRefProject.run(row.id, projectId);
            insertFileExtRef.run(fileId, row.id, er.line ?? null);
          }
        }
      }
      // Databases first. Build, per file, the maps needed to attribute each SQL
      // query to the SPECIFIC handle it runs against:
      //   handleVarToDbId : handle variable name  → database id  (exact match key)
      //   sqlDbIds        : every SQL-shaped db id for this file (sqlite/postgres/mysql/duckdb)
      // These replace the old "first SQL db wins" (LIMIT 1) attribution, which
      // mis-linked every query in any file that opens more than one DB handle.
      const handleVarToDbId = new Map();
      const sqlDbIds = [];
      for (const dbDecl of pr.databases) {
        let dbId = dbByPath.get(dbDecl.path_or_uri);
        if (!dbId) {
          dbCounter += 1;
          const addr = `99.${dbCounter}`;
          const r = insertDatabase.run(projectId, addr, dbDecl.name, dbDecl.type, dbDecl.path_or_uri, dbDecl.extra ?? null);
          dbId = r.lastInsertRowid;
          dbByPath.set(dbDecl.path_or_uri, dbId);
        }
        insertDbConn.run(fileId, dbId, dbDecl.line ?? null);
        // handle_var comes off the parsed decl (added by walkDatabases). It is
        // the variable the connection was bound to, e.g. `dbPath` / `DB_PATH`.
        if (dbDecl.handle_var) handleVarToDbId.set(dbDecl.handle_var, dbId);
        if (['sqlite', 'postgres', 'mysql', 'duckdb'].includes(dbDecl.type)) sqlDbIds.push(dbId);
      }
      // Imports — resolve against project files.
      //
      // is_external = 0 when the import is local by syntax ('.' or '/'),
      // resolves to a project file, or is rooted in a project package
      // (parser.isLocalModule). Only the rest are external packages.
      // resolved_file_id is set when the import resolves. is_external=0 with
      // resolved_file_id=null is a BROKEN internal import: that's what the
      // missing-import check and L3 verification look for.
      for (const imp of pr.imports) {
        const looksLocal = imp.import_path.startsWith('.') || imp.import_path.startsWith('/');
        let resolvedId = null;
        if (pr.parserResolveImport) {
          const resolvedPath = pr.parserResolveImport(imp.import_path, pr.fromAbsFile, fs, path, rootPath);
          if (resolvedPath) {
            let lookupId = fileIdByAbsPath.get(resolvedPath);
            if (!lookupId) {
              // Not in this project — try the global files table (cross-project).
              const g = globalFileByAbsPath.get(resolvedPath);
              if (g) lookupId = g.id;
            }
            if (lookupId) {
              resolvedId = lookupId;
            }
          }
        }
        const isExternal = (looksLocal || resolvedId ||
          (pr.parserIsLocalModule && pr.parserIsLocalModule(imp.import_path, pr.fromAbsFile, fs, path, rootPath))) ? 0 : 1;
        insertImport.run(fileId, imp.import_path, resolvedId, isExternal, imp.line ?? null, 'import');
      }

      // Plugin-load edges. For each detected readdir-load idiom in this file,
      // resolve the directory it scans to an absolute path, enumerate the files
      // matching the extension filter, and emit a 'load' edge (edge_kind='load')
      // to each one that is a real file in this project. This re-surfaces the
      // connection that modular/plugin loading hides from static import analysis.
      // Resolution is honest: only `path.join(__dirname[, 'a'[, 'b']])` and bare
      // string-literal directory expressions are resolved (relative to the
      // loader file's own directory). Anything runtime-determined yields no edge.
      for (const dl of (pr.dynamic_loads || [])) {
        const loaderDir = path.dirname(pr.fromAbsFile);
        let targetDir = null;
        const expr = (dl.dir_expr || '').trim();
        // path.join(__dirname, 'x', 'y', ...) -> loaderDir/x/y
        const pj = expr.match(/^path\.join\(\s*__dirname\s*(?:,\s*['"]([^'"]+)['"]\s*)*\)$/);
        if (pj) {
          const parts = [...expr.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
          targetDir = path.resolve(loaderDir, ...parts);
        } else if (/^__dirname$/.test(expr)) {
          targetDir = loaderDir;
        } else {
          const lit = expr.match(/^['"]([^'"]+)['"]$/);
          if (lit) targetDir = path.isAbsolute(lit[1]) ? lit[1] : path.resolve(loaderDir, lit[1]);
        }
        if (!targetDir) continue;                 // unresolved -> no guess, no edge
        let entries;
        try { entries = fs.readdirSync(targetDir); } catch { continue; }
        const ext = dl.ext;                       // e.g. '.js' or null (take all)
        for (const entry of entries) {
          if (ext && !entry.endsWith(ext)) continue;
          const full = path.join(targetDir, entry);
          let st; try { st = fs.statSync(full); } catch { continue; }
          if (!st.isFile()) continue;
          // match to a project file by abs_path (in-project first, then global)
          let targetId = fileIdByAbsPath.get(full);
          if (!targetId) { const g = globalFileByAbsPath.get(full); if (g) targetId = g.id; }
          if (!targetId) continue;                // loaded file not indexed -> skip
          if (targetId === fileId) continue;      // don't self-link
          insertImport.run(fileId, full, targetId, 0, dl.line ?? null, 'load');
        }
      }

      // SQL queries: attribute each query to the RIGHT database handle.
      //   1. If the query's receiver (the object the SQL method was called on)
      //      matches a known handle variable → link to that exact db. Correct
      //      even when the file opens several handles.
      //   2. Else, if the file has exactly ONE SQL-shaped db → link to it; the
      //      attribution is unambiguous regardless of receiver text.
      //   3. Else (receiver unknown AND multiple candidate dbs) → leave NULL.
      //      We do NOT guess: a wrong link is worse than an honest null, which
      //      the L3 check surfaces as an unresolved case.
      for (const q of (pr.sql_queries || [])) {
        let inferredDbId = null;
        if (q.receiver && handleVarToDbId.has(q.receiver)) {
          inferredDbId = handleVarToDbId.get(q.receiver);
        } else if (sqlDbIds.length === 1) {
          inferredDbId = sqlDbIds[0];
        } else {
          inferredDbId = null;  // ambiguous + unmatched → honest null, no guess
        }
        insertSqlQuery.run(
          fileId,
          q.line ?? null,
          q.method ?? null,
          q.sql,
          q.dynamic ? 1 : 0,
          inferredDbId,
        );
      }

      // LMDB sub-DB references: link to the file's first lmdb env
      const fileLmdbDb = db.prepare(`
        SELECT d.id FROM databases d
        JOIN db_connections dc ON dc.database_id = d.id
        WHERE d.project_id = ? AND dc.file_id = ? AND d.type = 'lmdb'
        LIMIT 1
      `).get(projectId, fileId);
      const lmdbDbId = fileLmdbDb?.id ?? null;
      for (const ref of (pr.lmdb_subdbs || [])) {
        insertLmdbRef.run(fileId, ref.line ?? null, ref.name, lmdbDbId);
      }
    }

    // ── Re-link unchanged files ──
    // Files skipped as unchanged keep their import rows, but a file added or
    // renamed in THIS scan can now satisfy an import that was unresolved
    // before. Re-resolve those (same rules as the second pass) so the graph
    // doesn't depend on which files happened to change.
    if (relinkLater.length) {
      const getUnresolved = db.prepare('SELECT id, import_path FROM imports WHERE file_id = ? AND resolved_file_id IS NULL');
      const setResolution = db.prepare('UPDATE imports SET resolved_file_id = ?, is_external = ? WHERE id = ?');
      for (const r of relinkLater) {
        let parser;
        try { parser = await getParser(r.detection.language, r.detection.parserFile); } catch { continue; }
        if (!parser || !parser.resolveImport) continue;
        for (const imp of getUnresolved.all(r.fileId)) {
          const looksLocal = imp.import_path.startsWith('.') || imp.import_path.startsWith('/');
          let resolvedId = null;
          try {
            const resolvedPath = parser.resolveImport(imp.import_path, r.absPath, fs, path, rootPath);
            if (resolvedPath) resolvedId = fileIdByAbsPath.get(resolvedPath) || globalFileByAbsPath.get(resolvedPath)?.id || null;
          } catch {}
          const isExternal = (looksLocal || resolvedId ||
            (parser.isLocalModule && parser.isLocalModule(imp.import_path, r.absPath, fs, path, rootPath))) ? 0 : 1;
          setResolution.run(resolvedId, isExternal, imp.id);
        }
      }
      summary.files_relinked = relinkLater.length;
    }

    // ── GC: remove databases that no longer have any connection ──
    // Because we stopped wiping databases project-wide, a database whose last
    // referencing file was deleted (or stopped opening it) would otherwise
    // linger forever. Delete project databases with zero db_connections. SQL
    // queries / lmdb refs that pointed at them were already cleared per file.
    db.prepare(`
      DELETE FROM databases
      WHERE project_id = ?
        AND id NOT IN (SELECT DISTINCT database_id FROM db_connections)
    `).run(projectId);

    // ── Finalise scan record ──
    const durationMs = Date.now() - startMs;
    db.prepare(`
      UPDATE scans
      SET finished_at = datetime('now'),
          duration_ms = ?,
          files_total = ?, files_parsed = ?,
          files_pending_lang = ?, files_opaque = ?,
          files_skipped = ?, files_errored = ?
      WHERE id = ?
    `).run(durationMs,
           summary.files_total, summary.files_parsed,
           summary.files_pending_lang, summary.files_opaque,
           summary.files_skipped, summary.files_errored, scanId);

    db.prepare("UPDATE projects SET last_scan_at = datetime('now') WHERE id = ?")
      .run(projectId);

    return {
      ok: true,
      project_id: projectId,
      project_name: projectName,
      ...(nameNote ? { name_note: nameNote } : {}),
      root_path: rootPath,
      duration_ms: durationMs,
      ...summary,
    };

  } catch (err) {
    db.prepare(
      "UPDATE scans SET finished_at = datetime('now'), error_message = ? WHERE id = ?"
    ).run(err.message, scanId);
    throw err;
  } finally {
    releaseScanLock(userId);
  }
}
