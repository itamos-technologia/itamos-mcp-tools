/**
 * master-architect query API.
 *
 * Read-only operations against an already-scanned project DB. These are the
 * functions the MCP wrapper exposes to the LLM. They never modify data
 * (except the special associateFile / discoverProject which mutate, but
 * deliberately).
 *
 * Concurrency: read-only ops have no lock. Mutating ops respect the same
 * per-user scan lock as scanProject.
 */

import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { detectLanguage, getParser } from './registry.js';

// ─── getProjectForFile ───────────────────────────────────────────────────
//
// The auto-prompt trigger. Called by read_file on every file open.
// Three-tier match:
//   exact_file:   this exact abs_path is in the files table
//   project_root: this abs_path lives under a known project's root_path
//   none:         no match
//
// `basename` matches are NOT included here — they're too noisy for the
// auto-prompt path. If we want "did you mean" later, that's a separate query.
//
// Returns:
//   { match: 'exact_file', project_id, project_name, project_root, file_id, file_address }
//   { match: 'project_root', project_id, project_name, project_root, file_inside_project: true }
//   { match: 'none' }

export function getProjectForFile(absPath) {
  const db = getDb();
  absPath = path.resolve(absPath);

  // Tier 1: exact file match
  const fileRow = db.prepare(`
    SELECT f.id AS file_id, f.address AS file_address,
           p.id AS project_id, p.name AS project_name, p.root_path
    FROM files f
    JOIN projects p ON f.project_id = p.id
    WHERE f.abs_path = ?
  `).get(absPath);
  if (fileRow) {
    return {
      match: 'exact_file',
      project_id: fileRow.project_id,
      project_name: fileRow.project_name,
      project_root: fileRow.root_path,
      file_id: fileRow.file_id,
      file_address: fileRow.file_address,
    };
  }

  // Tier 2: file is under a known project root.
  // Pick the most specific (longest) matching root in case of nested projects.
  const rootRow = db.prepare(`
    SELECT id, name, root_path
    FROM projects
    WHERE ? LIKE root_path || '/%'
    ORDER BY length(root_path) DESC
    LIMIT 1
  `).get(absPath);
  if (rootRow) {
    return {
      match: 'project_root',
      project_id: rootRow.id,
      project_name: rootRow.name,
      project_root: rootRow.root_path,
      file_inside_project: true,
      hint: `File is inside project '${rootRow.name}' but not yet indexed. Re-scan or call associateFile to add it.`,
    };
  }

  return { match: 'none' };
}

// ─── associateFile ───────────────────────────────────────────────────────
//
// Explicitly add a file to an existing project. Used when:
//   - User has a satellite file outside the project tree
//   - Verification suggests association based on imports
//   - LLM/user wants to manually attach a file
//
// Reads the file from disk, parses if supported, populates files/modules/
// methods/imports rows. Address: appended at end of the file's parent dir
// (or root if outside project tree → uses next available address).
//
// If the file already exists in the project (by abs_path), returns ok with
// existing_file: true and doesn't re-insert.

