// ─── read_file as the single door: projects, structure, coordinates, scans ──
//
// read_file()                                  → list of projects
// read_file(path=<project name | folder>)      → project structure only (no code);
//                                                over ~3000 tokens it asks for search
// read_file(path=<project>, segment=<coord>)   → coord names a file (its skeleton)
//                                                or a file + segment (that code)
// read_file(path=<unscanned folder>)           → scans it first (big folders in the
//                                                background), then the structure
// read_file(path=<project>, trace=true)        → the project's data-flow map
//
// The architect engine stays internal; agents never need a project_id.

import fs from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { scanProject } from './scan.js';
import { estimateScan } from './estimate.js';
import { getTopology } from './query.js';

const TOKEN_LIMIT = 3000;          // same rule as a file skeleton
const FOREGROUND_SCAN_MS = 20000;  // estimated longer than this → background scan
const tokens = (v) => Math.ceil(JSON.stringify(v).length / 4);

// Background scans, per sandbox/DB: key "<db>|<dir>" → { startedAt, est, promise, result, error }
const _scans = new Map();
const dbKey = () => globalThis.__sandboxCtx?.getStore?.()?.architectDb || process.env.MASTER_ARCHITECT_DB || 'default';

function realProjects(db) {
  return db.prepare(
    "SELECT id, name, root_path FROM projects WHERE root_path NOT LIKE 'unknown://%' ORDER BY name"
  ).all();
}

// ── read_file() with no path ────────────────────────────────────────────────
export function listProjectsView() {
  const db = getDb();
  const rows = realProjects(db).map(p => ({
    name: p.name,
    folder: p.root_path,
    files: db.prepare('SELECT COUNT(*) c FROM files WHERE project_id = ?').get(p.id).c,
  }));
  return rows.length
    ? { projects: rows, next: 'read_file(path="<name>") shows a project\'s structure' }
    : { projects: [], next: 'No projects yet. read_file(path="<folder>") scans a folder into a project; write_file(project="<new name>") starts one.' };
}

// ── What does a path / name point at? ───────────────────────────────────────
// Returns { kind: 'project', project, subRel } | { kind: 'unscanned_dir', dir } | null
export function resolveProjectTarget(p) {
  if (!p) return null;
  const db = getDb();
  const projects = realProjects(db);
  let isDir = false;
  try { isDir = fs.statSync(p).isDirectory(); } catch {}
  if (isDir) {
    const abs = path.resolve(p);
    // deepest project root that contains this folder
    const owner = projects
      .filter(pr => abs === pr.root_path || abs.startsWith(pr.root_path + path.sep))
      .sort((a, b) => b.root_path.length - a.root_path.length)[0];
    if (owner) return { kind: 'project', project: owner, subRel: abs === owner.root_path ? '' : abs.slice(owner.root_path.length + 1) };
    return { kind: 'unscanned_dir', dir: abs };
  }
  let exists = false;
  try { fs.statSync(p); exists = true; } catch {}
  if (!exists) {
    const byName = projects.find(pr => pr.name === p || pr.name === path.basename(p));
    if (byName) return { kind: 'project', project: byName, subRel: '' };
  }
  return null;   // a file (normal read_file path) or nothing at all
}

// ── Structure view ──────────────────────────────────────────────────────────
function natural(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb && +pa[i] !== +pb[i]) return +pa[i] - +pb[i];
    if (pa[i] !== pb[i]) return (pa[i].length - pb[i].length) || (pa[i] < pb[i] ? -1 : 1);
  }
  return 0;
}

