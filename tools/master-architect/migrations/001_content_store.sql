-- ─────────────────────────────────────────────────────────────────────────────
-- Architect content + version store (section H, step 1)
-- Additive migration: new tables only, keyed to existing files.id. Touches
-- nothing existing → safe to apply while the live tool runs.
--
-- Purpose: let the ARCHITECT hold each file's working content + segment tree
-- (so read_file's buffer can be eliminated) and keep real per-version history
-- (so "version" means retrievable snapshots, not just a counter).
-- ─────────────────────────────────────────────────────────────────────────────

-- Live working content: one row per file. The architect serves reads from here.
-- content is byte-faithful (BLOB) so any file round-trips for commit/push.
-- segments is the assembleable segment-tree JSON (same shape the digester +
-- read_file segmenter produce). hash = sha256 of content, drives delta.
CREATE TABLE IF NOT EXISTS file_content (
  file_id          INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  hash             TEXT NOT NULL,
  size             INTEGER NOT NULL,
  is_binary        INTEGER NOT NULL DEFAULT 0,
  language         TEXT,
  content          BLOB,
  segments         TEXT,                 -- JSON segment tree (NULL for binary / no-parser)
  has_parse_errors INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT DEFAULT (datetime('now'))
);

-- Append-only version history: one row per committed version of a file.
-- version_number pairs with files.version. content/segments are the snapshot
-- AS COMMITTED at that version, so any prior version is retrievable.
CREATE TABLE IF NOT EXISTS file_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  hash            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  content         BLOB,
  segments        TEXT,
  change_type     TEXT,                  -- 'created' | 'edit' | 'bugfix' | 'feature' | 'refactor'
  change_summary  TEXT,
  verified_at_level INTEGER,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(file_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id, version_number);