export async function associateFile(filePath, projectId) {
  const db = getDb();
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return { ok: false, error: `Not a file: ${absPath}` };
  }

  const project = db.prepare('SELECT id, name, root_path FROM projects WHERE id = ?').get(projectId);
  if (!project) return { ok: false, error: `No project with id ${projectId}` };

  // Already associated?
  const existing = db.prepare(
    'SELECT id, address FROM files WHERE abs_path = ? AND project_id = ?'
  ).get(absPath, projectId);
  if (existing) {
    return { ok: true, existing_file: true, file_id: existing.id, file_address: existing.address };
  }

  const detection = detectLanguage(absPath);
  if (detection.kind === 'unrecognized') {
    return { ok: false, error: `File type not recognised: ${path.extname(absPath)}` };
  }

  const stat = fs.statSync(absPath);
  const isReadable = !(detection.kind === 'opaque' && detection.isBinary);
  const language = detection.language;
  let category, parseStatus;
  if (detection.kind === 'supported')        { category = 'supported';     parseStatus = 'parsed'; }
  else if (detection.kind === 'coming_soon') { category = 'coming_soon';   parseStatus = 'pending_language_support'; }
  else                                        { category = detection.isBinary ? 'opaque_binary' : 'opaque_text'; parseStatus = 'not_analysed'; }

  let content = null, lineCount = null;
  if (isReadable) {
    try {
      content = fs.readFileSync(absPath, 'utf8');
      lineCount = content.length === 0 ? 0 : content.split('\n').length;
    } catch {}
  }

  // Determine the file's directory within the project. If the file is OUTSIDE
  // the project tree, attach it directly to the project (directory_id = NULL).
  let directoryId = null;
  let parentAddrForFile = '';

  if (absPath.startsWith(project.root_path + path.sep)) {
    const relPath = path.relative(project.root_path, absPath);
    const dirRel = path.dirname(relPath);
    if (dirRel !== '.') {
      const dirRow = db.prepare(
        'SELECT id, address FROM directories WHERE project_id = ? AND rel_path = ?'
      ).get(projectId, dirRel);
      if (dirRow) {
        directoryId = dirRow.id;
        parentAddrForFile = dirRow.address;
      } else {
        // Directory wasn't in the last scan — add it minimally
        const dirAddr = nextDirectoryAddress(projectId, null);
        const dr = db.prepare(
          'INSERT INTO directories (project_id, parent_id, address, name, rel_path) VALUES (?, NULL, ?, ?, ?)'
        ).run(projectId, dirAddr, path.basename(dirRel), dirRel);
        directoryId = dr.lastInsertRowid;
        parentAddrForFile = dirAddr;
      }
    }
  }

  // Allocate file address (next free number/letter in this directory)
  const fileAddr = nextFileAddress(projectId, directoryId, category, parentAddrForFile);

  const relPath = absPath.startsWith(project.root_path + path.sep)
    ? path.relative(project.root_path, absPath)
    : absPath;   // satellite files keep absolute path as rel_path

  const r = db.prepare(`
    INSERT INTO files
      (project_id, directory_id, address, name, rel_path, abs_path,
       language, category, parse_status, is_readable_text,
       line_count, byte_size, est_tokens, last_modified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, directoryId, fileAddr, path.basename(absPath), relPath, absPath,
    language, category, parseStatus, isReadable ? 1 : 0,
    lineCount, stat.size, Math.ceil(stat.size / 3.7), stat.mtime.toISOString()
  );
  const fileId = r.lastInsertRowid;

  // Parse if supported
  if (category === 'supported' && content !== null) {
    const parser = await getParser(detection.language, detection.parserFile);
    if (parser) {
      const analysis = parser.parseFile(content);
      if (!analysis.parse_error) {
        analysis.modules.forEach((mod, modIdx) => {
          const modAddr = `${fileAddr}.${modIdx + 1}`;
          const mr = db.prepare(
            'INSERT INTO modules (file_id, address, name, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(fileId, modAddr, mod.name, mod.kind, mod.line_start, mod.line_end);
          (mod.methods || []).forEach((m, mIdx) => {
            db.prepare(
              'INSERT INTO methods (module_id, address, name, kind, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(mr.lastInsertRowid, `${modAddr}.${mIdx + 1}`, m.name, m.kind, m.line_start, m.line_end);
          });
        });
        // Imports — internal if local by syntax, resolved, or rooted in a project package
        for (const imp of analysis.imports) {
          const looksLocal = imp.import_path.startsWith('.') || imp.import_path.startsWith('/');
          let resolvedId = null;
          if (parser.resolveImport) {
            const resolved = parser.resolveImport(imp.import_path, absPath, fs, path, project.root_path);
            if (resolved) {
              const f = db.prepare(
                'SELECT id FROM files WHERE abs_path = ? AND project_id = ?'
              ).get(resolved, projectId);
              if (f) { resolvedId = f.id; }
            }
          }
          const isExternal = (looksLocal || resolvedId ||
            (parser.isLocalModule && parser.isLocalModule(imp.import_path, absPath, fs, path, project.root_path))) ? 0 : 1;
          db.prepare(
            'INSERT INTO imports (file_id, import_path, resolved_file_id, is_external, line) VALUES (?, ?, ?, ?, ?)'
          ).run(fileId, imp.import_path, resolvedId, isExternal, imp.line ?? null);
        }
      }
    }
  }

  return {
    ok: true,
    file_id: fileId,
    file_address: fileAddr,
    project_id: projectId,
    project_name: project.name,
  };
}

function nextDirectoryAddress(projectId, parentId) {
  const db = getDb();
  const sib = db.prepare(`
    SELECT address FROM directories
    WHERE project_id = ? AND parent_id IS ?
  `).all(projectId, parentId);
  let max = 0;
  for (const s of sib) {
    const n = parseInt(s.address.split('.').pop(), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

function nextFileAddress(projectId, directoryId, category, parentAddr) {
  const db = getDb();
  const sib = db.prepare(`
    SELECT address FROM files
    WHERE project_id = ? AND directory_id IS ?
  `).all(projectId, directoryId);

  if (category === 'supported') {
    let max = 0;
    for (const s of sib) {
      const last = s.address.split('.').pop();
      if (/^\d+$/.test(last)) {
        const n = parseInt(last, 10);
        if (n > max) max = n;
      }
    }
    return parentAddr === '' ? String(max + 1) : `${parentAddr}.${max + 1}`;
  } else {
    // letter
    let maxLetterCode = -1;
    for (const s of sib) {
      const last = s.address.split('.').pop();
      if (/^[a-z]+$/.test(last)) {
        const code = letterToIndex(last);
        if (code > maxLetterCode) maxLetterCode = code;
      }
    }
    const next = letterFor(maxLetterCode + 1);
    return parentAddr === '' ? next : `${parentAddr}.${next}`;
  }
}

function letterFor(n) {
  let s = '';
  n += 1;
  while (n > 0) { n -= 1; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function letterToIndex(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 96);
  return n - 1;
}

// ─── discoverProject ─────────────────────────────────────────────────────
//
// File isn't in any known project. Follow its imports recursively, build the
// connected component, return a discovery result. Caller (LLM) decides what
// to name the project, then the project is registered with associateFile()
// for each discovered file (or via a dedicated registerDiscoveredProject()
// helper — TBD when MCP wrapper is built).
//
// Depth-limited (default 5 hops) to avoid runaway crawls.
// External imports (npm/pip packages) are not followed.

export async function discoverProject(seedAbsPath, opts = {}) {
  const maxDepth = opts.maxDepth ?? 5;
  seedAbsPath = path.resolve(seedAbsPath);

  if (!fs.existsSync(seedAbsPath) || !fs.statSync(seedAbsPath).isFile()) {
    return { ok: false, error: `Not a file: ${seedAbsPath}` };
  }

  const detection = detectLanguage(seedAbsPath);
  if (detection.kind !== 'supported') {
    return { ok: false, error: `Cannot discover from ${detection.kind} file (need a parseable language)` };
  }

  const visited = new Set();
  const queue = [{ absPath: seedAbsPath, depth: 0 }];
  const reachable = [];

  while (queue.length > 0) {
    const { absPath, depth } = queue.shift();
    if (visited.has(absPath)) continue;
    visited.add(absPath);

    const det = detectLanguage(absPath);
    if (det.kind !== 'supported') {
      // Still record the file as reachable, but don't follow its imports.
      reachable.push({ absPath, language: det.language || 'unknown', followable: false, depth });
      continue;
    }

    let content;
    try { content = fs.readFileSync(absPath, 'utf8'); }
    catch { continue; }

    const parser = await getParser(det.language, det.parserFile);
    if (!parser) continue;

    const analysis = parser.parseFile(content);
    reachable.push({ absPath, language: det.language, followable: true, depth, imports: analysis.imports.length });

    if (depth >= maxDepth) continue;

    for (const imp of analysis.imports) {
      if (!parser.resolveImport) continue;
      const resolved = parser.resolveImport(imp.import_path, absPath, fs, path, null);
      if (resolved && !visited.has(resolved)) {
        queue.push({ absPath: resolved, depth: depth + 1 });
      }
    }
  }

  // Heuristic project root: deepest common ancestor of all reachable files
  const roots = inferProjectRoot(reachable.map(r => r.absPath));

  return {
    ok: true,
    seed: seedAbsPath,
    files_reachable: reachable.length,
    likely_project_root: roots.commonAncestor,
    likely_project_name: path.basename(roots.commonAncestor),
    files: reachable.map(r => ({
      abs_path: r.absPath,
      language: r.language,
      depth: r.depth,
      followable: r.followable,
    })),
    prompt: `Discovered ${reachable.length} connected file(s) starting from ${path.basename(seedAbsPath)}. Likely project root: ${roots.commonAncestor}. Suggested name: '${path.basename(roots.commonAncestor)}'. Confirm or override?`,
  };
}

// ─── registerDiscoveredProject ──────────────────────────────────────────
//
// Closes the discover→register loop. Called after the LLM has shown the user
// a discover() result, gotten a project name, and wants to actually create
// the project from those discovered files.
//
// Re-runs the import crawl from the seed (cheap, ~50ms) so we use the
// freshest connected-file set. This avoids staleness if the user took a
// while to confirm or if files moved/changed in the interim.
//
// Strict semantics: ONLY discovered files are added. Other files in the
// inferred root directory that aren't connected via imports are left out —
// they'll surface as 'in_tree_not_indexed' on later read_file opens, and
// the LLM/user can decide whether to associate them. This keeps discover
// and scan as separate, clean operations.
//
// Failure modes handled:
//   - project name already exists  → error with suggestion to scan instead
//   - root_path overlaps existing project → error with suggestion to associateFile
//   - no files discovered          → error (probably wrong seed_path)

export async function registerDiscoveredProject(seedPath, projectName, opts = {}) {
  const db = getDb();
  if (!projectName || typeof projectName !== 'string') {
    return { ok: false, error: 'project_name required (string)' };
  }
  projectName = projectName.trim();
  if (!projectName) {
    return { ok: false, error: 'project_name cannot be empty' };
  }

  // Check name collision early
  const existingByName = db.prepare(
    'SELECT id, root_path FROM projects WHERE name = ?'
  ).get(projectName);
  if (existingByName) {
    const seedAbs0 = path.resolve(seedPath);
    if (seedAbs0 === existingByName.root_path || seedAbs0.startsWith(existingByName.root_path + path.sep)) {
      // Same name and the seed already lives in that project: registering
      // again is a no-op, not an error.
      return { ok: true, already_registered: true, project_id: existingByName.id,
               project_name: projectName, root_path: existingByName.root_path };
    }
    return {
      ok: false,
      error: `project named '${projectName}' already exists at ${existingByName.root_path}`,
      hint: `Pick a different name, or use associateFile() to add the seed to project ${existingByName.id}.`,
      existing_project_id: existingByName.id,
    };
  }

  // Run discovery fresh from the seed
  const discovery = await discoverProject(seedPath, { maxDepth: opts.maxDepth });
  if (!discovery.ok) {
    return { ok: false, error: `discovery failed: ${discovery.error}` };
  }
  if (discovery.files_reachable === 0) {
    return { ok: false, error: 'no files discovered from seed' };
  }

  // Determine the root: caller can override, otherwise use the inferred root
  const rootPath = opts.rootPath
    ? path.resolve(opts.rootPath)
    : discovery.likely_project_root;

  // Check root collision: does any existing project's root contain this seed,
  // or does this root contain any existing project?
  const seedAbs = path.resolve(seedPath);
  const rootCollision = db.prepare(`
    SELECT id, name, root_path FROM projects
    WHERE ? LIKE root_path || '/%'
       OR root_path LIKE ? || '/%'
       OR root_path = ?
  `).get(seedAbs, rootPath, rootPath);
  if (rootCollision) {
    return {
      ok: false,
      error: `path overlap with existing project '${rootCollision.name}' (root: ${rootCollision.root_path})`,
      hint: `Use associateFile(${seedAbs}, ${rootCollision.id}) to add this file to the existing project instead.`,
      existing_project_id: rootCollision.id,
    };
  }

  // Create the project row
  const createResult = db.prepare(`
    INSERT INTO projects (name, root_path, last_scan_at)
    VALUES (?, ?, datetime('now'))
  `).run(projectName, rootPath);
  const projectId = createResult.lastInsertRowid;

  // Associate each discovered file. We iterate sequentially so address
  // counters increment consistently (associateFile handles the per-directory
  // numeric/letter address allocation internally).
  const added = [];
  const failed = [];
  for (const f of discovery.files) {
    const r = await associateFile(f.abs_path, projectId);
    if (r.ok) {
      added.push({
        abs_path: f.abs_path,
        address: r.file_address,
        existing: !!r.existing_file,
      });
    } else {
      failed.push({ abs_path: f.abs_path, error: r.error });
    }
  }

  return {
    ok: true,
    project_id: projectId,
    project_name: projectName,
    project_root: rootPath,
    seed_path: seedAbs,
    files_discovered: discovery.files_reachable,
    files_added: added.length,
    files_failed: failed.length,
    added,
    ...(failed.length > 0 ? { failed } : {}),
    hint: `Project '${projectName}' created with ${added.length} file(s). Open any of these files via read_file to load the project skeleton in your session, or call master_architect.scan(path='${rootPath}') if you want a full directory scan to capture files not in the import graph.`,
  };
}

function inferProjectRoot(absPaths) {
  if (absPaths.length === 0) return { commonAncestor: '/' };
  if (absPaths.length === 1) return { commonAncestor: path.dirname(absPaths[0]) };

  const split = absPaths.map(p => p.split(path.sep));
  let common = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    if (split.every(s => s[i] === seg)) common.push(seg);
    else break;
  }
  return { commonAncestor: common.join(path.sep) || '/' };
}

// ─── navigate ────────────────────────────────────────────────────────────
//
// Resolve a hierarchical address within a project, return what's there.
// Address can be:
//   "1"        → directory
//   "1.2"      → file
//   "1.2.3"    → module (class/function) inside file 1.2
//   "1.2.3.4"  → method inside module 1.2.3
//   "99.X"     → database
//   "99.X.Y"   → db_table
//
// mode = 'structural' (default): for files → skeleton, for modules → method list, etc.
// mode = 'raw': for files → full content (only if is_readable_text)

export function navigate(projectId, address, opts = {}) {
  const db = getDb();
  const mode = opts.mode || 'structural';

  if (!address || typeof address !== 'string') {
    return { ok: false, error: 'address required' };
  }

  // Database branch (99.X / 99.X.Y)
  if (address.startsWith('99.')) {
    const segs = address.split('.');
    if (segs.length === 2) {
      const dbRow = db.prepare(
        'SELECT * FROM databases WHERE project_id = ? AND address = ?'
      ).get(projectId, address);
      if (!dbRow) return { ok: false, error: 'no database at address' };
      const tables = db.prepare(
        'SELECT address, name FROM db_tables WHERE database_id = ? ORDER BY address'
      ).all(dbRow.id);
      return { ok: true, kind: 'database', address, name: dbRow.name, type: dbRow.type,
               path_or_uri: dbRow.path_or_uri, tables };
    }
    if (segs.length === 3) {
      const tableRow = db.prepare(`
        SELECT t.* FROM db_tables t
        JOIN databases d ON t.database_id = d.id
        WHERE d.project_id = ? AND t.address = ?
      `).get(projectId, address);
      if (!tableRow) return { ok: false, error: 'no table at address' };
      return { ok: true, kind: 'db_table', address, name: tableRow.name, schema: tableRow.schema_text };
    }
  }

  // Directory? (single number, or N.N.N where leaf segments are all numeric AND no file at this address)
  const dirRow = db.prepare(
    'SELECT * FROM directories WHERE project_id = ? AND address = ?'
  ).get(projectId, address);
  if (dirRow) {
    const subDirs = db.prepare(
      'SELECT address, name FROM directories WHERE parent_id = ? ORDER BY address'
    ).all(dirRow.id);
    const files = db.prepare(
      'SELECT address, name, language, category, parse_status FROM files WHERE directory_id = ? ORDER BY address'
    ).all(dirRow.id);
    return { ok: true, kind: 'directory', address, name: dirRow.name, rel_path: dirRow.rel_path,
             subdirectories: subDirs, files };
  }

  // File?
  const fileRow = db.prepare(
    'SELECT * FROM files WHERE project_id = ? AND address = ?'
  ).get(projectId, address);
  if (fileRow) {
    if (mode === 'raw') {
      if (!fileRow.is_readable_text) {
        return { ok: false, error: 'binary file, raw read not supported',
                 abs_path: fileRow.abs_path, byte_size: fileRow.byte_size };
      }
      let content;
      try { content = fs.readFileSync(fileRow.abs_path, 'utf8'); }
      catch (e) { return { ok: false, error: `read failed: ${e.message}` }; }
      return { ok: true, kind: 'file_raw', address, abs_path: fileRow.abs_path,
               language: fileRow.language, line_count: fileRow.line_count, content };
    }
    // structural
    const modules = db.prepare(
      'SELECT address, name, kind, line_start, line_end FROM modules WHERE file_id = ? ORDER BY address'
    ).all(fileRow.id);
    return {
      ok: true, kind: 'file', address, name: fileRow.name, abs_path: fileRow.abs_path,
      language: fileRow.language, category: fileRow.category, parse_status: fileRow.parse_status,
      line_count: fileRow.line_count, byte_size: fileRow.byte_size, est_tokens: fileRow.est_tokens,
      modules,
    };
  }

  // Module?
  const moduleRow = db.prepare(`
    SELECT m.*, f.abs_path FROM modules m
    JOIN files f ON m.file_id = f.id
    WHERE f.project_id = ? AND m.address = ?
  `).get(projectId, address);
  if (moduleRow) {
    const methods = db.prepare(
      'SELECT address, name, kind, line_start, line_end FROM methods WHERE module_id = ? ORDER BY address'
    ).all(moduleRow.id);
    if (mode === 'raw') {
      // return the source span of this module from the file
      try {
        const content = fs.readFileSync(moduleRow.abs_path, 'utf8');
        const lines = content.split('\n');
        const slice = lines.slice(moduleRow.line_start - 1, moduleRow.line_end).join('\n');
        return { ok: true, kind: 'module_raw', address, name: moduleRow.name, kind_of: moduleRow.kind,
                 line_start: moduleRow.line_start, line_end: moduleRow.line_end, content: slice };
      } catch (e) {
        return { ok: false, error: `read failed: ${e.message}` };
      }
    }
    return { ok: true, kind: 'module', address, name: moduleRow.name, kind_of: moduleRow.kind,
             line_start: moduleRow.line_start, line_end: moduleRow.line_end, methods };
  }

  // Method?
  const methodRow = db.prepare(`
    SELECT me.*, m.file_id, f.abs_path FROM methods me
    JOIN modules m ON me.module_id = m.id
    JOIN files f ON m.file_id = f.id
    WHERE f.project_id = ? AND me.address = ?
  `).get(projectId, address);
  if (methodRow) {
    if (mode === 'raw') {
      try {
        const content = fs.readFileSync(methodRow.abs_path, 'utf8');
        const lines = content.split('\n');
        const slice = lines.slice(methodRow.line_start - 1, methodRow.line_end).join('\n');
        return { ok: true, kind: 'method_raw', address, name: methodRow.name, kind_of: methodRow.kind,
                 line_start: methodRow.line_start, line_end: methodRow.line_end, content: slice };
      } catch (e) {
        return { ok: false, error: `read failed: ${e.message}` };
      }
    }
    return { ok: true, kind: 'method', address, name: methodRow.name, kind_of: methodRow.kind,
             line_start: methodRow.line_start, line_end: methodRow.line_end };
  }

  return { ok: false, error: `no entity at address ${address} in project ${projectId}` };
}

// ─── getConnections ──────────────────────────────────────────────────────
//
// For an address, list incoming + outgoing relationships.
// Currently supports file-level connections (which files import this file,
// what does this file import, which databases does it touch).
// Module/method-level call graph = future work (needs call analysis).

export function getConnections(projectId, address) {
  const db = getDb();

  // Resolve address to a file_id (most useful tier for connections currently)
  const fileRow = db.prepare(
    'SELECT id, name, abs_path FROM files WHERE project_id = ? AND address = ?'
  ).get(projectId, address);

  if (!fileRow) {
    // Try via module/method address — return parent file's connections
    const modRow = db.prepare(`
      SELECT f.id, f.name, f.abs_path FROM modules m
      JOIN files f ON m.file_id = f.id
      WHERE f.project_id = ? AND m.address = ?
    `).get(projectId, address);
    if (modRow) return getConnections(projectId, db.prepare(
      'SELECT address FROM files WHERE id = ?').get(modRow.id).address);

    return { ok: false, error: `no file resolvable from address ${address}` };
  }

  const outgoing = db.prepare(`
    SELECT i.import_path, i.line, i.is_external,
           f2.address AS resolved_address, f2.name AS resolved_name, f2.abs_path AS resolved_abs_path
    FROM imports i
    LEFT JOIN files f2 ON i.resolved_file_id = f2.id
    WHERE i.file_id = ?
    ORDER BY i.line
  `).all(fileRow.id);

  const incoming = db.prepare(`
    SELECT f.address AS importer_address, f.name AS importer_name, f.abs_path AS importer_abs_path,
           i.import_path, i.line
    FROM imports i
    JOIN files f ON i.file_id = f.id
    WHERE i.resolved_file_id = ?
    ORDER BY f.address, i.line
  `).all(fileRow.id);

  const databases = db.prepare(`
    SELECT d.id, d.address, d.name, d.path_or_uri, dc.line
    FROM db_connections dc
    JOIN databases d ON dc.database_id = d.id
    WHERE dc.file_id = ?
    ORDER BY dc.line
  `).all(fileRow.id);

  // Direction enrichment: derive in/out/both per database from the SQL verbs
  // already captured in sql_queries during scan. Read-only, no schema change.
  //   read verbs  (SELECT/WITH/PRAGMA/EXPLAIN/ANALYZE)        -> 'in'
  //   write verbs (INSERT/UPDATE/DELETE/REPLACE/CREATE/ALTER/DROP) -> 'out'
  //   both seen -> 'both'
  //   only dynamic queries, no classifiable verb -> 'dynamic' (runtime-determined)
  //   no queries linked at all -> 'unknown' (e.g. non-SQL engine: lmdb/redis)
  const READ_VERBS = new Set(['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN', 'ANALYZE']);
  const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'MERGE', 'UPSERT']);
  const leadingVerb = (sql) => {
    if (!sql) return null;
    // strip leading line/block comments and whitespace, then take first word
    const m = String(sql)
      .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/, '')
      .match(/^\s*([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : null;
  };
  const getQueriesForDb = db.prepare(`
    SELECT sql, is_dynamic
    FROM sql_queries
    WHERE file_id = ? AND inferred_database_id = ?
  `);
  const directionFor = (dbId) => {
    const rows = getQueriesForDb.all(fileRow.id, dbId);
    if (!rows.length) return { direction: 'unknown', read: 0, write: 0, dynamic: 0, queries: 0 };
    let read = 0, write = 0, dynamic = 0;
    for (const q of rows) {
      const v = leadingVerb(q.sql);
      if (v && READ_VERBS.has(v)) read += 1;
      else if (v && WRITE_VERBS.has(v)) write += 1;
      else if (q.is_dynamic) dynamic += 1;
      // unknown leading verb on a non-dynamic query: ignore (don't fabricate direction)
    }
    let direction;
    if (read && write) direction = 'both';
    else if (read) direction = 'in';
    else if (write) direction = 'out';
    else if (dynamic) direction = 'dynamic';   // runtime-determined, can't resolve statically
    else direction = 'unknown';
    return { direction, read, write, dynamic, queries: rows.length };
  };
  const databasesEnriched = databases.map((d) => {
    const dir = directionFor(d.id);
    return {
      address: d.address,
      name: d.name,
      path_or_uri: d.path_or_uri,
      line: d.line,
      direction: dir.direction,
      direction_evidence: { read: dir.read, write: dir.write, dynamic: dir.dynamic, queries: dir.queries },
    };
  });

  const external = db.prepare(`
    SELECT er.kind, er.name, er.locator, er.version, fer.line
    FROM file_external_refs fer
    JOIN external_refs er ON fer.external_ref_id = er.id
    WHERE fer.file_id = ?
    ORDER BY er.kind, fer.line
  `).all(fileRow.id);

  return {
    ok: true,
    address,
    file_name: fileRow.name,
    abs_path: fileRow.abs_path,
    outgoing: { count: outgoing.length, items: outgoing },
    incoming: { count: incoming.length, items: incoming },
    databases: { count: databasesEnriched.length, items: databasesEnriched },
    external: { count: external.length, items: external },
  };
}

// ─── getPing (trace-route) ─────────────────────────────────────────────────
//
// Transitive walk of the imports graph from a start file. Follows resolved
// internal imports hop by hop (BFS), numbering each hop, until every branch
// terminates. Each terminus is labeled:
//   external   — import is to an external library (is_external=1); stop.
//   unresolved — internal import the architect couldn't resolve (BLOCKED); stop.
//   cycle      — points back to an already-visited file; stop.
//   leaf       — file has no outgoing imports; end of chain.
// File-level only (imports). Function/segment-level call tracing = future work
// (needs a calls graph, which does not exist yet).
export function getPing(projectId, address, opts = {}) {
  const db = getDb();
  const maxHops = opts.maxHops || 25;

  // resolve start address -> file (same fallback as getConnections: module/method
  // address resolves to its parent file)
  let fileRow = db.prepare(
    'SELECT id, name, abs_path, address FROM files WHERE project_id = ? AND address = ?'
  ).get(projectId, address);
  if (!fileRow) {
    const modRow = db.prepare(`
      SELECT f.id FROM modules m JOIN files f ON m.file_id = f.id
      WHERE f.project_id = ? AND m.address = ?
    `).get(projectId, address);
    if (modRow) {
      fileRow = db.prepare('SELECT id, name, abs_path, address FROM files WHERE id = ?').get(modRow.id);
    }
  }
  if (!fileRow) return { ok: false, error: `no file resolvable from address ${address}` };

  const extStmt = db.prepare(`
    SELECT er.kind, er.name, er.locator, er.version, fer.line
    FROM file_external_refs fer
    JOIN external_refs er ON fer.external_ref_id = er.id
    WHERE fer.file_id = ?
    ORDER BY er.kind, fer.line
  `);
  const outStmt = db.prepare(`
    SELECT i.import_path, i.line, i.is_external, i.resolved_file_id,
           f2.address AS resolved_address, f2.name AS resolved_name
    FROM imports i
    LEFT JOIN files f2 ON i.resolved_file_id = f2.id
    WHERE i.file_id = ?
    ORDER BY i.line
  `);

  // BFS over files. visited maps file_id -> hop number (depth) it was first seen.
  const visited = new Map();
  visited.set(fileRow.id, 0);
  const nodes = [];           // per-file trace nodes
  const routes = [];          // flat ordered chains for the "where does it lead" view
  let blocked = 0, externalCount = 0, leaves = 0, cycles = 0, extEndpoints = 0;

  // queue items: { id, name, address, hop, path:[names...] }
  const queue = [{ id: fileRow.id, name: fileRow.name, address: fileRow.address, hop: 0, path: [fileRow.name] }];

  while (queue.length) {
    const cur = queue.shift();
    if (cur.hop >= maxHops) continue;
    const edges = outStmt.all(cur.id);
    const node = { hop: cur.hop, address: cur.address, name: cur.name, follows: [] };

    let advanced = false;
    for (const e of edges) {
      if (e.is_external) {
        node.follows.push({ to: e.import_path, hop: cur.hop + 1, terminus: 'external', line: e.line });
        externalCount++;
        routes.push({ chain: [...cur.path, e.import_path], hops: cur.hop + 1, ends: 'external' });
        continue;
      }
      if (!e.resolved_file_id) {
        node.follows.push({ to: e.import_path, hop: cur.hop + 1, terminus: 'unresolved', line: e.line });
        blocked++;
        routes.push({ chain: [...cur.path, e.import_path], hops: cur.hop + 1, ends: 'BLOCKED (unresolved)' });
        continue;
      }
      if (visited.has(e.resolved_file_id)) {
        node.follows.push({ to: e.resolved_name, address: e.resolved_address, hop: cur.hop + 1, terminus: 'cycle' });
        cycles++;
        routes.push({ chain: [...cur.path, e.resolved_name], hops: cur.hop + 1, ends: 'cycle' });
        continue;
      }
      // resolved internal, not yet visited -> follow it
      visited.set(e.resolved_file_id, cur.hop + 1);
      node.follows.push({ to: e.resolved_name, address: e.resolved_address, hop: cur.hop + 1, terminus: 'follow' });
      queue.push({
        id: e.resolved_file_id, name: e.resolved_name, address: e.resolved_address,
        hop: cur.hop + 1, path: [...cur.path, e.resolved_name],
      });
      advanced = true;
    }
    if (edges.length === 0) {
      node.terminus = 'leaf';
      leaves++;
      routes.push({ chain: cur.path, hops: cur.hop, ends: 'leaf' });
    }
    // External endpoints this file references (server/model/binary/service/port).
    // Always terminal — an endpoint, not a file to recurse into.
    const ext = extStmt.all(cur.id);
    if (ext.length) {
      node.external = ext.map(e => ({
        kind: e.kind, name: e.name, locator: e.locator,
        version: e.version || undefined, line: e.line, terminus: 'endpoint',
      }));
      extEndpoints += ext.length;
      for (const e of ext) {
        routes.push({ chain: [...cur.path, `${e.kind}:${e.locator}`], hops: cur.hop + 1, ends: 'endpoint' });
      }
    }
    nodes.push(node);
  }

  // longest routes first — most useful for "where to start looking"
  routes.sort((a, b) => b.hops - a.hops);

  return {
    ok: true,
    address,
    start: { name: fileRow.name, abs_path: fileRow.abs_path },
    level: 'file',
    summary: {
      files_reached: visited.size,
      max_hops: Math.max(0, ...[...visited.values()]),
      blocked, external: externalCount, cycles, leaves, external_endpoints: extEndpoints,
    },
    routes,
    nodes,
    note: 'File-level import trace. Function/segment-level call tracing is future work (no calls graph yet).',
  };
}

// ─── getFileContext ──────────────────────────────────────────────────────
//
// Cross-reference summary for a file by absolute path. Convenience wrapper
// that tries getConnections via the file's address.

export function getFileContext(absPath) {
  const db = getDb();
  absPath = path.resolve(absPath);
  const fileRow = db.prepare(`
    SELECT f.id, f.address, f.project_id, p.name AS project_name
    FROM files f JOIN projects p ON f.project_id = p.id
    WHERE f.abs_path = ?
  `).get(absPath);
  if (!fileRow) return { ok: false, error: 'file not in any project DB; call getProjectForFile first' };
  const conns = getConnections(fileRow.project_id, fileRow.address);
  return {
    ok: true,
    abs_path: absPath,
    project_id: fileRow.project_id,
    project_name: fileRow.project_name,
    address: fileRow.address,
    ...conns,
  };
}

// ─── getMissing ──────────────────────────────────────────────────────────
//
// Local imports that don't resolve to any project file. The LLM can use this
// to flag broken references in dev — fix typos, find moved files, or skip if
// intentional (dynamic imports, conditional code, etc.).

export function getMissing(projectId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      f.address AS file_address, f.name AS file_name, f.abs_path AS file_abs_path,
      i.import_path, i.line
    FROM imports i
    JOIN files f ON i.file_id = f.id
    WHERE f.project_id = ?
      AND i.is_external = 0
      AND i.resolved_file_id IS NULL
    ORDER BY f.address, i.line
  `).all(projectId);
  return {
    ok: true,
    project_id: projectId,
    count: rows.length,
    missing: rows,
  };
}