export function projectStructure(project, { search = null, full = false, subRel = '' } = {}) {
  const db = getDb();
  const dirs = db.prepare('SELECT address, rel_path FROM directories WHERE project_id = ?').all(project.id);
  const files = db.prepare(
    'SELECT address, rel_path, language, line_count, category FROM files WHERE project_id = ? AND present_on_disk = 1'
  ).all(project.id);

  const under = (rel) => !subRel || rel === subRel || rel.startsWith(subRel + '/');
  let entries = [
    ...dirs.filter(d => under(d.rel_path)).map(d => ({ addr: d.address, rel: d.rel_path, dir: true })),
    ...files.filter(f => under(f.rel_path)).map(f => ({
      addr: f.address, rel: f.rel_path, dir: false,
      info: f.category === 'opaque_binary' ? 'binary'
        : [f.language, f.line_count != null ? `${f.line_count} lines` : null].filter(Boolean).join(', '),
    })),
  ];

  if (search) {
    const q = search.toLowerCase();
    const hits = entries.filter(e => !e.dir && e.rel.toLowerCase().includes(q));
    const keepDirs = new Set();
    for (const h of hits) {
      const parts = h.rel.split('/');
      for (let i = 1; i < parts.length; i++) keepDirs.add(parts.slice(0, i).join('/'));
    }
    const dirHits = entries.filter(e => e.dir && (e.rel.toLowerCase().includes(q) || keepDirs.has(e.rel)));
    entries = [...dirHits, ...hits];
  }

  // Tree order: each subfolder with its contents, then the folder's files.
  const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const kids = new Map();   // parent rel → entries
  for (const e of entries) {
    const p = parentOf(e.rel);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(e);
  }
  const ordered = [];
  const self = subRel ? entries.find(e => e.dir && e.rel === subRel) : null;
  if (self) ordered.push(self);   // the folder being viewed heads its own list
  const emit = (parentRel) => {
    const list = (kids.get(parentRel) || []).slice();
    const fls = list.filter(e => !e.dir).sort((a, b) => natural(a.addr, b.addr) || (a.rel < b.rel ? -1 : 1));
    const dirsHere = list.filter(e => e.dir).sort((a, b) => natural(a.addr, b.addr));
    // Subfolders first: they hold a folder's first letters (files continue
    // the same counter), so coordinates read in order top to bottom.
    for (const d of dirsHere) { ordered.push(d); emit(d.rel); }
    ordered.push(...fls);
  };
  emit(subRel || '');
  // Entries whose parent folder isn't listed (e.g. files of an unscanned
  // subfolder) still appear, at the end.
  const seen = new Set(ordered);
  for (const e of entries) if (!seen.has(e)) ordered.push(e);
  const lines = ordered.map(e => e.dir ? `${e.addr}/  ${e.rel}/` : `${e.addr}  ${e.rel}  (${e.info || 'not parsed'})`);

  // Broken imports inside what is being viewed (the folder, or the project).
  const broken = db.prepare(`
    SELECT COUNT(*) c FROM imports i JOIN files f ON f.id = i.file_id
    WHERE f.project_id = ? AND i.is_external = 0 AND i.resolved_file_id IS NULL
      AND (? = '' OR substr(f.rel_path, 1, length(?) + 1) = ? || '/')`).get(project.id, subRel, subRel, subRel).c;

  const head = {
    project: project.name,
    folder: project.root_path + (subRel ? '/' + subRel : ''),
    files: entries.filter(e => !e.dir).length,
    folders: entries.filter(e => e.dir).length,
    ...(search ? { search } : {}),
    ...(broken ? { broken_imports: broken } : {}),
  };
  const next = `Open a file: read_file(path="${project.name}", segment="<coordinate>"); `
    + `a segment directly: segment="<file coordinate>.<segment>". Data flow: read_file(path="${project.name}", trace=true).`;

  const view = { ...head, structure: lines, next };
  if (full || tokens(view) <= TOKEN_LIMIT) return view;

  // Too big: overview per top-level folder, then ask for a search term.
  const top = new Map();
  for (const e of entries) {
    if (e.dir) continue;
    const rest = subRel ? e.rel.slice(subRel.length + 1) : e.rel;
    const first = rest.includes('/') ? rest.split('/')[0] + '/' : '(files here)';
    top.set(first, (top.get(first) || 0) + 1);
  }
  return {
    ...head,
    too_large: true,
    structure_tokens: tokens(view),
    overview: [...top.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}  ${n} files`),
    next: `Narrow it: read_file(path="${project.name}", search="<part of a file or folder name>"), `
      + `or a folder: read_file(path="<folder>"). full_skeleton=true forces the whole list.`,
  };
}

// Files addressed by number come from scans before letter coordinates.
export function needsLetterRescan(project) {
  return !!getDb().prepare(`
    SELECT 1 FROM files WHERE project_id = ? AND present_on_disk = 1
      AND address != 'pending' AND address GLOB '*[0-9]' LIMIT 1`).get(project.id);
}

// ── Coordinates ─────────────────────────────────────────────────────────────
// The longest prefix of the coordinate that is a file's address names the
// file; what follows is a segment address inside it. A coordinate that is a
// folder's address returns that folder's structure.
export function resolveCoordinate(project, coord) {
  const db = getDb();
  const parts = String(coord).split('.').filter(Boolean);
  const fileAt = db.prepare('SELECT abs_path FROM files WHERE project_id = ? AND address = ?');
  for (let n = parts.length; n >= 1; n--) {
    const prefix = parts.slice(0, n).join('.');
    const f = fileAt.get(project.id, prefix);
    if (f) return { kind: 'file', absPath: f.abs_path, segment: n < parts.length ? parts.slice(n).join('.') : null };
  }
  const d = db.prepare('SELECT rel_path FROM directories WHERE project_id = ? AND address = ?').get(project.id, parts.join('.'));
  if (d) return { kind: 'folder', subRel: d.rel_path };
  return null;
}

// ── Data flow for a whole project (trace on a project) ─────────────────────
export function projectDataFlow(project) {
  const topo = getTopology(project.id);
  const nodes = topo.nodes || [], edges = topo.edges || [];
  const label = (id, name) => `${id} ${name || ''}`.trim();
  const arrow = (k) => (k === 'imports' ? '→' : k === 'db_connection' ? '⇄ db' : `→ (${k})`);
  const lines = edges.map(e => `${label(e.from, e.from_name)} ${arrow(e.kind)} ${label(e.to, e.to_name)}`);
  // Entry points worth knowing: code files nothing imports that DO lead somewhere.
  const leadsOut = new Set(edges.map(e => e.from));
  const entries = nodes
    .filter(n => n.entry_point && n.kind === 'file' && n.category === 'supported' && leadsOut.has(n.id))
    .map(n => label(n.id, n.rel_path));
  const view = {
    project: project.name,
    entry_points: entries,
    connections: lines,
    next: `Connections of one file, live: read_file(path="${project.name}", segment="<file coordinate>", trace=true).`,
  };
  if (tokens(view) <= TOKEN_LIMIT) return view;
  const keep = [];
  let budget = TOKEN_LIMIT - tokens({ ...view, connections: [] });
  for (const l of lines) { budget -= Math.ceil((l.length + 4) / 4); if (budget < 0) break; keep.push(l); }
  return { ...view, connections: keep,
           _trimmed: `showing ${keep.length} of ${lines.length} connections — trace a single file for its own` };
}

// ── Scanning an unscanned folder ────────────────────────────────────────────
// Small folders: scanned now, then shown. Big ones: background scan, the agent
// calls again. touch() keeps a sandbox alive while a background scan runs.
export async function scanForView(dir, touch) {
  const key = `${dbKey()}|${dir}`;
  const job = _scans.get(key);
  if (job) {
    if (job.error) { _scans.delete(key); return { scanned: false, error: `scan failed: ${job.error}` }; }
    if (!job.result) {
      const secs = Math.round((Date.now() - job.startedAt) / 1000);
      return { scanning: true, folder: dir, elapsed_seconds: secs, estimated_seconds: job.est?.est_duration_seconds ?? null,
               next: `Still scanning. Call read_file(path="${dir}") again in a few seconds.` };
    }
    _scans.delete(key);
    return { scanned: true, result: job.result };
  }

  let est = null;
  try { est = estimateScan(dir); } catch {}
  if (!est || (est.est_duration_ms ?? 0) <= FOREGROUND_SCAN_MS) {
    const result = await scanProject(dir, undefined, { expectedMs: est?.est_duration_ms });
    if (!result.ok) return { scanned: false, error: result.message || result.reason || 'scan did not finish' };
    return { scanned: true, result };
  }

  const entry = { startedAt: Date.now(), est, result: null, error: null };
  const keepAlive = touch ? setInterval(() => { try { touch(); } catch {} }, 30000) : null;
  entry.promise = scanProject(dir, undefined, { expectedMs: est.est_duration_ms })
    .then(r => { if (r.ok) entry.result = r; else entry.error = r.message || r.reason || 'scan did not finish'; })
    .catch(e => { entry.error = e.message; })
    .finally(() => { if (keepAlive) clearInterval(keepAlive); });
  _scans.set(key, entry);
  return { scanning: true, folder: dir, files: est.files_total, estimated_seconds: est.est_duration_seconds,
           next: `Scanning in the background. Call read_file(path="${dir}") again in about ${Math.max(5, est.est_duration_seconds)} seconds.` };
}

// Sandbox: forget a wiped slot's background scans.
(globalThis.__sandboxForgetHooks ||= []).push((slotDir) => {
  for (const k of [..._scans.keys()]) if (k.startsWith(slotDir + '/') || k.startsWith(slotDir + '|')) _scans.delete(k);
});
