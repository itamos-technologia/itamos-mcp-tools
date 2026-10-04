/**
 * master-architect database — schema + connection helper.
 *
 * Hierarchical addressing scheme:
 *   project        →  (no address, root)
 *   directory      →  1, 2, 3, ...           (siblings under project)
 *   file (code)    →  1.2, 1.3, ...          (numeric: parser available)
 *   file (other)   →  1.a, 1.b, ...          (letter: coming-soon or opaque)
 *   module         →  1.2.1, 1.2.2, ...      (only for parsed files)
 *   method         →  1.2.1.1, 1.2.1.2, ...
 *   database       →  99.1, 99.2, ...        (special branch)
 *   db_table       →  99.1.1, 99.1.2, ...
 *
 * File verification lifecycle:
 *   verification_status: 'unverified' | 'verified' | 'not_verifiable'
 *   - unverified:     created or modified, hasn't passed L3 verify yet
 *   - verified:       last commit passed L3 verify
 *   - not_verifiable: file type has no parser (opaque/coming_soon)
 *   version:    integer, incremented each time the file passes verify+commit
 *   verified_at_level: which level last passed (always 3 for verified state in v1)
 *   verified_at: ISO datetime of last successful verify+commit
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
    root_path    TEXT    NOT NULL UNIQUE,
    created_at   TEXT    DEFAULT (datetime('now')),
    updated_at   TEXT    DEFAULT (datetime('now')),
    last_scan_at TEXT
  );

  CREATE TABLE IF NOT EXISTS directories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    parent_id   INTEGER,
    address     TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    rel_path    TEXT    NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id)  REFERENCES directories(id) ON DELETE CASCADE,
    UNIQUE (project_id, rel_path)
  );

  CREATE TABLE IF NOT EXISTS files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL,
    directory_id    INTEGER,
    address         TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    rel_path        TEXT    NOT NULL,
    abs_path        TEXT    NOT NULL UNIQUE,
    language        TEXT,
    category        TEXT    NOT NULL,
    parse_status    TEXT    NOT NULL DEFAULT 'parsed',
    is_readable_text INTEGER NOT NULL DEFAULT 1,
    line_count      INTEGER,
    byte_size       INTEGER,
    est_tokens      INTEGER,
    last_modified   TEXT,
    last_scanned    TEXT    DEFAULT (datetime('now')),

    -- verification lifecycle
    verification_status TEXT    NOT NULL DEFAULT 'unverified',
    version             INTEGER NOT NULL DEFAULT 0,
    verified_at_level   INTEGER,
    verified_at         TEXT,
    -- integrity tracking: snapshotted at verify time, used to detect drift
    -- when the file changes outside our verification pipeline (coworker
    -- overwrite, git pull, IDE save, etc.). On disagreement we demote to
    -- unverified — file may be fine, but it's not OUR verified state anymore.
    content_hash        TEXT,
    byte_size_at_verify INTEGER,
    -- parser/detector version stamp at last successful parse. The scan skip-gate
    -- compares this alongside content_hash: a file is only skipped when BOTH its
    -- content AND the parser version are unchanged. Bumping PARSER_VERSION (in
    -- this file) therefore forces a one-time re-parse of every file on the next
    -- scan — the correct way to roll out detection-logic changes without a manual
    -- hash-clear or a separate force-rescan path. Pure content_hash stays pure,
    -- so drift detection is unaffected.
    parser_version      TEXT,

    FOREIGN KEY (project_id)   REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (directory_id) REFERENCES directories(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS modules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id     INTEGER NOT NULL,
    address     TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    line_start  INTEGER,
    line_end    INTEGER,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS methods (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id   INTEGER NOT NULL,
    address     TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    kind        TEXT    NOT NULL,
    line_start  INTEGER,
    line_end    INTEGER,
    FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS imports (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id          INTEGER NOT NULL,
    import_path      TEXT    NOT NULL,
    resolved_file_id INTEGER,
    is_external      INTEGER NOT NULL DEFAULT 0,
    line             INTEGER,
    FOREIGN KEY (file_id)          REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (resolved_file_id) REFERENCES files(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS databases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    address     TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    type        TEXT,
    path_or_uri TEXT,
    -- JSON blob with type-specific config (e.g., postgres connection details)
    extra       TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS db_tables (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    database_id  INTEGER NOT NULL,
    address      TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    schema_text  TEXT,
    FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS db_connections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id      INTEGER NOT NULL,
    database_id  INTEGER NOT NULL,
    line         INTEGER,
    FOREIGN KEY (file_id)     REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
  );

  -- EXTERNAL DEPENDENCY NODES (stage 1 of the architecture-graph expansion).
  -- Things a file needs to RUN that aren't code-to-code imports: runtime
  -- servers/endpoints, model files, external binaries, system services, ports.
  -- Project-scoped and deduped by (project_id, kind, locator). Mirrors the
  -- databases table. The filtered need-to-know context for adding/debugging code.
  CREATE TABLE IF NOT EXISTS external_refs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,   -- server | model | binary | service | port
    name        TEXT    NOT NULL,   -- human label (e.g. 'llama-server', 'gemma3-1b')
    locator     TEXT,               -- host:port | abs model path | binary path | unit name  (IDENTITY)
    version     TEXT,               -- captured where detectable (binary --version, etc.)
    -- JSON blob: kind-specific detail (protocol, ExecStart, format, size, inferred links)
    extra       TEXT
  );
  -- locator-as-identity: one shared node per (kind, locator). Shared across projects.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_extref_identity ON external_refs(kind, locator);

  -- Project membership (many-to-many): a shared external node can belong to
  -- multiple projects at once. Mirrors how code files get project membership.
  CREATE TABLE IF NOT EXISTS external_ref_projects (
    external_ref_id INTEGER NOT NULL,
    project_id      INTEGER NOT NULL,
    PRIMARY KEY (external_ref_id, project_id),
    FOREIGN KEY (external_ref_id) REFERENCES external_refs(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_extrefproj_project ON external_ref_projects(project_id);

  CREATE TABLE IF NOT EXISTS file_external_refs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id         INTEGER NOT NULL,
    external_ref_id INTEGER NOT NULL,
    line            INTEGER,
    FOREIGN KEY (file_id)         REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (external_ref_id) REFERENCES external_refs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_fextref_file ON file_external_refs(file_id);
  CREATE INDEX IF NOT EXISTS idx_fextref_ref  ON file_external_refs(external_ref_id);

  CREATE TABLE IF NOT EXISTS lmdb_subdb_refs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id      INTEGER NOT NULL,
    line         INTEGER,
    name         TEXT NOT NULL,
    -- inferred link to the lmdb env this file uses (heuristic at scan time)
    inferred_database_id  INTEGER,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (inferred_database_id) REFERENCES databases(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sql_queries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id      INTEGER NOT NULL,
    line         INTEGER,
    method       TEXT,
    sql          TEXT NOT NULL,
    is_dynamic   INTEGER NOT NULL DEFAULT 0,
    -- inferred database link: heuristic best-guess at scan time
    -- (the same file may connect to multiple DBs; we record which is most likely)
    inferred_database_id  INTEGER,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (inferred_database_id) REFERENCES databases(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS scans (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id          INTEGER NOT NULL,
    started_at          TEXT    DEFAULT (datetime('now')),
    finished_at         TEXT,
    duration_ms         INTEGER,
    files_total         INTEGER DEFAULT 0,
    files_parsed        INTEGER DEFAULT 0,
    files_pending_lang  INTEGER DEFAULT 0,
    files_opaque        INTEGER DEFAULT 0,
    files_skipped       INTEGER DEFAULT 0,
    files_errored       INTEGER DEFAULT 0,
    error_message       TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_files_abs_path     ON files(abs_path);
  CREATE INDEX IF NOT EXISTS idx_files_project      ON files(project_id);
  CREATE INDEX IF NOT EXISTS idx_files_address      ON files(project_id, address);
  CREATE INDEX IF NOT EXISTS idx_files_name         ON files(name);
  CREATE INDEX IF NOT EXISTS idx_files_category     ON files(category);
  CREATE INDEX IF NOT EXISTS idx_files_verification ON files(verification_status);
  CREATE INDEX IF NOT EXISTS idx_dirs_project       ON directories(project_id);
  CREATE INDEX IF NOT EXISTS idx_modules_file       ON modules(file_id);
  CREATE INDEX IF NOT EXISTS idx_modules_address    ON modules(address);
  CREATE INDEX IF NOT EXISTS idx_methods_module     ON methods(module_id);
  CREATE INDEX IF NOT EXISTS idx_methods_address    ON methods(address);
  CREATE INDEX IF NOT EXISTS idx_imports_file       ON imports(file_id);
  CREATE INDEX IF NOT EXISTS idx_imports_resolved   ON imports(resolved_file_id);
  CREATE INDEX IF NOT EXISTS idx_sql_queries_file  ON sql_queries(file_id);
  CREATE INDEX IF NOT EXISTS idx_lmdb_subdb_refs_file ON lmdb_subdb_refs(file_id);
  CREATE INDEX IF NOT EXISTS idx_projects_root      ON projects(root_path);
`;
// PARSER/DETECTOR VERSION. Bump this whenever parsing or detection logic changes
// (a parser adapter, external_detect, walkDatabases, etc.). The scan skip-gate
// stores this per file and only skips re-parsing when BOTH content_hash AND
// parser_version are unchanged — so a bump forces a one-time re-parse of every
// file on the next scan, with no manual hash-clear and no force-rescan path.
// History: v2 = dynamic-path SQLite (new Database(<var>)) detection.
//          v3 = per-handle query attribution (receiver → handle_var) +
//               readonly-flag capture; replaces "first SQL db wins".
//          v4 = fix duplicate database emission in walkDatabases (a stray
//               leftover old new_expression handler was double-registering
//               every SQLite/Postgres connection).
//          v5 = stop wiping DB-derived tables project-wide; clear per file in
//               the parse path + end-of-scan orphan-database GC, so skipped
//               files keep their databases/queries. Forces a corrective
//               re-parse to repopulate data the project-wide wipe had dropped.
//          v6 = plugin-load detection: walkDynamicLoads finds readdirSync(dir)
//               + .js filter idioms; scan resolves the dir and emits 'load'
//               edges (edge_kind in imports) to each real file loaded, so
//               modular servers show connected to the tools they load.
//          v7 = nginx config parser (.conf/.nginx): server/upstream blocks as
//               modules, include directives as imports, listen/proxy_pass as
//               external refs with role (listen/upstream). scan merges parser-
//               supplied external_refs with generic detection.
//          v8 = location-based nginx detection: files under sites-enabled/
//               sites-available/ conf.d/ (or named nginx.conf) parse as nginx
//               regardless of extension, so extensionless vhosts are caught.
//               detectLanguage now receives the full path from scan.
//          v9 = fix: files with external refs but no imports/dbs/loads (e.g. an
//               nginx vhost with only listen/proxy_pass, no include) now enter
//               pendingResolution so their external refs actually get stored.
//          v10 = parser external refs win over generic on kind|locator, and
//                upsertExtRef refreshes `extra` when a richer ref arrives, so
//                proxy_pass targets keep role=upstream (not overwritten by the
//                generic role-less http detection of the same host:port).
//          v11 = code HTTP listener detection: walkListeners finds app.listen/
//                .listen(PORT) (resolving PORT through process.env.X || NNNN),
//                stored as role=listen external refs (host:port). Lets an nginx
//                upstream be matched to the code file that listens on that port.
//          v12 = nginx listen IPv6 fix: `listen [::]:443` now parses to
//                port=443 (bracket-host regex) instead of port=null; `*:port`
//                normalized to 0.0.0.0.
export const PARSER_VERSION = '13';  // 13: import classification + re-link pass


const _conns = new Map();   // db path -> open connection (one per slot DB in the sandbox)
let _path = null;

export function getDb(dbPath) {
  const store = globalThis.__sandboxCtx?.getStore?.();
  if (!dbPath && globalThis.__sandboxCtx && !store?.architectDb) {
    // Sandbox: never fall back to a shared default index outside a request.
    throw new Error('sandbox: no request context; refusing to open a shared architect DB');
  }
  const requestedPath = dbPath || store?.architectDb || process.env.MASTER_ARCHITECT_DB
    || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'master-architect.db');
  _path = requestedPath;
  const cached = _conns.get(requestedPath);
  if (cached && cached.open) return cached;
  try { mkdirSync(path.dirname(requestedPath), { recursive: true }); } catch {}
  const conn = new Database(requestedPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA);
  // Idempotent column adds for DBs created before a column existed. SQLite has
  // no ADD COLUMN IF NOT EXISTS, so guard each via PRAGMA table_info. CREATE
  // TABLE IF NOT EXISTS in SCHEMA never alters an existing table, so this is the
  // only path by which a pre-existing DB gains new columns.
  ensureColumn(conn, 'files', 'parser_version', 'TEXT');
  // edge_kind distinguishes a normal static import ('import') from a synthetic
  // plugin-load edge ('load') emitted when a file dynamically loads every JS in
  // a directory (readdirSync + dynamic import). Lets the graph show modular
  // servers connected to the tools they load by directory convention.
  ensureColumn(conn, 'imports', 'edge_kind', "TEXT DEFAULT 'import'");
  // Used by scan / read_file / architect-link. Previously only present in hand-upgraded DBs,
  // so a fresh install failed on its first scan. Additive and idempotent.
  ensureColumn(conn, 'files', 'present_on_disk', 'INTEGER NOT NULL DEFAULT 1');
  conn.exec(CONTENT_STORE_SCHEMA);
  _conns.set(requestedPath, conn);
  return conn;
}

// Add `col <type>` to `table` if not already present. No-op when the column
// exists. Additive, backward-compatible schema evolution for live DBs.
const CONTENT_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS file_content (
    file_id          INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    hash             TEXT NOT NULL,
    size             INTEGER NOT NULL,
    is_binary        INTEGER NOT NULL DEFAULT 0,
    language         TEXT,
    content          BLOB,
    segments         TEXT,
    has_parse_errors INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS file_versions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version_number    INTEGER NOT NULL,
    hash              TEXT NOT NULL,
    size              INTEGER NOT NULL,
    content           BLOB,
    segments          TEXT,
    change_type       TEXT,
    change_summary    TEXT,
    verified_at_level INTEGER,
    created_at        TEXT DEFAULT (datetime('now')),
    UNIQUE(file_id, version_number)
  );
  CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id, version_number);
  CREATE TABLE IF NOT EXISTS verified_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER NOT NULL,
    source_module_id INTEGER,
    import_id INTEGER,
    connector TEXT NOT NULL,
    target_file_id INTEGER,
    target_module_id INTEGER,
    verified_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(source_file_id) REFERENCES files(id),
    FOREIGN KEY(source_module_id) REFERENCES modules(id),
    FOREIGN KEY(target_file_id) REFERENCES files(id),
    FOREIGN KEY(target_module_id) REFERENCES modules(id)
  );
  CREATE INDEX IF NOT EXISTS idx_vlinks_source ON verified_links(source_file_id, source_module_id);
  CREATE INDEX IF NOT EXISTS idx_vlinks_target ON verified_links(target_file_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vlinks_unique ON verified_links(source_file_id, connector, import_id);
`;

function ensureColumn(conn, table, col, type) {
  try {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  } catch (e) {
    console.error(`[db] ensureColumn ${table}.${col} failed: ${e.message}`);
  }
}

export function closeDb() {
  for (const c of _conns.values()) { try { c.close(); } catch {} }
  _conns.clear(); _path = null;
}

// Sandbox: close and forget every connection under a wiped slot directory.
(globalThis.__sandboxForgetHooks ||= []).push((slotDir) => {
  for (const [p, c] of _conns) {
    if (p === slotDir || p.startsWith(slotDir + '/')) { try { c.close(); } catch {} _conns.delete(p); }
  }
});

export function dbPath() { return _path; }

export function estimateTokens(byteSize) {
  return Math.ceil(byteSize / 3.7);
}

/**
 * Compute the initial verification status for a newly-scanned file.
 * Files that can't be parsed (opaque, coming_soon, parse_error) get
 * 'not_verifiable'. Files that parsed cleanly start as 'unverified' —
 * they have to actually pass L3 verify+commit through read_file to be
 * promoted. Clean parse alone is not enough.
 */
export function initialVerificationStatus(category, parseStatus) {
  if (category === 'opaque_binary' || category === 'opaque_text' || category === 'coming_soon') {
    return 'not_verifiable';
  }
  if (parseStatus === 'parse_error') {
    return 'not_verifiable';   // can't verify what we can't parse
  }
  return 'unverified';
}