// ─── getBones ────────────────────────────────────────────────────────────────
//
// Architect-level bone view of a file. Returns imports, exports and module list
// (functions, classes) with their addresses — no editor metadata, no segment
// details, no byte sizes. Compact enough for a model to scan and pick a target
// before calling read_file to get the actual code.
//
// Accepts either a file address (e.g. "13") or an absolute path.
export function getBones(projectId, address, absPath) {
  const db = getDb();

  // resolve file row by address or abs_path
  let fileRow;
  if (address) {
    fileRow = db.prepare(
      'SELECT id, address, name, rel_path, language, line_count FROM files WHERE project_id = ? AND address = ?'
    ).get(projectId, address);
  } else if (absPath) {
    fileRow = db.prepare(
      'SELECT id, address, name, rel_path, language, line_count FROM files WHERE abs_path = ?'
    ).get(absPath);
    if (!fileRow && projectId) {
      // A relative path gets resolved against the caller's working directory
      // before it reaches us, but models usually mean "relative to the
      // project root" (e.g. 'pkg/b.py'). Fall back to matching the project's
      // rel_paths as a suffix of the given path; the longest match wins.
      const norm = String(absPath).replace(/\\/g, '/');
      const hits = db.prepare(
        'SELECT id, address, name, rel_path, language, line_count FROM files WHERE project_id = ?'
      ).all(projectId).filter(r => norm === r.rel_path || norm.endsWith('/' + r.rel_path));
      if (hits.length) {
        hits.sort((a, b) => b.rel_path.length - a.rel_path.length);
        if (hits.length > 1 && hits[0].rel_path.length === hits[1].rel_path.length) {
          return { ok: false, error: `ambiguous path ${absPath}: matches ${hits.map(h => h.rel_path).join(', ')}. Pass the file address from topology instead.` };
        }
        fileRow = hits[0];
      }
    }
  }
  if (!fileRow) {
    return { ok: false, error: `no file found at ${address || absPath}. Pass a file address from topology, an absolute path, or a path relative to the project root.` };
  }

  // imports — internal + external, deduplicated by path
  const imports = db.prepare(`
    SELECT i.import_path, i.is_external, MIN(i.line) AS line,
           f2.address AS resolved_address, f2.name AS resolved_name
    FROM imports i
    LEFT JOIN files f2 ON i.resolved_file_id = f2.id
    WHERE i.file_id = ?
    GROUP BY i.import_path
    ORDER BY MIN(i.line)
  `).all(fileRow.id);

  // external refs (servers, models, services, binaries)
  const externalRefs = db.prepare(`
    SELECT er.kind, er.name, er.locator, fer.line
    FROM file_external_refs fer
    JOIN external_refs er ON fer.external_ref_id = er.id
    WHERE fer.file_id = ?
    ORDER BY er.kind, fer.line
  `).all(fileRow.id);

  // db connections
  const dbRefs = db.prepare(`
    SELECT d.name, d.type, d.path_or_uri, dc.line
    FROM db_connections dc
    JOIN databases d ON dc.database_id = d.id
    WHERE dc.file_id = ?
    ORDER BY dc.line
  `).all(fileRow.id);

  // modules (functions, classes, exports) with their methods
  const modules = db.prepare(`
    SELECT address, name, kind, line_start, line_end
    FROM modules WHERE file_id = ? ORDER BY address
  `).all(fileRow.id);

  // attach methods to each module
  const modulesWithMethods = modules.map(mod => {
    const methods = db.prepare(`
      SELECT address, name, kind, line_start, line_end
      FROM methods WHERE module_id = (
        SELECT id FROM modules WHERE file_id = ? AND address = ?
      ) ORDER BY address
    `).all(fileRow.id, mod.address);
    return methods.length ? { ...mod, methods } : mod;
  });

  return {
    ok: true,
    address: fileRow.address,
    name: fileRow.name,
    rel_path: fileRow.rel_path,
    language: fileRow.language,
    lines: fileRow.line_count,
    imports: imports.map(i => ({
      path: i.import_path,
      external: !!i.is_external,
      resolved: i.resolved_name || null,
      resolved_address: i.resolved_address || null,
      line: i.line,
    })),
    external_refs: externalRefs,
    db_refs: dbRefs,
    modules: modulesWithMethods,
    hint: 'Use read_file with this address to read segments, or navigate(address) to drill into a module.',
  };
}

// ─── getTopology ──────────────────────────────────────────────────────────
//
// Returns the project's data-flow graph as a compact node+edge list.
// Level 1 (default): entry-point files, external endpoints, databases — all
// connected by actual data flow direction (who calls whom, who reads what).
// The model uses this as the navigation root: pick a node, drill into it
// with navigate() or getPing() to go deeper.
//
// Node kinds: file | directory | database | external (server/model/binary/service)
// Edge kinds: imports | db_connection | external_ref
// Direction:  source -> target (data flows from source to target)
export function getTopology(projectId) {
  const db = getDb();

  // ── 1. Entry points: files with no incoming internal imports ──────────
  const entryFiles = db.prepare(`
    SELECT f.id, f.address, f.name, f.rel_path, f.language, f.category
    FROM files f
    WHERE f.project_id = ?
      AND f.is_readable_text = 1
      AND NOT EXISTS (
        SELECT 1 FROM imports i
        WHERE i.resolved_file_id = f.id
      )
    ORDER BY f.address
  `).all(projectId);

  // ── 2. All internal import edges (file → file) ────────────────────────
  const importEdges = db.prepare(`
    SELECT
      f1.address AS from_addr, f1.name AS from_name,
      f2.address AS to_addr,   f2.name AS to_name
    FROM imports i
    JOIN files f1 ON i.file_id          = f1.id
    JOIN files f2 ON i.resolved_file_id = f2.id
    WHERE f1.project_id = ?
      AND i.is_external = 0
      AND i.resolved_file_id IS NOT NULL
    ORDER BY f1.address, f2.address
  `).all(projectId);

  // ── 3. External ref nodes + edges (file → external endpoint) ─────────
  const externalEdges = db.prepare(`
    SELECT
      f.address AS from_addr, f.name AS from_name,
      er.kind, er.name AS ext_name, er.locator, er.extra,
      fer.line
    FROM file_external_refs fer
    JOIN files         f  ON fer.file_id         = f.id
    JOIN external_refs er ON fer.external_ref_id = er.id
    WHERE f.project_id = ?
    ORDER BY f.address, er.kind, er.locator
  `).all(projectId);

  // ── 4. Database nodes + edges (file → database) ───────────────────────
  const dbEdges = db.prepare(`
    SELECT
      f.address  AS from_addr, f.name AS from_name,
      d.address  AS db_addr,   d.name AS db_name, d.type, d.path_or_uri
    FROM db_connections dc
    JOIN files     f ON dc.file_id     = f.id
    JOIN databases d ON dc.database_id = d.id
    WHERE f.project_id = ?
    ORDER BY f.address, d.address
  `).all(projectId);

  // ── 5. All database nodes ─────────────────────────────────────────────
  const databases = db.prepare(`
    SELECT address, name, type, path_or_uri
    FROM databases
    WHERE project_id = ?
    ORDER BY address
  `).all(projectId);

  // ── 6. All external ref nodes for this project ────────────────────────
  const externals = db.prepare(`
    SELECT er.kind, er.name, er.locator, er.version, er.extra
    FROM external_refs er
    JOIN external_ref_projects erp ON er.id = erp.external_ref_id
    WHERE erp.project_id = ?
    ORDER BY er.kind, er.name
  `).all(projectId);

  // ── 7. Deduplicate external nodes by locator ──────────────────────────
  const extNodeMap = new Map();
  for (const e of externals) {
    const key = `${e.kind}:${e.locator}`;
    if (!extNodeMap.has(key)) {
      extNodeMap.set(key, {
        id: key,
        kind: 'external',
        subkind: e.kind,
        name: e.name,
        locator: e.locator,
        version: e.version || null,
        extra: e.extra ? (() => { try { return JSON.parse(e.extra); } catch { return e.extra; } })() : null,
      });
    }
  }

  // ── 8. Build node list ────────────────────────────────────────────────
  const nodes = [
    ...entryFiles.map(f => ({
      id: f.address,
      kind: 'file',
      name: f.name,
      rel_path: f.rel_path,
      language: f.language,
      category: f.category,
      entry_point: true,
    })),
    ...databases.map(d => ({
      id: d.address || `db:${d.name}`,
      kind: 'database',
      name: d.name,
      db_type: d.type,
      path_or_uri: d.path_or_uri,
    })),
    ...Array.from(extNodeMap.values()),
  ];

  // ── 9. Build edge list ────────────────────────────────────────────────
  const edgeSet = new Set();
  const edges = [];

  const addEdge = (from, to, kind, meta) => {
    const key = `${from}→${to}:${kind}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ from, to, kind, ...meta });
  };

  for (const e of importEdges) {
    addEdge(e.from_addr, e.to_addr, 'imports', { from_name: e.from_name, to_name: e.to_name });
  }
  for (const e of externalEdges) {
    const extKey = `${e.kind}:${e.locator}`;
    addEdge(e.from_addr, extKey, 'external_ref', {
      from_name: e.from_name,
      to_name: e.ext_name,
      subkind: e.kind,
      locator: e.locator,
      line: e.line,
    });
  }
  for (const e of dbEdges) {
    const dbId = e.db_addr || `db:${e.db_name}`;
    addEdge(e.from_addr, dbId, 'db_connection', {
      from_name: e.from_name,
      to_name: e.db_name,
      db_type: e.type,
    });
  }

  // ── 10. Summary stats ─────────────────────────────────────────────────
  const allFiles = db.prepare('SELECT COUNT(*) AS n FROM files WHERE project_id = ?').get(projectId);
  const allDirs  = db.prepare('SELECT COUNT(*) AS n FROM directories WHERE project_id = ?').get(projectId);

  return {
    ok: true,
    project_id: projectId,
    summary: {
      total_files: allFiles.n,
      total_dirs: allDirs.n,
      entry_points: entryFiles.length,
      databases: databases.length,
      external_nodes: extNodeMap.size,
      edges: edges.length,
    },
    nodes,
    edges,
    hint: 'Navigate deeper with navigate(address) on any node id, or getPing(address) to trace data flow from a file.',
  };
}


// ─── Verification status updates ─────────────────────────────────────────
//
// markVerified: called by read_file when an L3 verify+commit cycle succeeds.
// Increments the file's version, sets status='verified', records the level
// and timestamp.
//
// Returns the updated row info, or { ok: false, error: ... } if the file
// isn't in any project (in which case there's nothing to update — the file
// is just a free-standing file, no architect record).

export function markVerified(absPath, level) {
  const db = getDb();
  absPath = path.resolve(absPath);

  const fileRow = db.prepare(`
    SELECT f.id, f.address, f.version, f.verification_status,
           p.id AS project_id, p.name AS project_name
    FROM files f
    JOIN projects p ON f.project_id = p.id
    WHERE f.abs_path = ?
  `).get(absPath);

  if (!fileRow) {
    return { ok: false, reason: 'not_in_any_project',
             hint: 'File is not associated with any project. Verification recorded only locally.' };
  }

  const newVersion = fileRow.version + 1;
  db.prepare(`
    UPDATE files
    SET verification_status = 'verified',
        version = ?,
        verified_at_level = ?,
        verified_at = datetime('now'),
        last_modified = datetime('now')
    WHERE id = ?
  `).run(newVersion, level, fileRow.id);

  return {
    ok: true,
    project_id: fileRow.project_id,
    project_name: fileRow.project_name,
    file_address: fileRow.address,
    previous_status: fileRow.verification_status,
    previous_version: fileRow.version,
    current_status: 'verified',
    current_version: newVersion,
    verified_at_level: level,
  };
}

// markUnverified: called when a file is committed (i.e. content changed on
// disk) but the change wasn't through a successful L3 verify path. Also
// called by mtime-drift detection on file open.
//
// Resets verification_status to 'unverified' but does NOT decrement version
// (version only goes up). Used to flag "this file changed since last verify".

export function markUnverified(absPath) {
  const db = getDb();
  absPath = path.resolve(absPath);

  const fileRow = db.prepare(
    'SELECT id, version, verification_status FROM files WHERE abs_path = ?'
  ).get(absPath);
  if (!fileRow) return { ok: false, reason: 'not_in_any_project' };

  // Don't downgrade not_verifiable files
  if (fileRow.verification_status === 'not_verifiable') {
    return { ok: true, no_change: true, current_status: 'not_verifiable' };
  }

  db.prepare(`
    UPDATE files
    SET verification_status = 'unverified',
        last_modified = datetime('now')
    WHERE id = ?
  `).run(fileRow.id);

  return {
    ok: true,
    previous_status: fileRow.verification_status,
    current_status: 'unverified',
    current_version: fileRow.version,
  };
}


// ─── L3 SQL query check (schema-only, never data-level) ─────────────────
//
// For each SQL query extracted from this file, ask the linked database
// "would this query be valid against your current schema?" via EXPLAIN.
//
// EXPLAIN is the right primitive: it parses + plans the query against the
// schema without executing it. Failures surface concrete errors:
//   "no such table: users"
//   "no such column: users.username"
//   "near 'FROMM': syntax error"
//
// Schema-only by design. Never executes the query, never reads rows. Even
// against a 3TB database, EXPLAIN cost is bounded by the size of the
// schema, not the data.
//
// Dynamic queries (template literals with interpolations) are skipped —
// we can't EXPLAIN a query whose structure isn't fully known.
//
// Multi-statement queries are split on `;` and each statement EXPLAINed
// independently, so failures pinpoint the exact problematic statement.
//
// Like other L3 checks: gates the verified flag, NOT the commit-to-disk
// path. A file with a broken query can still be saved during WIP.

import BetterSqlite3 from 'better-sqlite3';

export async function checkSqlQueries(absPath) {
  const db = getDb();
  if (!db) return { ok: true, note: 'architect db unavailable, skipping check' };
  absPath = path.resolve(absPath);

  const fileRow = db.prepare('SELECT id FROM files WHERE abs_path = ?').get(absPath);
  if (!fileRow) {
    return { ok: true, note: 'file not in any project, no SQL check' };
  }

  // Pull SQL queries linked to this file. JOIN with databases to know the
  // target DB's path. Dynamic queries are skipped.
  const queries = db.prepare(`
    SELECT sq.id, sq.line, sq.method, sq.sql,
           d.id AS db_id, d.name AS db_name, d.path_or_uri AS db_path, d.type AS db_type
    FROM sql_queries sq
    LEFT JOIN databases d ON sq.inferred_database_id = d.id
    WHERE sq.file_id = ? AND sq.is_dynamic = 0
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
  let checked = 0;
  let skipped_no_db = 0;
  let skipped_db_missing = 0;
  let skipped_unsupported = 0;

  for (const [, group] of byDb) {
    if (!group.db_path) {
      // No inferred DB — we can't check these. Common for files that
      // construct queries to be passed elsewhere, or for tools that take
      // a connection as a parameter. Not a failure, just unverifiable.
      skipped_no_db += group.queries.length;
      continue;
    }
    if (group.db_type !== 'sqlite') {
      // V1: SQLite only. Other DB types are additive.
      skipped_unsupported += group.queries.length;
      continue;
    }
    if (!fs.existsSync(group.db_path)) {
      skipped_db_missing += group.queries.length;
      // Could argue this should be a failure (DB the file expects is gone),
      // but for v1 we treat it as skip — the file may legitimately create
      // the DB at runtime.
      continue;
    }

    // Open read-only with immutable=1 hint for safety. Schema introspection
    // and EXPLAIN both work fine in this mode and cannot perturb the DB.
    let liveDb;
    try {
      liveDb = new BetterSqlite3(group.db_path, { readonly: true, fileMustExist: true });
    } catch (err) {
      // Couldn\'t open — record as a single skip rather than failing each query
      skipped_db_missing += group.queries.length;
      continue;
    }

    try {
      for (const q of group.queries) {
        const result = explainQueriesAgainstSqlite(liveDb, q.sql);
        checked += 1;
        if (!result.ok) {
          failures.push({
            line: q.line,
            method: q.method,
            db: group.db_name,
            sql_preview: q.sql.replace(/\s+/g, ' ').trim().slice(0, 100),
            error: result.error,
            statement_index: result.statement_index ?? 0,
          });
        }
      }
    } finally {
      try { liveDb.close(); } catch {}
    }
  }

  return {
    ok: failures.length === 0,
    checked,
    failures,
    skipped: {
      no_db_inferred: skipped_no_db,
      db_missing: skipped_db_missing,
      non_sqlite: skipped_unsupported,
    },
  };
}

// EXPLAIN one or more SQL statements against a live SQLite connection.
// Splits on top-level semicolons (not inside string literals) and tries
// each. Returns ok=true if every statement EXPLAINs cleanly; otherwise
// ok=false with the first failure\'s details.
function explainQueriesAgainstSqlite(liveDb, sql) {
  const statements = splitSqlStatements(sql);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i].trim();
    if (!stmt) continue;
    try {
      // Prepare alone validates the SQL against the schema. EXPLAIN would
      // also work but prepare is cleaner — it returns immediately on parse
      // success and never executes the query.
      const prepared = liveDb.prepare(stmt);
      prepared.finalize?.();
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        statement_index: i,
      };
    }
  }
  return { ok: true };
}

// Split a SQL string on top-level semicolons. Respects single/double-quoted
// strings and SQLite-style bracket identifiers so semicolons inside string
// literals or quoted names don\'t cause false splits.
function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let inSingle = false, inDouble = false, inBracket = false, inLineComment = false, inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      buf += c;
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += c;
      if (c === '*' && next === '/') { buf += next; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "'" && next === "'") { buf += next; i++; }
      else if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"' && next === '"') { buf += next; i++; }
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inBracket) {
      buf += c;
      if (c === ']') inBracket = false;
      continue;
    }

    if (c === "'") { inSingle = true; buf += c; continue; }
    if (c === '"') { inDouble = true; buf += c; continue; }
    if (c === '[') { inBracket = true; buf += c; continue; }
    if (c === '-' && next === '-') { inLineComment = true; buf += c; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; buf += c; continue; }

    if (c === ';') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.length === 0 ? [sql] : out;
}
