// =============================================================================
// HEADER
// =============================================================================
//
// read_file v3.1 — segment-addressed file editor for MCP, with DB-backed undo,
// segment moves, and comment/uncomment.
//
// THE MODEL:
//   Every byte of a code file belongs to exactly one segment. The skeleton
//   IS the file. Operations address segments by stable internal ID; display
//   shows ordered numbers. Line-based addressing is NOT a primary path.
//
// TOP-LEVEL VERBS:
//   read_file(path)                              -> skeleton (segment list)
//   read_file(path, segment="N")                 -> full text of segment N
//   read_file(path, replace="N", content="...")  -> swap segment N's content
//   read_file(path, delete=["N", "M"])           -> remove segments
//   read_file(path, insert={between:["A","B"], content:"..."})
//                                                 -> insert into the gap
//   read_file(path, move={seg:"N", after:"M"})   -> reorder a segment
//   read_file(path, comment_out="N")             -> wrap segment in #/// markers
//   read_file(path, uncomment="N")               -> strip #/// markers
//   read_file(path, undo="N" | true | "all")     -> revert
//   read_file(path, verify=1|2|3)                -> validate (sets token)
//   read_file(path, diff=true)                   -> show changes vs disk
//   read_file(path, commit=true)                 -> atomic write (REQUIRES
//                                                   a recent verify pass)
//   read_file(path, discard=true)                -> drop buffer
//   read_file(action="status")                   -> list open buffers
//
// COMMIT GATE (per librarian 5166):
//   Commit blocks unless verify has passed against the buffer's CURRENT
//   state hash. Any edit invalidates the verify token. Re-verify after edits.
//
// EDIT SCRATCHPAD:
//   Edits are mirrored to a SQLite DB at .read_file_state/edits.db. The DB
//   holds nothing across commit/discard — it's a parallel record so undo can
//   query (and survive in-process state issues). Wiped on every buffer
//   creation, commit, and discard.
//
// SEE: librarian entries 5163-5177 for the design history.
//
// =============================================================================
// IMPORTS
// =============================================================================

import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import JsModule from 'tree-sitter-javascript';
import TsModule from 'tree-sitter-typescript';
import HtmlModule from 'tree-sitter-html';
import CssModule from 'tree-sitter-css';
import GoModule from 'tree-sitter-go';
import RustModule from 'tree-sitter-rust';
import CModule from 'tree-sitter-c';
import CppModule from 'tree-sitter-cpp';
import JavaModule from 'tree-sitter-java';
import CSharpModule from 'tree-sitter-c-sharp';
import PhpModule from 'tree-sitter-php';
import RubyModule from 'tree-sitter-ruby';
import BashModule from 'tree-sitter-bash';
import SwiftModule from 'tree-sitter-swift';
import KotlinModule from 'tree-sitter-kotlin';
import { z } from 'zod';
import { promises as fs, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { logCost } from '../../mcp_tools/lib/cost_log.js';
import path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getProjectInfoForFile, markFileVerified, markFileUnverified, checkAndHandleDrift, checkImportResolution, discoverAndFileByLinks, storeFileContent, getStoredSkeleton, refreshFileModules, updateExternalSpecs } from './lib/editor/architect-link.js';
import { detectExternalRefs, gatherSpecs } from './lib/external_detect.js';
import { segmentFile as workerSegmentFile } from './lib/segmenter.js';
import { runAdapters } from './lib/adapters/_dispatcher.js';
import { fileURLToPath as _fileURLToPath } from 'url';

// Architect DB path — derived from this file's location for portability.
// Same convention as architect-link.js.
const _READ_FILE_DIR = path.dirname(_fileURLToPath(import.meta.url));
const _DEFAULT_ARCHITECT_DB = path.join(_READ_FILE_DIR, 'master-architect.db');
function _openArchitectDbReadOnly() {
  const store = globalThis.__sandboxCtx?.getStore?.();
  if (globalThis.__sandboxCtx && !store?.architectDb) throw new Error('sandbox: no request context; refusing to open a shared architect DB');
  const dbPath = store?.architectDb || process.env.MASTER_ARCHITECT_DB || _DEFAULT_ARCHITECT_DB;
  return new Database(dbPath, { readonly: true, fileMustExist: false });
}


const execAsync = promisify(exec);
const JavaScript = JsModule.default || JsModule;
const TypeScript = TsModule.tsx || TsModule.typescript || TsModule.default || TsModule;
const Html = HtmlModule.default || HtmlModule;
const Css    = CssModule.default    || CssModule;
const Go     = GoModule.default     || GoModule;
const Rust   = RustModule.default   || RustModule;
const C      = CModule.default      || CModule;
const Cpp    = CppModule.default    || CppModule;
const Java   = JavaModule.default   || JavaModule;
const CSharp = CSharpModule.default || CSharpModule;
const Php    = (PhpModule.php)      || PhpModule.default || PhpModule;
const Ruby   = RubyModule.default   || RubyModule;
const Bash   = BashModule.default   || BashModule;
const Swift  = SwiftModule.default  || SwiftModule;
const Kotlin = KotlinModule.default || KotlinModule;



// trace: read_file fronts the architect's signal-flow query — the model never
// calls the engine directly. Path in, connections out.
import { getProjectForFile, getConnections } from './lib/query.js';
import { execFile as _execFileCb } from 'child_process';
import * as _fsCF from 'fs';
import * as _pathCF from 'path';
import { promisify as _promisifyCF } from 'util';
import { detectConfigFlavor, checkConfigSyntax } from './lib/config_segmenter.js';
import { validateConfigWithTool } from './lib/config_validators.js';
const _execFileCF = _promisifyCF(_execFileCb);
// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_OPEN_BUFFERS = 10;
const SMALL_FILE_THRESHOLD = 50;        // lines — include full content for tiny files
const SKELETON_TOKEN_THRESHOLD = 3000;  // explosion radius: above this, prompt for a search string instead of dumping all titles

const DB_DIR  = process.env.MCP_DATA_DIR ? path.join(process.env.MCP_DATA_DIR, 'read_file_state') : path.join(process.cwd(), '.read_file_state');
const DB_PATH = path.join(DB_DIR, 'edits.db');

// Section banner regexes (used by detectSectionBanners).
const SECTION_BANNER_SINGLE = /^[\s]*[#/]+[\s═━─=]+([A-Z][A-Z0-9_ /-]{2,})[\s═━─=]+[#/]*\s*$/;
const BANNER_NAME_LINE      = /^[\s]*[#/]+\s+([A-Z][A-Z0-9_ /-]{2,})\s*$/;
const BANNER_RULE_LINE      = /^[\s]*[#/]+[\s═━─=]{5,}[#/]*\s*$/;

const EXT_TO_LANGUAGE = {
  '.py':   'python',
  '.js':   'javascript',
  '.mjs':  'javascript',
  '.cjs':  'javascript',
  '.jsx':  'javascript',
  '.ts':   'typescript',
  '.tsx':  'typescript',
  '.html': 'html',
  '.htm':  'html',
  '.xhtml':'html',
  '.svg':  'html',
  '.vue':  'html',
  '.css':  'css',
  '.scss': 'css',
  '.less': 'css',
  '.txt':  'plaintext',
  '.md':   'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml':  'yaml',
  '.toml': 'toml',
  '.ini':  'ini',
  '.conf': 'ini',
  '.cfg':  'ini',
  '.env':  'env',
  '.log':  'plaintext',
  '.csv':  'plaintext',
  '.rst':  'markdown',
  // Systems
  '.go':   'go',
  '.rs':   'rust',
  '.c':    'c',
  '.h':    'c',
  '.cpp':  'cpp',
  '.hpp':  'cpp',
  '.cc':   'cpp',
  // JVM / mobile
  '.java': 'java',
  '.cs':   'csharp',
  '.kt':   'kotlin',
  '.kts':  'kotlin',
  '.swift':'swift',
  // Scripting
  '.rb':   'ruby',
  '.php':  'php',
  '.sh':   'shell',
  '.bash': 'shell',
};

// ── Ollama AI titling config ──
const OLLAMA_URL = 'http://127.0.0.1:11434';
const AI_TITLE_MODEL = 'gemma3:1b';
const AI_TITLE_MIN_CHARS = 80;

async function ollamaGenerate(prompt, maxTokens = 50) {
  const http = await import('http');
  const payload = JSON.stringify({
    model: AI_TITLE_MODEL, prompt, stream: false,
    options: { num_predict: maxTokens, temperature: 0.1 }
  });
  return new Promise((resolve) => {
    const req = http.default.request(OLLAMA_URL + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.response?.trim().split('\n')[0]?.trim().replace(/^["*]+|["*]+$/g, '') || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function aiTitleSegments(segments, content) {
  const PROMPT_TPL = 'Read the following text and generate a short descriptive title (5-10 words maximum). Output ONLY the title, nothing else.\n\nText:\n{text}\n\nTitle:';
  const needsTitle = segments.filter(s =>
    s._needsAiTitle && (s.endByte - s.startByte) >= AI_TITLE_MIN_CHARS
  );
  if (needsTitle.length === 0) return;
  for (const seg of needsTitle) {
    const text = content.slice(seg.startByte, seg.endByte).slice(0, 2000);
    const prompt = PROMPT_TPL.replace('{text}', text);
    const title = await ollamaGenerate(prompt);
    if (title && title.length > 2 && title.length < 120) {
      seg.name = title.length > 60 ? title.slice(0, 57) + '...' : title;
      seg.aiTitled = true;
    }
    delete seg._needsAiTitle;
  }
  for (const seg of segments) delete seg._needsAiTitle;
}


const STRUCTURAL_OPS = new Set(['delete', 'insert', 'move']);

// =============================================================================
// EDIT DATABASE — SQLite scratchpad for in-flight edits
// =============================================================================
//
// Parallel record of every mutation. Wiped on buffer creation/commit/discard.
// Keyed by (file_path, id). Payloads carry inverse-op data as JSON.
//
// Why use it AT ALL when the in-memory editStack works?
//   1. Resilience to in-process glitches (we can rebuild editStack from rows)
//   2. Auditability for debugging
//   3. Future-proofs for multi-process scenarios

const _editDbs = new Map();   // state dir -> edit-history db (one per slot in the sandbox)

function getDb() {
  const store = globalThis.__sandboxCtx?.getStore?.();
  if (globalThis.__sandboxCtx && !store?.stateDir) throw new Error('sandbox: no request context; refusing to open a shared edit history');
  const dir = store?.stateDir || DB_DIR;
  const cached = _editDbs.get(dir);
  if (cached && cached.open) return cached;
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const _db = new Database(path.join(dir, 'edits.db'));
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      ts TEXT NOT NULL,
      op_kind TEXT NOT NULL,
      seg_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edits_path ON edits(file_path, id);
    CREATE INDEX IF NOT EXISTS idx_edits_path_segid ON edits(file_path, seg_id, id);
  `);
  _editDbs.set(dir, _db);
  return _db;
}

function dbAppendEdit(filePath, opKind, segId, payload) {
  const db = getDb();
  const row = db.prepare(
    'INSERT INTO edits (file_path, ts, op_kind, seg_id, payload_json) VALUES (?, ?, ?, ?, ?)'
  ).run(filePath, new Date().toISOString(), opKind, segId, JSON.stringify(payload));
  return row.lastInsertRowid;
}

function dbWipePath(filePath) {
  const db = getDb();
  db.prepare('DELETE FROM edits WHERE file_path = ?').run(filePath);
}

function dbCountStructuralAfter(filePath, rowId) {
  // Used for LIFO check: any structural op with id > rowId blocks undo of rowId
  // if rowId is itself a structural op.
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM edits
    WHERE file_path = ? AND id > ? AND op_kind IN ('delete','insert','move')
  `).get(filePath, rowId);
  return row.c;
}

// =============================================================================
// LANGUAGE LOADER
// =============================================================================

const _parsers = new Map();

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  // Known extension -> its language. Unknown/extensionless text files (e.g.
  // .sql, .sh, Dockerfile) fall back to 'plaintext', which segmentFile routes
  // through segmentPlainText — full read/edit/verify/commit/undo, just without
  // code-structure parsing. Never returns null, so no "unsupported type" throw.
  return EXT_TO_LANGUAGE[ext] || null;
}

function getParser(language) {
  if (_parsers.has(language)) return _parsers.get(language);
  const p = new Parser();
  if (language === 'python') p.setLanguage(Python);
  else if (language === 'javascript') p.setLanguage(JavaScript);
  else if (language === 'typescript') p.setLanguage(TypeScript);
  else if (language === 'html') p.setLanguage(Html);
  else if (language === 'css')     p.setLanguage(Css);
  else if (language === 'go')      p.setLanguage(Go);
  else if (language === 'rust')    p.setLanguage(Rust);
  else if (language === 'c')       p.setLanguage(C);
  else if (language === 'cpp')     p.setLanguage(Cpp);
  else if (language === 'java')    p.setLanguage(Java);
  else if (language === 'csharp')  p.setLanguage(CSharp);
  else if (language === 'php')     p.setLanguage(Php);
  else if (language === 'ruby')    p.setLanguage(Ruby);
  else if (language === 'shell')   p.setLanguage(Bash);
  else if (language === 'swift')   p.setLanguage(Swift);
  else if (language === 'kotlin')  p.setLanguage(Kotlin);
  else return null;
  _parsers.set(language, p);
  return p;
}

// Per-language comment markers for comment_out/uncomment operations.
function commentMarker(language) {
  if (language === 'python') return '#';
  if (language === 'javascript' || language === 'typescript') return '//';
  if (language === 'css') return null; // CSS uses /* */ only, no line comments
  if (language === 'html') return null; // HTML uses <!-- --> only, no line comments
  return null;
}

// =============================================================================
// SEGMENTER
// =============================================================================

let _segId = 0;
function freshId() { return `ins_${String(++_segId).padStart(4, '0')}`; }

function extractName(node) {
  const t = node.type;
  // ── Python / JavaScript / TypeScript ──
  if (t === 'function_definition' || t === 'function_declaration' ||
      t === 'class_definition' || t === 'class_declaration' ||
      t === 'method_definition') {
    const n = node.childForFieldName('name');
    if (n) return n.text;
  }
  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    const decl = node.namedChild(0);
    if (decl) {
      const n = decl.childForFieldName('name');
      if (n) return n.text;
    }
  }
  if (t === 'decorated_definition') {
    for (const c of node.namedChildren) {
      if (c.type === 'function_definition' || c.type === 'class_definition') {
        return extractName(c);
      }
    }
  }
  if (t === 'expression_statement') {
    const expr = node.namedChild(0);
    if (!expr) return '(expr)';
    return extractCallTargetName(expr) || '(expr)';
  }
  if (t === 'import_statement' || t === 'import_from_statement') {
    return '(import)';
  }
  if (t === 'export_statement') {
    const inner = node.namedChild(0);
    if (inner && inner.childForFieldName) {
      const n = inner.childForFieldName('name');
      if (n) return `export ${n.text}`;
      return `export ${inner.type}`;
    }
    return 'export';
  }
  // ── HTML ──
  if (t === 'element' || t === 'self_closing_tag') {
    const startTag = node.children.find(c => c.type === 'start_tag' || c.type === 'self_closing_tag');
    if (startTag) {
      const tagName = startTag.children.find(c => c.type === 'tag_name');
      let name = tagName ? tagName.text : '(element)';
      // Append id and class for identification
      for (const attr of startTag.children) {
        if (attr.type === 'attribute') {
          const attrName = attr.children.find(c => c.type === 'attribute_name');
          const attrVal = attr.children.find(c => c.type === 'quoted_attribute_value' || c.type === 'attribute_value');
          if (attrName && attrVal) {
            const n = attrName.text;
            const v = attrVal.text.replace(/['"]/g, '');
            if (n === 'id') name += '#' + v;
            else if (n === 'class') name += '.' + v.split(/\s+/)[0];
          }
        }
      }
      return name;
    }
  }
  if (t === 'doctype') return '<!DOCTYPE>';
  if (t === 'comment') return '(comment)';
  if (t === 'text') {
    const txt = node.text.trim();
    if (!txt) return '(blank)';
    return txt.length > 40 ? txt.slice(0, 37) + '...' : txt;
  }
  // ── CSS ──
  if (t === 'rule_set') {
    const sel = node.children.find(c => c.type === 'selectors');
    return sel ? sel.text : '(rule)';
  }
  if (t === 'media_statement') {
    // @media (max-width: 768px) { ... }
    const txt = node.text;
    const match = txt.match(/@media\s*([^{]+)/);
    return match ? '@media ' + match[1].trim() : '@media';
  }
  if (t === 'import_statement') return '@import';
  if (t === 'charset_statement') return '@charset';
  if (t === 'keyframes_statement') {
    const nameNode = node.children.find(c => c.type === 'keyframes_name');
    return nameNode ? '@keyframes ' + nameNode.text : '@keyframes';
  }
  if (t === 'at_rule') {
    const txt = node.text.slice(0, 60);
    return txt.includes('{') ? txt.slice(0, txt.indexOf('{')).trim() : txt;
  }
  return `(${t})`;
}

function extractCallTargetName(expr) {
  if (expr.type === 'assignment_expression' || expr.type === 'assignment') {
    const left = expr.childForFieldName('left');
    if (left) return left.text.slice(0, 60);
  }
  if (expr.type === 'call_expression' || expr.type === 'call') {
    const fn = expr.childForFieldName('function') || expr.childForFieldName('callee');
    if (fn) return fn.text.slice(0, 60);
  }
  if (expr.type === 'member_expression' || expr.type === 'attribute') {
    return expr.text.slice(0, 60);
  }
  if (expr.type === 'identifier') return expr.text;
  return null;
}

// =============================================================================
// BUFFER STORE
// =============================================================================

class Buffer {
  constructor(filePath, language, segments, originalContent, readonly = false) {
    this.path = filePath;
    this.language = language;
    this.readonly = readonly;  // v4: read buffer is unwritable; edit buffer is writable
    this.segments = segments;
    this.segmentText = new Map();
    this.originalText = new Map();
    // For parent segments (section_group, class_declaration, etc. that have
    // children), segmentText holds the PREFIX text (from segment start up to
    // first child start) and parentSuffix holds the SUFFIX (from last child
    // end to segment end). Leaf segments have full text in segmentText and
    // are absent from parentSuffix. This split is what makes child edits
    // visible in assembleText output: the parent's slice no longer masks
    // edits made to children's segmentText entries.
    this.parentSuffix = new Map();
    this.originalParentSuffix = new Map();
    this.openedAt = new Date();
    this.verifyToken = null;
    this.editStack = [];
    // READ-BEFORE-WRITE: seg ids whose code has been displayed in THIS buffer
    // state. Destructive ops require their target to be in this set; any
    // buffer change wipes it (see invalidateVerify). You cannot modify code
    // you have not looked at.
    this.readSegs = new Set();

    const recordSeg = (seg) => {
      if (seg.children && seg.children.length > 0) {
        const firstChild = seg.children[0];
        const lastChild = seg.children[seg.children.length - 1];
        const prefix = originalContent.slice(seg.startByte, firstChild.startByte);
        const suffix = originalContent.slice(lastChild.endByte, seg.endByte);
        this.originalText.set(seg.id, prefix);
        this.segmentText.set(seg.id, prefix);
        this.originalParentSuffix.set(seg.id, suffix);
        this.parentSuffix.set(seg.id, suffix);
        for (const child of seg.children) recordSeg(child);
      } else {
        const text = originalContent.slice(seg.startByte, seg.endByte);
        this.originalText.set(seg.id, text);
        this.segmentText.set(seg.id, text);
      }
    };
    for (const seg of segments) recordSeg(seg);
    this.originalFullText = originalContent;
  }

  assembleText() {
    // Recursive concatenation. Round-trip identity holds by construction:
    // for any unedited buffer, assembleText() === originalFullText.
    //
    // Parent segments (section_group, class_declaration, etc.) emit their
    // PREFIX text, then recurse into children, then emit their SUFFIX text.
    // Leaf segments emit their full text. This is why edits to children of
    // section_groups now propagate to disk — previously the parent's slice
    // text masked them.
    const parts = [];
    const emit = (seg) => {
      if (seg.children && seg.children.length > 0) {
        parts.push(this.segmentText.get(seg.id));      // prefix
        for (const child of seg.children) emit(child);
        parts.push(this.parentSuffix.get(seg.id) || ''); // suffix
      } else {
        parts.push(this.segmentText.get(seg.id));
      }
    };
    for (const seg of this.segments) emit(seg);
    return parts.join('');
  }

  isDirty() {
    // Differs from original disk if: segment count changed, or any seg's text differs
    // from original, or a non-original segment is present.
    if (this.segments.length !== [...this.originalText.keys()].filter(id =>
      // Only count IDs that came from the original parse, not inserted ones
      this.originalText.get(id) !== ''
    ).length) {
      // size differs from "original count" — but originalText also contains entries
      // for inserted segments (with value ''), so count carefully
    }
    for (const seg of allSegmentsFlat(this.segments)) {
      const orig = this.originalText.get(seg.id);
      if (orig === undefined) return true;        // segment is brand new (inserted)
      if (this.segmentText.get(seg.id) !== orig) return true;
    }
    // Also dirty if a segment that WAS in the original is no longer in segments (deleted).
    const liveIds = new Set(allSegmentsFlat(this.segments).map(s => s.id));
    for (const [id, origText] of this.originalText) {
      if (origText === '') continue;              // skip inserted-then-removed sentinels
      if (!liveIds.has(id)) return true;          // an original segment is missing
    }
    // Also: ordering. If a segment's index has changed from its original position,
    // we treat that as dirty. We approximate by comparing IDs in order vs the order
    // they appeared in originalText (insertion order is preserved by Map in Node).
    const originalIdOrder = [...this.originalText.entries()]
      .filter(([_, t]) => t !== '')
      .map(([id]) => id);
    const liveOrder = allSegmentsFlat(this.segments)
      .filter(s => this.originalText.get(s.id) !== '' && this.originalText.has(s.id))
      .map(s => s.id);
    if (originalIdOrder.join(',') !== liveOrder.join(',')) return true;
    return false;
  }

  findSegment(address) {
    const s = String(address).trim();
    if (s.startsWith('seg_')) {
      for (const seg of allSegmentsFlat(this.segments)) if (seg.id === s) return seg;
      return null;
    }
    const parts = s.split('.').map(p => parseInt(p, 10));
    if (parts.some(isNaN) || parts.some(n => n < 1)) return null;
    let level = this.segments;
    let cur = null;
    for (const idx of parts) {
      if (!level || idx > level.length) return null;
      cur = level[idx - 1];
      level = cur.children || null;
    }
    return cur;
  }

  invalidateVerify(reason) {
    this.verifyToken = null;
    this._lastInvalidationReason = reason;
    // Buffer changed: every previously-displayed segment view is now stale.
    // Wipe the read set — code must be looked at again before it can be touched.
    this.readSegs.clear();
  }

  // Push an inverse-op entry to the in-memory stack AND persist a row to the DB.
  // entry shape:
  //   { kind: 'replace', segId, prevText }
  //   { kind: 'delete',  segId, position, segment, prevText, prevChildren }
  //   { kind: 'insert',  segId }
  //   { kind: 'move',    segId, prevPosition, neighborBeforeId, neighborAfterId }
  pushUndoEntry(entry) {
    const ts = new Date().toISOString();
    const stackEntry = { ts, ...entry };
    this.editStack.push(stackEntry);

    // Persist a row. For 'delete' entries we serialise the segment object plus
    // the prevChildren Map (Maps don't JSON-serialise as-is).
    let payload;
    if (entry.kind === 'replace') {
      payload = { prevText: entry.prevText };
    } else if (entry.kind === 'delete') {
      payload = {
        position: entry.position,
        segment: entry.segment,
        prevText: entry.prevText,
        prevChildren: entry.prevChildren ? Object.fromEntries(entry.prevChildren) : null,
      };
    } else if (entry.kind === 'insert') {
      payload = {};
    } else if (entry.kind === 'move') {
      payload = {
        prevPosition: entry.prevPosition,
        neighborBeforeId: entry.neighborBeforeId,
        neighborAfterId: entry.neighborAfterId,
        prevOrder: entry.prevOrder,
      };
    } else {
      payload = entry;
    }
    const rowId = dbAppendEdit(this.path, entry.kind, entry.segId, payload);
    stackEntry.rowId = rowId;
  }
}

// Move `seg` to insertion index `destIdx` (as computed by opMove against the
// CURRENT array) while keeping whitespace gaps fixed in place: only the code
// elements are reordered between the existing gap slots. Segments don't carry
// their trailing newline (it lives in the following gap), so a plain splice
// glued the moved element onto its new neighbour ("return 3def first():").
function reorderBetweenGaps(list, seg, destIdx) {
  const isGap = (s) => s.kind === 'whitespace' || s.kind === 'gap';
  const elems = list.filter(s => !isGap(s));
  const fromE = elems.indexOf(seg);
  let destE = list.slice(0, destIdx).filter(s => !isGap(s)).length;
  elems.splice(fromE, 1);
  if (destE > fromE) destE -= 1;
  elems.splice(destE, 0, seg);
  let k = 0;
  return list.map(s => (isGap(s) ? s : elems[k++]));
}

// Restore an array's order from a list of ids. Returns false if the set of
// ids no longer matches, so the caller falls back to position-based restore.
function restoreOrder(list, ids) {
  if (ids.length !== list.length) return false;
  const byId = new Map(list.map(s => [s.id, s]));
  if (!ids.every(id => byId.has(id))) return false;
  list.splice(0, list.length, ...ids.map(id => byId.get(id)));
  return true;
}

function allSegmentsFlat(segs) {
  // Recursively flatten the segment tree. Walks through arbitrary nesting
  // depth — section_group > class_declaration > method_definition > ... etc.
  // Pre-order traversal so parents appear before their children, matching
  // the original disk-order of the source.
  const out = [];
  const recurse = (list) => {
    for (const s of list) {
      out.push(s);
      if (s.children && s.children.length > 0) recurse(s.children);
    }
  };
  recurse(segs);
  return out;
}

// Find the parent segment that contains a given child segment.
// Returns { parent, childIndex } or null if seg is top-level or not found.
function findParentOf(segments, targetSeg) {
  function search(list) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.children) {
        for (let j = 0; j < s.children.length; j++) {
          if (s.children[j] === targetSeg || s.children[j].id === targetSeg.id) {
            return { parent: s, childIndex: j };
          }
        }
        // Recurse into children's children
        const deeper = search(s.children);
        if (deeper) return deeper;
      }
    }
    return null;
  }
  return search(segments);
}


// v4 GLOBAL TWO-BUFFER MODEL.
// Exactly two slots, ever. No Map of per-path buffers (that was how stale
// content accumulated). _pair().read = opt-in, always-fresh, readonly reference /
// clipboard. _pair().edit = the single writable working buffer; to edit another
// target it must commit/discard first.
// One read/edit buffer pair per sandbox slot (keyed by the request context's
// slot dir); outside the sandbox there is a single pair, exactly as before.
const _bufferPairs = new Map();
function _pair() {
  const key = globalThis.__sandboxCtx?.getStore?.()?.slotDir || '';
  let p = _bufferPairs.get(key);
  if (!p) { p = { read: null, edit: null }; _bufferPairs.set(key, p); }
  return p;
}

async function loadFresh(filePath, readonly) {
  let lang = detectLanguage(filePath);
  let content = null;
  if (!lang) {
    // Config files often have no extension, or one not in the table:
    // sites-enabled/x, sshd_config, fstab, sudoers, Dockerfile, *.service ...
    // Accept them when the config segmenter recognises the file.
    content = await fs.readFile(filePath, 'utf8');
    if (detectConfigFlavor(filePath, content, 'plaintext')) lang = 'plaintext';
  }
  if (!lang) {
    throw new Error(`Unsupported file type: ${path.extname(filePath)}. Supported: ${Object.keys(EXT_TO_LANGUAGE).join(', ')}, plus recognised config files (nginx, systemd units, sshd_config, fstab, sudoers, Dockerfile, ...)`);
  }
  dbWipePath(filePath);
  if (content === null) content = await fs.readFile(filePath, 'utf8');
  const { segments, hasParseErrors } = await workerSegmentFile(filePath, content, lang, aiTitleSegments);
  const buf = new Buffer(filePath, lang, segments, content, readonly);
  buf.hasParseErrors = hasParseErrors;
  return buf;
}

// READ buffer: opt-in, always disk-fresh, readonly. Each read replaces the
// prior read view — there is never a second read buffer to go stale.
async function getReadBuffer(filePath) {
  _pair().read = await loadFresh(filePath, true);
  return _pair().read;
}

// EDIT buffer: the single writable working buffer. Disk-truth on open. If an
// edit is in flight on a DIFFERENT file, block until it commits/discards. Same
// file already open for edit -> return it (keep in-flight edits).
async function getEditBuffer(filePath) {
  if (_pair().edit && _pair().edit.path === filePath) return _pair().edit;
  if (_pair().edit && _pair().edit.isDirty()) {
    throw new Error(
      `Single-active-edit: '${_pair().edit.path}' has uncommitted edits. Commit or discard it before editing '${filePath}'. ` +
      `(verify>=2 + commit to save, or discard:true to abandon.)`
    );
  }
  // previous edit buffer (if any) was clean — drop it
  if (_pair().edit) { dbWipePath(_pair().edit.path); }
  _pair().edit = await loadFresh(filePath, false);
  return _pair().edit;
}

// Compat shim: code paths that used to look up "the buffer for this path" now
// resolve against the two slots. Returns the edit buffer if it matches, else
// the read buffer if it matches, else null.
function bufferForPath(filePath) {
  if (_pair().edit && _pair().edit.path === filePath) return _pair().edit;
  if (_pair().read && _pair().read.path === filePath) return _pair().read;
  return null;
}
function clearEditBuffer() {
  if (_pair().edit) { dbWipePath(_pair().edit.path); _pair().edit = null; }
}

// =============================================================================
// VERIFY ENGINE
// =============================================================================

async function writeBufferToTemp(filePath, content) {
  const ext = path.extname(filePath);
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 8);
  const tmpPath = path.join(os.tmpdir(), `read_file_v3_${hash}${ext}`);
  await fs.writeFile(tmpPath, content, 'utf8');
  return tmpPath;
}

// ── C / C++ syntax check in project context ───────────────────────────────
// Checking the edited text alone (g++ -fsyntax-only /tmp/copy) fails on almost
// every real project file: the copy sits in a temp folder, so #include "x.h"
// can't be found, and the project's include paths and defines are missing.
//   1. Reuse the file's real flags from compile_commands.json when the project
//      has one (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON). Headers borrow a
//      sibling source file's flags.
//   2. Otherwise use the file's own folder plus the project's include/ folders.
//   3. A header that still can't be found means "not fully checked", unless the
//      #include for it is new in this edit; then it's a real error.
// In the public sandbox the compiler runs inside bubblewrap and can only see
// the user's slot, system/ROCm headers and the temp copy: compiler errors quote
// lines from included files, so host files must not be reachable at all.

function _cfSandboxSlot() {
  return globalThis.__sandboxCtx?.getStore?.()?.slotDir || null;
}

function _cfMayClimb(d) {
  const slot = _cfSandboxSlot();
  return !slot || (d !== slot && d.startsWith(slot + '/'));
}

function _cfProjectRoot(fileDir) {
  let d = fileDir;
  for (let i = 0; i < 16; i++) {
    if (_fsCF.existsSync(_pathCF.join(d, '.git'))) return d;
    const up = _pathCF.dirname(d);
    if (up === d || !_cfMayClimb(d)) break;
    d = up;
  }
  return fileDir;
}

function _cfFindCompileCommands(fileDir) {
  let d = fileDir;
  for (let i = 0; i < 16; i++) {
    for (const c of [d, _pathCF.join(d, 'build'), _pathCF.join(d, 'build-release'), _pathCF.join(d, 'out')]) {
      const f = _pathCF.join(c, 'compile_commands.json');
      if (_fsCF.existsSync(f)) return f;
    }
    if (_fsCF.existsSync(_pathCF.join(d, '.git'))) break;
    const up = _pathCF.dirname(d);
    if (up === d || !_cfMayClimb(d)) break;
    d = up;
  }
  return null;
}

function _cfSplitCmd(cmd) {
  return (String(cmd).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

function _cfFlagsFromDb(ccPath, filePath) {
  let db;
  try { db = JSON.parse(_fsCF.readFileSync(ccPath, 'utf8')); } catch { return null; }
  if (!Array.isArray(db) || !db.length) return null;
  const abs = (e) => _pathCF.resolve(e.directory || '', e.file || '');
  const entry = db.find((e) => abs(e) === filePath)
    || db.find((e) => _pathCF.dirname(abs(e)) === _pathCF.dirname(filePath))
    || db[0];
  const args = entry.arguments || _cfSplitCmd(entry.command);
  const dir = entry.directory || _pathCF.dirname(filePath);
  const pathFlags = ['-I', '-isystem', '-iquote', '-include'];
  const out = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if ([...pathFlags, '-D', '-U'].includes(a)) {
      const v = args[++i];
      if (v === undefined) break;
      out.push(a, pathFlags.includes(a) && !_pathCF.isAbsolute(v) ? _pathCF.resolve(dir, v) : v);
      continue;
    }
    const m = a.match(/^(-I|-isystem|-iquote)(.+)$/);
    if (m) { out.push(m[1], _pathCF.isAbsolute(m[2]) ? m[2] : _pathCF.resolve(dir, m[2])); continue; }
    if (/^-[DU]./.test(a) || /^-std=/.test(a)) out.push(a);
  }
  return out;
}

function _cfGuessIncludes(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || found.length >= 24) return;
    let ents;
    try { ents = _fsCF.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || ['node_modules', 'build', 'out'].includes(e.name)) continue;
      const p = _pathCF.join(dir, e.name);
      if (e.name === 'include') found.push(p);
      walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

async function checkCFamilyInContext(filePath, tmp, content, language) {
  const fileDir = _pathCF.dirname(filePath);
  const compiler = language === 'c' ? 'gcc' : 'g++';
  let flags, how;
  const cc = _cfFindCompileCommands(fileDir);
  const dbFlags = cc ? _cfFlagsFromDb(cc, filePath) : null;
  if (dbFlags && dbFlags.length) {
    flags = dbFlags; how = 'flags from compile_commands.json';
  } else {
    const root = _cfProjectRoot(fileDir);
    const incs = _cfGuessIncludes(root);
    flags = ['-I', root, ...incs.flatMap((d) => ['-I', d])];
    how = `no compile_commands.json; ${incs.length} include folder(s) found`;
  }
  const ccArgs = ['-fsyntax-only', '-x', language === 'c' ? 'c' : 'c++', '-iquote', fileDir, ...flags, tmp];
  const slot = _cfSandboxSlot();
  const [bin, args] = slot
    ? ['bwrap', ['--unshare-all', '--die-with-parent', '--new-session',
        '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
        '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
        '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache', '--ro-bind-try', '/opt/rocm', '/opt/rocm',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--ro-bind', slot, slot, '--ro-bind', tmp, tmp, compiler, ...ccArgs]]
    : [compiler, ccArgs];
  try {
    await _execFileCF(bin, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, messages: ['L1 tree-sitter: OK', `L1 ${compiler} -fsyntax-only: OK (${how})`] };
  } catch (e) {
    const raw = `${e.stderr || ''}${e.stdout || ''}` || String(e.message || e);
    const text = raw.split(tmp).join(filePath).trim();
    const missing = text.match(/fatal error: ([^:\n]+): No such file or directory/);
    if (missing) {
      const hdr = missing[1].trim();
      let original = '';
      try { original = _fsCF.readFileSync(filePath, 'utf8'); } catch {}
      const incLines = (s) => s.split('\n').filter((l) => /^\s*#\s*include\b/.test(l) && l.includes(hdr));
      const addedByEdit = incLines(content).length > 0 && incLines(original).length === 0;
      if (!addedByEdit) {
        return { ok: true, partial: true, messages: ['L1 tree-sitter: OK',
          `L1 ${compiler}: not fully checked, header "${hdr}" not found (${how}). For a full check, generate compile_commands.json (CMake: -DCMAKE_EXPORT_COMPILE_COMMANDS=ON).`] };
      }
    }
    return { ok: false, messages: ['L1 tree-sitter: OK', `L1 ${compiler}: ${text.slice(0, 800)}`] };
  }
}

async function verifyL1(filePath, content, language) {
  // Config files: real syntax / structure checks (JSON, YAML, TOML parsers;
  // brace, tag and INI structure) instead of "plain text, no check".
  const cfgFlavor = detectConfigFlavor(filePath, content, language);
  if (cfgFlavor) return { level: 1, ...(await checkConfigSyntax(content, cfgFlavor, filePath)) };
  const PLAINTEXT_LANGS = ['plaintext', 'markdown', 'json', 'yaml', 'toml', 'ini', 'env'];
  if (PLAINTEXT_LANGS.includes(language)) {
    // No syntax checking for plain text formats
    return { level: 1, ok: true, messages: ['L1: OK (plain text, no syntax check)'] };
  }
  const parser = getParser(language);
  if (parser) {
    const tree = parser.parse(content);
    if (tree.rootNode.hasError) {
      return { level: 1, ok: false, messages: ['L1 tree-sitter: parse errors detected'] };
    }
  }
  const tmp = await writeBufferToTemp(filePath, content);
  try {
    if (language === 'python') {
      try {
        await execAsync(`python3 -m py_compile "${tmp}"`, { timeout: 5000 });
        return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 py_compile: OK'] };
      } catch (e) {
        return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 py_compile: ${(e.stderr || e.message).trim()}`] };
      }
    } else if (language === 'javascript' || language === 'typescript') {
      try {
        await execAsync(`node --check "${tmp}"`, { timeout: 10000 });
        return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 node --check: OK'] };
      } catch (e) {
        const out = (e.stderr || e.stdout || e.message).toString().trim();
        return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 node --check: ${out.slice(0, 500)}`] };
      }
    } else if (language === 'html') {
      try {
        await execAsync(`npx htmlhint --format compact "${tmp}" 2>&1`, { timeout: 10000 });
        return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 htmlhint: OK'] };
      } catch (e) {
        const out = (e.stderr || e.stdout || e.message).toString().trim();
        const errorLines = out.split('\n').filter(l => l.includes('error'));
        if (errorLines.length === 0) {
          return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 htmlhint: OK (warnings only)'] };
        }
        return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 htmlhint: ${out.slice(0, 500)}`] };
      }
    } else if (language === 'css') {
      try {
        await execAsync(`npx stylelint --no-color --config ${_READ_FILE_DIR}/.stylelintrc.json "${tmp}" 2>&1`, { timeout: 10000 });
        return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 stylelint: OK'] };
      } catch (e) {
        const out = (e.stderr || e.stdout || e.message).toString().trim();
        return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 stylelint: ${out.slice(0, 500)}`] };
      }
    } else if (language === 'go') {
      try {
        // gofmt reads stdin, writes errors to stderr, always exits 0
        // Capture stderr to detect parse errors
        const { stderr } = await execAsync(`gofmt < "${tmp}"`, { timeout: 10000 });
        const errors = (stderr || '').trim();
        if (errors) {
          return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 gofmt: ${errors.slice(0, 500)}`] };
        }
        return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 gofmt: OK'] };
      } catch (e) {
        const out = (e.stderr || e.message).toString().trim();
        return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 gofmt: ${out.slice(0, 500)}`] };
      }
    } else if (language === 'c' || language === 'cpp') {
      // Checked in the context of its project (include paths, defines), not alone.
      return { level: 1, ...(await checkCFamilyInContext(filePath, tmp, content, language)) };
    } else if (language === 'php') {
      try {
        await execAsync(`php -l "${tmp}" 2>&1`, { timeout: 10000 });
        return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 php -l: OK'] };
      } catch (e) {
        const out = (e.stderr || e.stdout || e.message).toString().trim();
        return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 php -l: ${out.slice(0, 500)}`] };
      }
    } else if (language === 'shell') {
      try {
        await execAsync(`bash -n "${tmp}" 2>&1`, { timeout: 5000 });
        return { level: 1, ok: true, messages: ['L1 tree-sitter: OK', 'L1 bash -n: OK'] };
      } catch (e) {
        const out = (e.stderr || e.stdout || e.message).toString().trim();
        return { level: 1, ok: false, messages: ['L1 tree-sitter: OK', `L1 bash -n: ${out.slice(0, 500)}`] };
      }
    }
    return { level: 1, ok: true, messages: [`L1 tree-sitter: OK (no native check for ${language})`] };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function verifyL2(filePath, content, language) {
  const l1 = await verifyL1(filePath, content, language);
  if (!l1.ok) return { ...l1, level: 2 };
  // Config files: run the service's own checker (nginx -t, sshd -t, visudo -c,
  // systemd-analyze verify, ...) on the edited text. A failure blocks the commit.
  const cfgFlavorL2 = detectConfigFlavor(filePath, content, language);
  if (cfgFlavorL2) {
    const v = await validateConfigWithTool(filePath, content, cfgFlavorL2);
    return { level: 2, ok: v.ok, messages: [...l1.messages, ...v.messages] };
  }
  const tmp = await writeBufferToTemp(filePath, content);
  try {
    if (language === 'python') {
      try {
        const r = await execAsync(`python3 -m pyflakes "${tmp}" 2>&1 || true`, { timeout: 10000 });
        const out = (r.stdout || '').trim();
        const messages = [...l1.messages];
        if (out) messages.push(`L2 pyflakes:\n${out}`);
        else messages.push('L2 pyflakes: OK');
        return { level: 2, ok: true, messages };
      } catch (e) {
        return { level: 2, ok: l1.ok, messages: [...l1.messages, `L2 pyflakes error: ${e.message}`] };
      }
    }
    if (language === 'html') {
      try {
        const r = await execAsync(`npx htmlhint --format json "${tmp}" 2>&1 || true`, { timeout: 10000 });
        const out = (r.stdout || '').trim();
        const messages = [...l1.messages];
        try {
          const results = JSON.parse(out);
          const errors = results.filter(r => r.messages && r.messages.length > 0);
          if (errors.length === 0) {
            messages.push('L2 htmlhint: OK');
          } else {
            const issues = errors.flatMap(r => r.messages);
            const errorCount = issues.filter(m => m.type === 'error').length;
            const warnCount = issues.filter(m => m.type === 'warning').length;
            const summary = issues.slice(0, 5).map(m => `  L${m.line}:${m.col} ${m.type}: ${m.message} (${m.rule.id})`).join('\n');
            messages.push(`L2 htmlhint: ${errorCount} errors, ${warnCount} warnings\n${summary}`);
          }
        } catch {
          if (out) messages.push(`L2 htmlhint: ${out.slice(0, 300)}`);
          else messages.push('L2 htmlhint: OK');
        }
        return { level: 2, ok: true, messages };
      } catch (e) {
        return { level: 2, ok: l1.ok, messages: [...l1.messages, `L2 htmlhint error: ${e.message}`] };
      }
    }
    if (language === 'css') {
      try {
        const r = await execAsync(`npx stylelint --no-color --config ${_READ_FILE_DIR}/.stylelintrc.json --formatter json "${tmp}" 2>&1 || true`, { timeout: 10000 });
        const out = (r.stdout || '').trim();
        const messages = [...l1.messages];
        try {
          const results = JSON.parse(out);
          const warnings = results.flatMap(r => r.warnings || []);
          if (warnings.length === 0) {
            messages.push('L2 stylelint: OK');
          } else {
            const errorCount = warnings.filter(w => w.severity === 'error').length;
            const warnCount = warnings.filter(w => w.severity === 'warning').length;
            const summary = warnings.slice(0, 5).map(w => `  L${w.line}:${w.column} ${w.severity}: ${w.text}`).join('\n');
            messages.push(`L2 stylelint: ${errorCount} errors, ${warnCount} warnings\n${summary}`);
          }
        } catch {
          if (out) messages.push(`L2 stylelint: ${out.slice(0, 300)}`);
          else messages.push('L2 stylelint: OK');
        }
        return { level: 2, ok: true, messages };
      } catch (e) {
        return { level: 2, ok: l1.ok, messages: [...l1.messages, `L2 stylelint error: ${e.message}`] };
      }
    }
    return { level: 2, ok: true, messages: [...l1.messages, `L2 (no linter configured for ${language})`] };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function verifyL3(filePath, content, language) {
  const l2 = await verifyL2(filePath, content, language);
  if (!l2.ok) {
    return { ...l2, level: 3 };
  }

  // L3 = L1 + L2 + import resolution check via architect.
  // Confirms every local import resolves to a known project file.
  // External imports (npm/pip/stdlib) are ignored — we can't verify those
  // without installing/checking the package.
  //
  // L3 does NOT gate the commit-to-disk path — the file can still be
  // committed at L1 or L2. L3 specifically gates whether the file gets
  // marked 'verified' in architect. A file with broken imports lands
  // on disk (because the developer is mid-edit) but stays 'unverified'
  // until the imports are fixed and L3 passes.
  let importCheck;
  try {
    importCheck = checkImportResolution(filePath);
  } catch (err) {
    return {
      level: 3,
      ok: false,
      messages: [...l2.messages, `L3 import resolution: error running check (${err.message})`],
    };
  }

  if (importCheck.note && importCheck.checked === 0) {
    // File not in any project, or architect DB unavailable.
    // Pass through with a note — there's nothing to check.
    return {
      level: 3,
      ok: l2.ok,
      messages: [...l2.messages, `L3 import resolution: ${importCheck.note}`],
    };
  }

  if (!importCheck.ok) {
    const unresolvedList = importCheck.unresolved
      .map(u => `'${u.import_path}'${u.line ? ` (line ${u.line})` : ''}`)
      .join(', ');
    return {
      level: 3,
      ok: false,
      messages: [
        ...l2.messages,
        `L3 import resolution: ${importCheck.unresolved.length} unresolved local import(s): ${unresolvedList}`,
        'Note: file CAN still be committed at L1 or L2; only the verified status is blocked at L3.',
      ],
    };
  }

  // Local imports resolved. Now check SQL queries against their live schemas.
  // Schema-only check via SQLite prepare() — does not read or modify data.
  const importMessages = [
    ...l2.messages,
    `L3 import resolution: all ${importCheck.checked} local import(s) resolve correctly (${importCheck.external_imports} external skipped)`,
  ];

  // ─── L3 SQL check (schema-only, never reads data) ────────────────────
  // Validates SQL queries against live DB schemas via prepare(). Schema
  // mismatches, missing tables/columns, syntax errors all surface here.
  // L3 adapter dispatch: ask all relevant adapters to verify their bits
  // (SQL queries, LMDB sub-DB refs, Postgres queries, etc.). Each adapter
  // is a self-contained module under lib/adapters/<type>/. The dispatcher
  // discovers them by convention and lazy-loads only what's needed.
  let adapterResults;
  try {
    const archDb = _openArchitectDbReadOnly();
    try {
      adapterResults = await runAdapters(filePath, archDb);
    } finally {
      try { archDb.close(); } catch {}
    }
  } catch (err) {
    return {
      level: 3,
      ok: false,
      messages: [...importMessages, `L3 adapter dispatch: error running adapters (${err.message})`],
    };
  }

  // No DB references found — file passes L3 cleanly
  const messages = [...importMessages];
  if (adapterResults.by_adapter.size === 0) {
    messages.push(`L3 DB check: ${adapterResults.summary}`);
    return { level: 3, ok: true, messages };
  }

  // Each adapter's result is the standard { ok, checked, failures,
  // diagnostics, note? } shape. Format uniformly.
  let allOk = true;
  for (const [adapterType, result] of adapterResults.by_adapter) {
    const tag = `L3 ${adapterType.toUpperCase()} check`;

    if (result.note && result.checked === 0) {
      messages.push(`${tag}: ${result.note}`);
      continue;
    }
    if (result.checked === 0) {
      messages.push(`${tag}: ${result.note || 'nothing to verify'}`);
      continue;
    }
    if (!result.ok) {
      allOk = false;
      messages.push(`${tag}: ${result.failures.length} of ${result.checked} failed verification:`);
      for (const f of result.failures) {
        const dbInfo = f.db ? ` [${f.db}]` : (f.env ? ` [${f.env}]` : '');
        const lineInfo = f.line ? `line ${f.line}` : 'unlocated';
        const methodInfo = f.method ? ` (${f.method})` : '';
        messages.push(`  ${lineInfo}${methodInfo}${dbInfo}: ${f.error}`);
        if (f.sql_preview) messages.push(`    SQL: ${f.sql_preview}`);
        if (f.name) messages.push(`    sub-DB name: '${f.name}'`);
      }
      continue;
    }

    // Adapter passed — surface diagnostics in a uniform way
    messages.push(`${tag}: all ${result.checked} valid against live schema`);
    if (result.diagnostics) {
      for (const diag of result.diagnostics) {
        // Each adapter's diagnostics shape varies slightly; surface what's there.
        const target = diag.db || diag.env || '(no target name)';
        const targetPath = diag.path || diag.uri || '';
        const tableCount = diag.tables_in_db?.length;
        const subDbList = diag.sub_dbs_in_env;
        let header = `  ${target}`;
        if (targetPath) header += ` (${targetPath})`;
        if (tableCount !== undefined) header += ` — ${tableCount} tables`;
        if (subDbList) header += ` — sub-DBs: ${subDbList.length > 0 ? subDbList.join(', ') : '(none — single-namespace env)'}`;
        messages.push(header);
        const items = diag.queries || diag.refs || [];
        for (const item of items) {
          const lineInfo = item.line ? `line ${item.line}` : '';
          const methodInfo = item.method ? ` (${item.method})` : '';
          if (item.tables_touched && item.tables_touched.length > 0) {
            const rowsNote = item.estimated_rows > 0 ? ` ~${item.estimated_rows.toLocaleString()} est. rows` : '';
            messages.push(`    ${lineInfo}${methodInfo}: tables=[${item.tables_touched.join(', ')}]${rowsNote}`);
          } else if (item.name) {
            messages.push(`    ${lineInfo}: '${item.name}' ✓`);
          } else {
            messages.push(`    ${lineInfo}${methodInfo}: ✓`);
          }
        }
      }
    }
  }

  if (!allOk) {
    messages.push('Note: file CAN still be committed at L1 or L2; only the verified status is blocked at L3.');
  }
  return { level: 3, ok: allOk, messages };
}

function bufferStateHash(buffer) {
  const h = crypto.createHash('sha256');
  h.update(buffer.assembleText());
  for (const seg of allSegmentsFlat(buffer.segments)) h.update(seg.id);
  return h.digest('hex');
}

// =============================================================================
// OPERATIONS
// =============================================================================

function segmentToSummary(seg) {
  const HIDDEN_KINDS = new Set(['whitespace', 'gap']);
  let children;
  if (seg.children) {
    // Keep gap/whitespace children VISIBLE as minimal "<gap>" markers (showing
    // position + line range) so the structure between elements is explicit and
    // you don't have to infer it from skipped numbers. Gaps remain
    // non-addressable for editing/moving (enforced in the mutating ops).
    children = seg.children.map((c, i) => {
      if (HIDDEN_KINDS.has(c.kind)) {
        return { n: i + 1, kind: c.kind, name: '<gap>', lines: `${c.startLine}-${c.endLine}`, editable: false };
      }
      return { n: i + 1, ...segmentToSummary(c) };
    });
  }
  return {
    id: seg.id, kind: seg.kind, name: seg.name,
    lines: `${seg.startLine}-${seg.endLine}`,
    bytes: seg.endByte - seg.startByte,
    children,
  };
}

async function opSkeleton(buffer, { noLog = false, search = null, fullSkeleton = false } = {}) {
  const total = buffer.assembleText();
  const HIDDEN_KINDS = new Set(['whitespace', 'gap']);
  // Build the full segment list with TRUE position numbers, then filter.
  // Skipped numbers in the displayed list signal hidden whitespace/gap content.
  // Use segment="N" to read whatever is at any number (including hidden ones).
  const visibleSegments = buffer.segments
    .map((s, i) => ({ n: i + 1, ...segmentToSummary(s) }))
    .filter(s => !HIDDEN_KINDS.has(s.kind));

  // EXPLOSION RADIUS: a huge file's full skeleton can flood context. Estimate
  // the token cost of the full segment list; if it's over threshold and the
  // caller hasn't forced a full skeleton, either run a keyword search over the
  // segment names (returning only matching containers of 10) or return a prompt
  // asking for one. Keyword match is instant and zero-GPU — the segment names
  // already exist from the parse.
  const _projTokens = Math.ceil(JSON.stringify(visibleSegments).length / 4);
  if (!fullSkeleton && _projTokens > SKELETON_TOKEN_THRESHOLD) {
    if (search) {
      const q = String(search).toLowerCase();
      // Walk the WHOLE tree tracking the STABLE dotted address (1-based index
      // path through segments->children, counting ALL segments incl. whitespace
      // because findSegment indexes the raw arrays). seg_ ids regenerate every
      // parse so they can't be returned as handles; dotted addresses are
      // positional and stable. Skip whitespace/gap from the RESULTS (not from
      // the index counting).
      const hits = [];
      let visPos = 0;  // pre-order position among visible segments (for grouping)
      const walk = (list, prefix) => {
        list.forEach((seg, i) => {
          const addr = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
          const isHidden = HIDDEN_KINDS.has(seg.kind);
          if (!isHidden) {
            const nm = seg.name ? String(seg.name).toLowerCase() : '';
            const kd = seg.kind ? String(seg.kind).toLowerCase() : '';
            if (nm.includes(q) || kd.includes(q)) {
              hits.push({
                pos: visPos,
                address: addr,
                name: seg.name,
                kind: seg.kind,
                lines: (seg.startLine != null && seg.endLine != null) ? `${seg.startLine}-${seg.endLine}` : undefined,
              });
            }
            visPos++;
          }
          if (seg.children && seg.children.length > 0) walk(seg.children, addr);
        });
      };
      walk(buffer.segments, '');
      // group hits into containers of 10 by visible pre-order position // 10
      const containers = {};
      for (const h of hits) {
        const c = Math.floor(h.pos / 10);
        (containers[c] = containers[c] || []).push({ address: h.address, name: h.name, kind: h.kind, lines: h.lines });
      }
      const grouped = Object.keys(containers).sort((a, b) => a - b).map(c => ({
        container: Number(c),
        matches: containers[c],
      }));
      const out = {
        path: buffer.path,
        language: buffer.language,
        search,
        too_large: true,
        skeleton_tokens: _projTokens,
        total_segments: buffer.segments.length,
        match_count: hits.length,
        containers: grouped,
        hint: hits.length
          ? 'Matching segments grouped in 10s. Read one with segment="<address>" (the dotted address shown), or pass full_skeleton:true for the entire map.'
          : 'No segment names matched. Try another term, or pass full_skeleton:true to load the full skeleton.',
      };
      if (!noLog) { try { const _r=Math.ceil(total.length/4), _a=Math.ceil(JSON.stringify(out).length/4); logCost("read_file", _r, _a); } catch{} }
      return out;
    }
    // no search provided -> prompt
    const prompt = {
      path: buffer.path,
      language: buffer.language,
      too_large: true,
      skeleton_tokens: _projTokens,
      total_segments: buffer.segments.length,
      message: `This file's skeleton is ~${_projTokens} tokens (${buffer.segments.length} segments). Provide a search string to navigate to the relevant segments (keyword over segment names), or pass full_skeleton:true to load the entire skeleton.`,
    };
    if (!noLog) { try { const _r=Math.ceil(total.length/4), _a=Math.ceil(JSON.stringify(prompt).length/4); logCost("read_file", _r, _a); } catch{} }
    return prompt;
  }
  const result = {
    path: buffer.path,
    language: buffer.language,
    bytes: total.length,
    lines: total.split('\n').length,
    // Truth hygiene: parse status is the architect's verdict, valid only for the
    // state it last checked. With pending edits the buffer is unverified — report
    // null ("unknown until verify"), never a stale claim from the pre-edit state.
    parse_errors: buffer.editStack.length > 0 ? null : buffer.hasParseErrors,
    dirty: buffer.isDirty(),
    edits_pending: buffer.editStack.length,
    total_segments: buffer.segments.length,
    hidden_segments: buffer.segments.length - visibleSegments.length,
    verify_token: buffer.verifyToken
      ? { level: buffer.verifyToken.level, at: buffer.verifyToken.timestamp }
      : null,
    segments: visibleSegments,
  };
    if (result.lines <= SMALL_FILE_THRESHOLD) result.full_content = total;

  // H5 — read-from-store validation (non-breaking probe). The buffer was just
  // parsed live; compare the freshly-built skeleton against the one stored at
  // last commit. When the stored content hash matches the current assembled
  // text (fresh), the stored skeleton should be identical to what we just
  // built — proving read-from-store can be trusted by the capstone. We only
  // attach a small `store_check` marker; we do NOT yet serve from the store.
  // Best-effort: never let this break a read.
  try {
    const _curHash = crypto.createHash('sha256').update(total, 'utf8').digest('hex');
    const _stored = getStoredSkeleton(buffer.path, _curHash);
    if (_stored && _stored.found) {
      if (_stored.fresh && Array.isArray(_stored.segments)) {
        // Filter stored the same way opSkeleton filters its visible list, then
        // compare the (n, id, kind, name, lines) tuples in order.
        const _storedVisible = _stored.segments.filter(s => !HIDDEN_KINDS.has(s.kind));
        let _match = _storedVisible.length === visibleSegments.length;
        if (_match) {
          for (let i = 0; i < visibleSegments.length; i++) {
            const a = visibleSegments[i], b = _storedVisible[i];
            if (a.id !== b.id || a.kind !== b.kind || a.name !== b.name || a.lines !== b.lines) {
              _match = false; break;
            }
          }
        }
        result.store_check = {
          fresh: true, version: _stored.version, segments_match: _match,
          stored_segments: _storedVisible.length, live_segments: visibleSegments.length,
        };
      } else {
        result.store_check = { fresh: false, version: _stored.version };
      }
    }
  } catch (sce) {
    console.error(`[read_file] store_check error: ${sce.message}`);
  }

  // Project membership lookup via master-architect.
  // Returns null for files irrelevant to any project; otherwise attaches
  // a `project` field describing membership status (loaded_now / already_loaded /
  // in_tree_not_indexed / unassigned) plus a hint for the LLM.
  try {
    // Drift check: if disk mtime is newer than what architect saw last,
    // the file was edited out-of-band. Auto-flag it unverified.
    const drift = checkAndHandleDrift(buffer.path);
    const projectInfo = getProjectInfoForFile(buffer.path);
    if (projectInfo) {
      if (drift.drifted && drift.was_verified) {
        projectInfo.drift_detected = true;
        projectInfo.drift_hint = 'File mtime is newer than architect record; status auto-reset to unverified. Re-verify if needed.';
      }
      // PATH 3 (H7/H8/H9): if this file is not yet placed in a project, file
      // it by its known links (auto-absorb unknown clusters into a real
      // project when a link resolves). Never prompts. Best-effort: a
      // placement failure must never break the read.
      if (projectInfo.status === 'in_tree_not_indexed' || projectInfo.status === 'unassigned') {
        try {
          const disc = discoverAndFileByLinks(buffer.path);
          if (disc && disc.acted) projectInfo.link_placement = disc;
        } catch (de) {
          console.error(`[read_file] link-discovery error: ${de.message}`);
        }
      }
      result.project = projectInfo;
    }
  } catch (err) {
    console.error(`[read_file] architect-link error: ${err.message}`);
  }

  if (!noLog) { try { const _r=Math.ceil(total.length/4), _a=Math.ceil(JSON.stringify(result).length/4); logCost("read_file", _r, _a); } catch{} }
  return result;
}

function opReadSegment(buffer, address) {
  const seg = buffer.findSegment(address);
  if (!seg) return { error: `No segment at address "${address}"` };

  // Assemble the FULL text of a segment subtree: prefix + children (recursive) + suffix.
  // Mirrors Buffer.assembleText's emit() but rooted at one segment, so reading a
  // container returns its complete editable code, not just the stored prefix stub.
  const assembleSeg = (s) => {
    if (s.children && s.children.length > 0) {
      let out = buffer.segmentText.get(s.id) || '';
      for (const child of s.children) out += assembleSeg(child);
      out += buffer.parentSuffix.get(s.id) || '';
      return out;
    }
    return buffer.segmentText.get(s.id) || '';
  };

  // Recursive title tree (titles + addresses + line ranges, no bodies) so the
  // caller sees every nested segment under the parent and can drill to any of them.
  const HIDDEN = new Set(['whitespace', 'gap']);
  const buildTree = (s, addr) => {
    const kids = (s.children || [])
      .map((c, i) => ({ c, n: i + 1 }))
      .filter(({ c }) => !HIDDEN.has(c.kind))
      .map(({ c, n }) => {
        const childAddr = `${addr}.${n}`;
        const node = { address: childAddr, id: c.id, kind: c.kind, name: c.name, lines: `${c.startLine}-${c.endLine}` };
        if (c.children && c.children.length > 0) node.children = buildTree(c, childAddr);
        return node;
      });
    return kids;
  };

  const _txt = assembleSeg(seg);
  try { const _r=Math.ceil((buffer.source||'').length/4), _a=Math.ceil((_txt||'').length/4); logCost("read_file", _r, _a); } catch{}

  const result = {
    id: seg.id, address, kind: seg.kind, name: seg.name,
    lines: `${seg.startLine}-${seg.endLine}`,
    text: _txt,
  };
  if (seg.children && seg.children.length > 0) {
    result.container = true;
    result.tree = buildTree(seg, address);
    result.note = `Container segment: 'text' above is the FULL assembled code (prefix + all nested children + suffix) and is editable as a whole. 'tree' lists every nested segment with its address (e.g. "${address}.1") so you can read or edit any child independently. Editing this parent address via replace currently overwrites only the parent's prefix line(s); to change a child's body, edit the child's own address.`;
  }
  return result;
}

function opReplace(buffer, address, content) {
  if (buffer.readonly) throw new Error('read buffer is not editable — edits go to the edit buffer (open the segment for edit first)');
  const seg = buffer.findSegment(address);
  if (!seg) return { error: `No segment at address "${address}"` };
  if (seg.kind === 'whitespace' || seg.kind === 'gap') {
    return { error: `Address "${address}" is a <gap> (structural whitespace separator) and cannot be edited. Gaps are shown for visibility only.` };
  }
  const prev = buffer.segmentText.get(seg.id);
  if (prev === content) return { changed: false, message: 'segment text unchanged' };
  buffer.segmentText.set(seg.id, content);
  buffer.pushUndoEntry({ kind: 'replace', segId: seg.id, prevText: prev });
  buffer.invalidateVerify('replace');
  return {
    replaced: address, id: seg.id,
    bytes_before: prev.length, bytes_after: content.length,
    dirty: buffer.isDirty(),
  };
}

function opDelete(buffer, addresses) {
  if (buffer.readonly) throw new Error('read buffer is not editable — edits go to the edit buffer (open the segment for edit first)');
  const targets = [];
  for (const a of addresses) {
    const seg = buffer.findSegment(a);
    if (!seg) return { error: `No segment at address "${a}"` };
    if (seg.kind === 'whitespace' || seg.kind === 'gap') {
      return { error: `Address "${a}" is a <gap> (structural whitespace separator) and cannot be deleted. Gaps are shown for visibility only.` };
    }
    targets.push(seg);
  }
  for (const seg of targets) {
    const idx = buffer.segments.indexOf(seg);
    if (idx !== -1) {
      // Top-level segment — delete directly
      const prevChildren = new Map();
      if (seg.children) for (const ch of seg.children) prevChildren.set(ch.id, buffer.segmentText.get(ch.id));
      buffer.pushUndoEntry({
        kind: 'delete',
        segId: seg.id,
        position: idx,
        segment: seg,
        prevText: buffer.segmentText.get(seg.id),
        prevChildren,
      });
      buffer.segments.splice(idx, 1);
      buffer.segmentText.delete(seg.id);
    } else {
      // Nested segment — find parent and remove child from it
      const found = findParentOf(buffer.segments, seg);
      if (!found) return { error: `Segment "${seg.id}" not found in buffer` };
      const { parent, childIndex } = found;

      // Get the child's text
      const childText = buffer.segmentText.get(seg.id) || '';

      // Remove the child's text from the parent's assembled text
      const parentText = buffer.segmentText.get(parent.id) || '';
      // The child text appears within the parent text — find and remove it
      const childStartInParent = parentText.indexOf(childText);
      let newParentText;
      if (childStartInParent !== -1) {
        // Remove the child text and any trailing newline
        const before = parentText.slice(0, childStartInParent);
        let after = parentText.slice(childStartInParent + childText.length);
        // Clean up: remove the extra newline left by deletion
        if (after.startsWith('\\n')) after = after.slice(1);
        newParentText = before + after;
      } else {
        // Fallback: can't find exact text, just remove the child from children array
        newParentText = parentText;
      }

      // Store undo entry for nested delete
      buffer.pushUndoEntry({
        kind: 'nested_delete',
        segId: seg.id,
        parentId: parent.id,
        childIndex,
        segment: seg,
        prevText: childText,
        prevParentText: parentText,
      });

      // Remove child from parent's children array
      parent.children.splice(childIndex, 1);
      // If parent has no more children, remove the children array
      if (parent.children.length === 0) delete parent.children;

      // Update parent text
      buffer.segmentText.set(parent.id, newParentText);
      // Remove child text entry
      buffer.segmentText.delete(seg.id);
      // Also remove any grandchildren text entries
      if (seg.children) {
        for (const ch of seg.children) buffer.segmentText.delete(ch.id);
      }
    }
  }
  buffer.invalidateVerify('delete');
  return {
    deleted: targets.map(t => ({ id: t.id, name: t.name })),
    remaining: buffer.segments.length,
    dirty: buffer.isDirty(),
  };
}
function opInsert(buffer, betweenA, betweenB, content) {
  if (buffer.readonly) throw new Error('read buffer is not editable — edits go to the edit buffer (open the segment for edit first)');
  const A = String(betweenA).trim().toLowerCase();
  const B = String(betweenB).trim().toLowerCase();

  let aIdx, bIdx, parentSeg = null;
  if (A === 'start' || A === '0') {
    aIdx = -1;
  } else {
    const segA = buffer.findSegment(A);
    if (!segA) return { error: `No segment at address "${betweenA}"` };
    aIdx = buffer.segments.indexOf(segA);
    if (aIdx === -1) {
      // Nested — find parent
      const foundA = findParentOf(buffer.segments, segA);
      if (!foundA) return { error: `Segment "${betweenA}" not found in buffer` };
      parentSeg = foundA.parent;
      aIdx = foundA.childIndex;
    }
  }
  if (B === 'end' || B === '-1') {
    bIdx = parentSeg ? parentSeg.children.length : buffer.segments.length;
  } else {
    const segB = buffer.findSegment(B);
    if (!segB) return { error: `No segment at address "${betweenB}"` };
    if (parentSeg) {
      // Both must be in the same parent
      const foundB = findParentOf(buffer.segments, segB);
      if (!foundB || foundB.parent !== parentSeg) {
        return { error: `Segments ${betweenA} and ${betweenB} are not siblings in the same parent.` };
      }
      bIdx = foundB.childIndex;
    } else {
      bIdx = buffer.segments.indexOf(segB);
      if (bIdx === -1) {
        // B is nested too — find parent
        const foundB = findParentOf(buffer.segments, segB);
        if (!foundB) return { error: `Segment "${betweenB}" not found in buffer` };
        parentSeg = foundB.parent;
        // Re-resolve A in the parent's children
        if (A === 'start' || A === '0') {
          aIdx = -1;
        } else {
          const segA2 = buffer.findSegment(A);
          const foundA2 = findParentOf(buffer.segments, segA2);
          if (!foundA2 || foundA2.parent !== parentSeg) {
            return { error: `Segments ${betweenA} and ${betweenB} are not siblings in the same parent.` };
          }
          aIdx = foundA2.childIndex;
        }
        bIdx = foundB.childIndex;
      }
    }
  }
  // Adjacency check — for nested segments, whitespace gaps between children are normal
  if (parentSeg) {
    // Check that all segments between aIdx and bIdx are whitespace/gaps
    let adjacent = true;
    for (let k = aIdx + 1; k < bIdx; k++) {
      const between = parentSeg.children[k];
      if (between && between.kind !== 'whitespace' && between.kind !== 'gap') {
        adjacent = false;
        break;
      }
    }
    if (!adjacent) {
      return { error: `Segments ${betweenA} and ${betweenB} are not adjacent. They must bracket the gap directly.` };
    }
  } else if (bIdx !== aIdx + 1) {
    // Allow whitespace/gap segments in between — they're invisible to the user
    let adjacent = true;
    for (let i = aIdx + 1; i < bIdx; i++) {
      const between = buffer.segments[i];
      if (between && between.kind !== 'whitespace' && between.kind !== 'gap') {
        adjacent = false;
        break;
      }
    }
    if (!adjacent) {
      return { error: `Segments ${betweenA} and ${betweenB} are not adjacent. They must bracket the gap directly.` };
    }
  }

  // Separator normalization (top-level): assembleText() joins segments with '',
  // all separators live in gap segments — and a fresh insert has no gaps around
  // it, so raw content would glue onto the preceding segment. Detach it.
  if (!parentSeg) {
    const sep = buffer.language === 'python' ? '\n\n\n' : '\n\n';
    if (!content.startsWith('\n')) content = sep + content;
    if (!content.endsWith('\n')) content += '\n';
  }
  let name = '(inserted)', kind = 'inserted';
  // Segment naming parse removed: the architect names segments at commit.
  // Single source of truth — read_file forms no structural opinions of its own.
  // Until commit, an inserted segment honestly reports kind='inserted'.

  const newSeg = {
    id: freshId(), kind, name,
    startByte: 0, endByte: content.length, startLine: 0, endLine: 0,
  };

  if (parentSeg) {
    // Nested insert — add child to parent's children array
    const insertAt = aIdx + 1;
    if (!parentSeg.children) parentSeg.children = [];
    parentSeg.children.splice(insertAt, 0, newSeg);
    buffer.segmentText.set(newSeg.id, content);

    // Update parent text — insert content at the right position
    const parentText = buffer.segmentText.get(parentSeg.id) || '';
    // Find insertion point: after child A's text, before child B's text
    let insertionByte;
    if (aIdx >= 0) {
      const childA = parentSeg.children[aIdx];
      const childAText = buffer.segmentText.get(childA.id) || '';
      const childAPos = parentText.indexOf(childAText);
      insertionByte = childAPos + childAText.length;
    } else {
      // Insert at start of parent body
      insertionByte = 0;
    }
    const newParentText = parentText.slice(0, insertionByte) + '\n' + content + parentText.slice(insertionByte);
    buffer.segmentText.set(parentSeg.id, newParentText);

    buffer.originalText.set(newSeg.id, '');
    buffer.pushUndoEntry({ kind: 'nested_insert', segId: newSeg.id, parentId: parentSeg.id, childIndex: insertAt, prevParentText: parentText });
    buffer.invalidateVerify('insert');

    return {
      inserted: { id: newSeg.id, name: newSeg.name, kind: newSeg.kind, position: insertAt + 1, parent: parentSeg.id },
      total_segments: buffer.segments.length,
      dirty: buffer.isDirty(),
    };
  } else {
    // Top-level insert
    const insertAt = aIdx + 1;
    buffer.segments.splice(insertAt, 0, newSeg);
    buffer.segmentText.set(newSeg.id, content);
    buffer.originalText.set(newSeg.id, '');
    buffer.pushUndoEntry({ kind: 'insert', segId: newSeg.id });
    buffer.invalidateVerify('insert');

    return {
      inserted: { id: newSeg.id, name: newSeg.name, kind: newSeg.kind, position: insertAt + 1 },
      total_segments: buffer.segments.length,
      dirty: buffer.isDirty(),
    };
  }
}
// =============================================================================
// opMove — reorder a segment in the file
// =============================================================================
//
// Anchors the move with neighbor seg_ids captured at time of move so undo can
// place the segment back exactly even after subsequent edits to OTHER segments.
//
// args: segId or address, plus exactly one of: after, before
// after: 'start' | seg_id/address — move so seg lands right after this anchor
// before: 'end'   | seg_id/address — move so seg lands right before this anchor

function opMove(buffer, segAddress, anchor) {
  if (buffer.readonly) throw new Error('read buffer is not editable — edits go to the edit buffer (open the segment for edit first)');
  const seg = buffer.findSegment(segAddress);
  if (!seg) return { error: `No segment at address "${segAddress}"` };
  if (seg.kind === 'whitespace' || seg.kind === 'gap') {
    return { error: `Address "${segAddress}" is a <gap> (structural whitespace separator) and cannot be moved. Gaps are shown for visibility only.` };
  }
  const fromIdx = buffer.segments.indexOf(seg);

  if (fromIdx === -1) {
    // Nested segment — move within parent's children
    const found = findParentOf(buffer.segments, seg);
    if (!found) return { error: `Segment "${seg.id}" not found in buffer` };
    const { parent, childIndex: fromChildIdx } = found;

    if (!anchor || (!anchor.after && !anchor.before)) {
      return { error: 'move requires either after:"<address|start>" or before:"<address|end>"' };
    }
    if (anchor.after && anchor.before) {
      return { error: 'move requires exactly one of after / before, not both' };
    }

    // Resolve destination among ALL children (gaps included), since gaps are
    // now visible/addressable siblings. Anchors refer to whatever child address
    // the caller saw in the skeleton/read output.
    let destChildIdx;
    if (anchor.after) {
      const a = String(anchor.after).trim().toLowerCase();
      if (a === 'start' || a === '0') {
        destChildIdx = 0;
      } else {
        const ref = buffer.findSegment(anchor.after);
        if (!ref) return { error: `No segment at address "${anchor.after}"` };
        const refFound = findParentOf(buffer.segments, ref);
        if (!refFound || refFound.parent !== parent) return { error: `Anchor "${anchor.after}" is not a sibling in the same parent` };
        if (ref.id === seg.id) return { error: 'cannot move a segment relative to itself' };
        destChildIdx = refFound.childIndex + 1;
      }
    } else {
      const a = String(anchor.before).trim().toLowerCase();
      if (a === 'end' || a === '-1') {
        destChildIdx = parent.children.length;
      } else {
        const ref = buffer.findSegment(anchor.before);
        if (!ref) return { error: `No segment at address "${anchor.before}"` };
        const refFound = findParentOf(buffer.segments, ref);
        if (!refFound || refFound.parent !== parent) return { error: `Anchor "${anchor.before}" is not a sibling in the same parent` };
        if (ref.id === seg.id) return { error: 'cannot move a segment relative to itself' };
        destChildIdx = refFound.childIndex;
      }
    }

    if (destChildIdx === fromChildIdx || destChildIdx === fromChildIdx + 1) {
      return { changed: false, message: 'segment already at requested position' };
    }

    // Simple array reorder. assembleText() walks parent.children (prefix + each
    // child + suffix), so reordering the array IS the move. Gaps are real,
    // visible, addressable children — the caller decides whether to move a gap
    // along with an element. We do NOT auto-rebuild or synthesize separators
    // here (that corrupted prefix/suffix); whitespace is whatever the visible
    // gap children say it is. Parent prefix/suffix text is never touched.
    const prevChildOrder = parent.children.map(c => c.id);
    parent.children.splice(0, parent.children.length, ...reorderBetweenGaps(parent.children, seg, destChildIdx));
    const adjusted = parent.children.indexOf(seg);

    buffer.pushUndoEntry({
      kind: 'nested_move',
      segId: seg.id,
      parentId: parent.id,
      prevChildIndex: fromChildIdx,
      prevChildOrder,
    });
    buffer.invalidateVerify('move');

    return {
      moved: { id: seg.id, name: seg.name, from_position: fromChildIdx + 1, to_position: adjusted + 1, parent: parent.id },
      total_segments: buffer.segments.length,
      dirty: buffer.isDirty(),
    };
  }

  // Top-level move
  if (!anchor || (!anchor.after && !anchor.before)) {
    return { error: 'move requires either after:"<address|start>" or before:"<address|end>"' };
  }
  if (anchor.after && anchor.before) {
    return { error: 'move requires exactly one of after / before, not both' };
  }

  let destIdx;
  if (anchor.after) {
    const a = String(anchor.after).trim().toLowerCase();
    if (a === 'start' || a === '0') {
      destIdx = 0;
    } else {
      const ref = buffer.findSegment(anchor.after);
      if (!ref) return { error: `No segment at address "${anchor.after}"` };
      const refIdx = buffer.segments.indexOf(ref);
      if (refIdx === -1) return { error: `Anchor "${anchor.after}" is nested; use nested move within the same parent.` };
      if (ref.id === seg.id) return { error: 'cannot move a segment relative to itself' };
      destIdx = refIdx + 1;
    }
  } else {
    const a = String(anchor.before).trim().toLowerCase();
    if (a === 'end' || a === '-1') {
      destIdx = buffer.segments.length;
    } else {
      const ref = buffer.findSegment(anchor.before);
      if (!ref) return { error: `No segment at address "${anchor.before}"` };
      const refIdx = buffer.segments.indexOf(ref);
      if (refIdx === -1) return { error: `Anchor "${anchor.before}" is nested; use nested move within the same parent.` };
      if (ref.id === seg.id) return { error: 'cannot move a segment relative to itself' };
      destIdx = refIdx;
    }
  }

  const oldBeforeId = fromIdx > 0 ? buffer.segments[fromIdx - 1].id : null;
  const oldAfterId  = fromIdx < buffer.segments.length - 1 ? buffer.segments[fromIdx + 1].id : null;

  if (destIdx === fromIdx || destIdx === fromIdx + 1) {
    return { changed: false, message: 'segment already at requested position' };
  }

  const prevOrder = buffer.segments.map(s => s.id);
  buffer.segments.splice(0, buffer.segments.length, ...reorderBetweenGaps(buffer.segments, seg, destIdx));
  const adjustedDest = buffer.segments.indexOf(seg);

  buffer.pushUndoEntry({
    kind: 'move',
    segId: seg.id,
    prevPosition: fromIdx,
    neighborBeforeId: oldBeforeId,
    neighborAfterId:  oldAfterId,
    prevOrder,
  });
  buffer.invalidateVerify('move');

  return {
    moved: { id: seg.id, name: seg.name, from_position: fromIdx + 1, to_position: adjustedDest + 1 },
    total_segments: buffer.segments.length,
    dirty: buffer.isDirty(),
  };
}
// =============================================================================
// opCommentOut / opUncomment — disable a segment for debugging
// =============================================================================
//
// comment_out: prefix every line with the language's line-comment marker
// uncomment: strip a uniform line-comment prefix
// Both routed through opReplace so they get a regular replace undo entry.

function opCommentOut(buffer, address) {
  if (buffer.readonly) throw new Error('read buffer is not editable — edits go to the edit buffer (open the segment for edit first)');
  const seg = buffer.findSegment(address);
  if (!seg) return { error: `No segment at address "${address}"` };
  const marker = commentMarker(buffer.language);
  if (!marker) return { error: `comment_out not supported for language: ${buffer.language}` };
  const cur = buffer.segmentText.get(seg.id);
  const wrapped = cur.split('\n').map(line => {
    if (line.length === 0) return line;
    return `${marker} ${line}`;
  }).join('\n');
  if (cur === wrapped) return { changed: false, message: 'segment already in commented form (or empty)' };
  return opReplace(buffer, address, wrapped);
}

function opUncomment(buffer, address) {
  if (buffer.readonly) throw new Error('read buffer is not editable — edits go to the edit buffer (open the segment for edit first)');
  const seg = buffer.findSegment(address);
  if (!seg) return { error: `No segment at address "${address}"` };
  const marker = commentMarker(buffer.language);
  if (!marker) return { error: `uncomment not supported for language: ${buffer.language}` };
  const cur = buffer.segmentText.get(seg.id);
  const lines = cur.split('\n');
  // Lenient detection: skip blank lines, require all non-blank to start with marker
  // (after optional leading whitespace).
  const markerEsc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
  const re = new RegExp(`^(\\s*)${markerEsc}\\s?`);
  const hasMarker = (l) => l.length === 0 || re.test(l);
  if (!lines.every(hasMarker)) {
    return { error: `Segment is not uniformly commented with "${marker}". Inspect with read first.` };
  }
  const stripped = lines.map(l => {
    if (l.length === 0) return l;
    return l.replace(re, '$1');
  }).join('\n');
  if (cur === stripped) return { changed: false, message: 'segment had no comment markers to strip' };
  return opReplace(buffer, address, stripped);
}

// =============================================================================
// applyInverse + opUndo
// =============================================================================

function applyInverse(buffer, entry) {
  if (entry.kind === 'replace') {
    buffer.segmentText.set(entry.segId, entry.prevText);
    return;
  }
  if (entry.kind === 'delete') {
    const pos = Math.min(entry.position, buffer.segments.length);
    buffer.segments.splice(pos, 0, entry.segment);
    buffer.segmentText.set(entry.segId, entry.prevText);
    if (entry.prevChildren) {
      for (const [id, text] of entry.prevChildren) buffer.segmentText.set(id, text);
    }
    return;
  }
  if (entry.kind === 'insert') {
    const idx = buffer.segments.findIndex(s => s.id === entry.segId);
    if (idx >= 0) buffer.segments.splice(idx, 1);
    buffer.segmentText.delete(entry.segId);
    return;
  }
  if (entry.kind === 'move') {
    if (Array.isArray(entry.prevOrder) && restoreOrder(buffer.segments, entry.prevOrder)) return;
    // Find the seg by id, splice out from its current position, splice it in
    // such that its old neighbors are restored. If the old neighbors are gone
    // (deleted in a later op) this should never happen because LIFO is enforced.
    const cur = buffer.segments.findIndex(s => s.id === entry.segId);
    if (cur < 0) throw new Error(`undo move: seg ${entry.segId} no longer in buffer`);
    const [seg] = buffer.segments.splice(cur, 1);
    let target = entry.prevPosition;
    // Resolve via neighbors if possible (they are the source of truth)
    if (entry.neighborBeforeId) {
      const refIdx = buffer.segments.findIndex(s => s.id === entry.neighborBeforeId);
      if (refIdx >= 0) target = refIdx + 1;
    } else if (entry.neighborAfterId) {
      const refIdx = buffer.segments.findIndex(s => s.id === entry.neighborAfterId);
      if (refIdx >= 0) target = refIdx;
    }
    target = Math.max(0, Math.min(target, buffer.segments.length));
    buffer.segments.splice(target, 0, seg);
    return;
  }
  if (entry.kind === 'nested_delete') {
    // Restore child into parent's children array
    const parent = allSegmentsFlat(buffer.segments).find(s => s.id === entry.parentId);
    if (!parent) throw new Error(`undo nested_delete: parent ${entry.parentId} not found`);
    if (!parent.children) parent.children = [];
    const pos = Math.min(entry.childIndex, parent.children.length);
    parent.children.splice(pos, 0, entry.segment);
    buffer.segmentText.set(entry.segId, entry.prevText);
    buffer.segmentText.set(entry.parentId, entry.prevParentText);
    return;
  }
  if (entry.kind === 'nested_insert') {
    // Remove the inserted child from parent
    const parent = allSegmentsFlat(buffer.segments).find(s => s.id === entry.parentId);
    if (!parent) throw new Error(`undo nested_insert: parent ${entry.parentId} not found`);
    if (parent.children) {
      const idx = parent.children.findIndex(c => c.id === entry.segId);
      if (idx >= 0) parent.children.splice(idx, 1);
      if (parent.children.length === 0) delete parent.children;
    }
    buffer.segmentText.delete(entry.segId);
    buffer.segmentText.set(entry.parentId, entry.prevParentText);
    return;
  }
  if (entry.kind === 'nested_move') {
    // Restore child to its previous index in the parent's children array.
    // Gaps are visible siblings and were not rebuilt by the move, so a simple
    // index restore fully reverts. Parent prefix/suffix are never touched.
    const parent = allSegmentsFlat(buffer.segments).find(s => s.id === entry.parentId);
    if (!parent || !parent.children) throw new Error(`undo nested_move: parent ${entry.parentId} not found`);
    if (Array.isArray(entry.prevChildOrder) && restoreOrder(parent.children, entry.prevChildOrder)) return;
    const curIdx = parent.children.findIndex(c => c.id === entry.segId);
    if (curIdx < 0) throw new Error(`undo nested_move: seg ${entry.segId} not in parent`);
    const [seg] = parent.children.splice(curIdx, 1);
    const target = Math.min(entry.prevChildIndex, parent.children.length);
    parent.children.splice(target, 0, seg);
    return;
  }
  throw new Error(`Unknown undo entry kind: ${entry.kind}`);
}

function lifoCheck(buffer, entry) {
  // Out-of-order undo of a structural op is unsafe — neighbors may have shifted
  // due to later structural ops. Refuse with a clear error pointing at undo:true.
  if (!STRUCTURAL_OPS.has(entry.kind)) return null;
  if (!entry.rowId) return null;          // row-tracking unavailable; skip check
  const blockers = dbCountStructuralAfter(buffer.path, entry.rowId);
  if (blockers > 0) {
    return {
      error: `Cannot undo this ${entry.kind} out of order: ${blockers} newer structural op(s) (insert/delete/move) must be undone first. Use undo:true to step back, or undo:"all" to revert everything.`,
    };
  }
  return null;
}

function opUndo(buffer, target) {
  if (buffer.readonly) throw new Error('read buffer is not editable — edits go to the edit buffer (open the segment for edit first)');
  if (target === 'all') {
    if (buffer.editStack.length === 0) {
      return { reverted: 'all', dirty: buffer.isDirty(), message: 'nothing to undo' };
    }
    while (buffer.editStack.length > 0) {
      const entry = buffer.editStack.pop();
      applyInverse(buffer, entry);
    }
    dbWipePath(buffer.path);
    buffer.invalidateVerify('undo all');
    return { reverted: 'all', dirty: buffer.isDirty() };
  }

  if (target === true || target === 'true') {
    if (buffer.editStack.length === 0) return { error: 'Nothing to undo' };
    const entry = buffer.editStack.pop();
    applyInverse(buffer, entry);
    if (entry.rowId) {
      try { getDb().prepare('DELETE FROM edits WHERE id = ?').run(entry.rowId); } catch {}
    }
    buffer.invalidateVerify('undo last');
    return { reverted: entry.segId, kind: entry.kind, dirty: buffer.isDirty() };
  }

  // undo a specific segId / address
  let segId;
  const s = String(target).trim();
  if (s.startsWith('seg_')) {
    segId = s;
  } else {
    const seg = buffer.findSegment(target);
    if (!seg) return { error: `No segment at address "${target}"` };
    segId = seg.id;
  }
  let foundIdx = -1;
  for (let i = buffer.editStack.length - 1; i >= 0; i--) {
    if (buffer.editStack[i].segId === segId) { foundIdx = i; break; }
  }
  if (foundIdx === -1) return { error: `No undo entry for segment ${segId}` };

  const entry = buffer.editStack[foundIdx];
  // LIFO check for structural ops
  const lifoErr = lifoCheck(buffer, entry);
  if (lifoErr) return lifoErr;

  buffer.editStack.splice(foundIdx, 1);
  applyInverse(buffer, entry);
  if (entry.rowId) {
    try { getDb().prepare('DELETE FROM edits WHERE id = ?').run(entry.rowId); } catch {}
  }
  buffer.invalidateVerify(`undo ${segId}`);
  return { reverted: segId, kind: entry.kind, dirty: buffer.isDirty() };
}

// =============================================================================
// opDiff / opVerify / opCommit / opDiscard / opStatus
// =============================================================================

function opDiff(buffer) {
  if (!buffer.isDirty()) return '(buffer matches disk — clean)';
  const lines = [];
  // Walk in CURRENT order so reordering is visible
  for (const seg of allSegmentsFlat(buffer.segments)) {
    const orig = buffer.originalText.get(seg.id);
    const cur = buffer.segmentText.get(seg.id);
    if (orig === undefined) {
      lines.push(`+ NEW segment ${seg.id} (${seg.name})`);
      lines.push(`  ${cur.slice(0, 200)}${cur.length > 200 ? '...' : ''}`);
    } else if (orig === '' && cur !== '') {
      lines.push(`+ INSERTED segment ${seg.id} (${seg.name})`);
      lines.push(`  ${cur.slice(0, 200)}${cur.length > 200 ? '...' : ''}`);
    } else if (orig !== cur) {
      lines.push(`~ CHANGED segment ${seg.id} (${seg.name})`);
      lines.push(`  - ${orig.slice(0, 200)}${orig.length > 200 ? '...' : ''}`);
      lines.push(`  + ${cur.slice(0, 200)}${cur.length > 200 ? '...' : ''}`);
    }
  }
  // Detect deleted segments (original IDs missing from current segments)
  const liveIds = new Set(allSegmentsFlat(buffer.segments).map(s => s.id));
  for (const [id, origText] of buffer.originalText) {
    if (origText === '') continue;
    if (!liveIds.has(id)) {
      lines.push(`- DELETED segment ${id}`);
      lines.push(`  ${origText.slice(0, 200)}${origText.length > 200 ? '...' : ''}`);
    }
  }
  return lines.join('\n') || '(no changes)';
}

async function opVerify(buffer, level) {
  const content = buffer.assembleText();
  const lvl = Number(level);
  let result;
  if (lvl === 1) result = await verifyL1(buffer.path, content, buffer.language);
  else if (lvl === 2) result = await verifyL2(buffer.path, content, buffer.language);
  else if (lvl === 3) result = await verifyL3(buffer.path, content, buffer.language);
  else return { error: `Invalid verify level: ${level}. Use 1, 2, or 3.` };

  if (result.ok) {
    buffer.verifyToken = {
      level: lvl,
      buffer_state_hash: bufferStateHash(buffer),
      timestamp: new Date().toISOString(),
    };
    result.token_issued = true;
  } else {
    result.token_issued = false;
  }
  return result;
}

async function opCommit(buffer) {
  if (!buffer.isDirty()) {
    dbWipePath(buffer.path);
    clearEditBuffer();
    return { committed: false, reason: 'no_changes', message: `Closed (no changes): ${buffer.path}` };
  }

  // CASCADE-BEFORE-WRITE. Commit owns verification — no manual pre-verify needed.
  // Levels are debugging flags, but L2 is a hard write floor. Run L2 (which
  // cascades L1->L2). If L2 fails, DENY the write and surface the errors. If L2
  // passes, attempt L3; the stored level is L3 if it passed, else L2.
  const _content = buffer.assembleText();
  const PLAINTEXT_LANGS = new Set(['text', 'markdown', 'json']);
  const _l1Ceiling = PLAINTEXT_LANGS.has(buffer.language);

  let verifiedLevel;
  if (_l1Ceiling) {
    // plain-text/json/markdown top out at L1 — L1 is their ceiling and floor.
    const l1 = await verifyL1(buffer.path, _content, buffer.language);
    if (!l1.ok) {
      return {
        blocked: true, reason: 'verify_level_1_not_reached',
        message: 'Validation level 1 (syntax) not reached. Fix the errors and try again.',
        errors: l1.messages || [],
      };
    }
    verifiedLevel = 1;
  } else {
    const l2 = await verifyL2(buffer.path, _content, buffer.language);
    if (!l2.ok) {
      return {
        blocked: true, reason: 'verify_level_2_not_reached',
        message: (l2.messages || []).some(m => /^L1\b/.test(m) && !/OK$/.test(m))
          ? 'Commit blocked: the file does not parse (level 1 failed). Fix the errors and try again.'
          : 'Commit blocked: validation level 2 not reached. Fix the errors and try again.',
        errors: l2.messages || [],
      };
    }
    // L2 passed — attempt L3 (best-effort; failure just caps the stamp at L2).
    let l3ok = false, l3msgs = [];
    try {
      const l3 = await verifyL3(buffer.path, _content, buffer.language);
      l3ok = !!l3.ok; l3msgs = l3.messages || [];
    } catch (e) { l3msgs = [`L3 error: ${e.message}`]; }
    verifiedLevel = l3ok ? 3 : 2;

    // SPEC-GATHER rides the L3 attempt (pass or fail). Inventory the binaries/
    // servers this file mentions — resolved path + version — so we always know
    // what's actually installed/configured. Best-effort: never blocks commit.
    try {
      const refs = detectExternalRefs(_content, buffer.language);
      if (refs && refs.length) {
        const enriched = await gatherSpecs(refs);
        updateExternalSpecs(buffer.path, enriched);
      }
    } catch (e) { console.error(`[read_file] spec-gather error: ${e.message}`); }
  }
  const dir = path.dirname(buffer.path);
  const tmpPath = path.join(dir, `.${path.basename(buffer.path)}.tmp.${process.pid}`);
  buffer.verifyToken = { level: verifiedLevel, buffer_state_hash: bufferStateHash(buffer), timestamp: new Date().toISOString() };
  const finalText = buffer.assembleText();
  await fs.writeFile(tmpPath, finalText, 'utf8');
  await fs.rename(tmpPath, buffer.path);
  const editsApplied = buffer.editStack.length;
  // verifiedLevel computed by the cascade above.

  // STORAGE LAYER (H step 4): persist committed content + segment skeleton
  // into the architect store and append a version-history row. Done on EVERY
  // successful commit (disk bytes are the truth regardless of verify level).
  // Captured BEFORE buffers.delete since it reads buffer.segments. Best-effort:
  // a storage failure must never fail a commit that already hit disk.
  let storageResult = null;
  try {
    // Architect recomputes the skeleton from the committed bytes — the stored
    // truth is the architect's own parse of what hit disk, never the buffer's
    // claims (inserted segments carry kind='inserted' until this step names them).
    let segs = buffer.segments;
    try {
      const reseg = await workerSegmentFile(buffer.path, finalText, buffer.language, aiTitleSegments);
      if (reseg && reseg.segments && reseg.segments.length) segs = reseg.segments;
    } catch (e) { console.error(`[read_file] commit re-segment failed, falling back to buffer view: ${e.message}`); }
    const segSummary = segs.map((s, i) => ({ n: i + 1, ...segmentToSummary(s) }));
    storageResult = storeFileContent(buffer.path, finalText, JSON.stringify(segSummary), {
      verifiedLevel,
      hasParseErrors: false,
      language: buffer.language || null,
    });
  } catch (err) {
    console.error(`[read_file] storeFileContent error: ${err.message}`);
  }

  // Fresh-per-file navigate: refresh this file's modules/methods rows from the
  // just-committed content (JS uses the shared parse; non-JS skipped). Best-effort.
  try {
    refreshFileModules(buffer.path, finalText, buffer.language || null);
  } catch (err) {
    console.error(`[read_file] refreshFileModules error: ${err.message}`);
  }

  dbWipePath(buffer.path);
  clearEditBuffer();

  // Architect linkage: only L3 verify+commit promotes the file's status to
  // 'verified' and increments its version. Lower levels (L1/L2) leave the
  // status untouched — the file is on disk but not in a fully-trusted state.
  let projectStatusUpdate = null;
  try {
    if (verifiedLevel >= 3) {
      const r = markFileVerified(buffer.path, verifiedLevel);
      if (r) {
        projectStatusUpdate = {
          file: buffer.path,
          status: 'verified',
          version: r.current_version,
          previous_version: r.previous_version,
          verified_at_level: r.verified_at_level,
        };
      }
    } else {
      // L1/L2 commit: file changed but not L3-verified. Mark unverified.
      const r = markFileUnverified(buffer.path);
      if (r) projectStatusUpdate = { file: buffer.path, status: 'unverified',
                                     hint: 'Commit succeeded but verify level < 3. File flagged unverified. Run verify=3 + commit again to mark verified.' };
    }
  } catch (err) {
    console.error(`[read_file] architect-link write error: ${err.message}`);
  }

  return {
    committed: true,
    path: buffer.path,
    bytes_written: finalText.length,
    edits_applied: editsApplied,
    verified_at_level: verifiedLevel,
    ...(storageResult && storageResult.stored ? { stored_version: storageResult.version_number ?? null } : {}),
    ...(projectStatusUpdate ? { project_status_update: projectStatusUpdate } : {}),
  };
}

function opDiscard(buffer) {
  const had = !!buffer;
  if (buffer) dbWipePath(buffer.path);
  // drop whichever slot this buffer occupies
  if (_pair().edit && buffer && _pair().edit.path === buffer.path) _pair().edit = null;
  if (_pair().read && buffer && _pair().read.path === buffer.path) _pair().read = null;
  return { discarded: had, path: buffer ? buffer.path : null };
}

function opStatus() {
  const slots = [_pair().read, _pair().edit].filter(Boolean);
  const summary = slots.map(b => ({
    path: b.path,
    language: b.language,
    dirty: b.isDirty(),
    edits: b.editStack.length,
    segments: b.segments.length,
    opened_at: b.openedAt.toISOString(),
    verify_token: b.verifyToken ? { level: b.verifyToken.level, at: b.verifyToken.timestamp } : null,
  }));
  return { open_buffers: summary, count: summary.length };
}



// ============================================================================
// TRACE VALIDATION WALK
// ============================================================================
// One-hop truth propagation: walk the traced file's direct connections in
// order (outgoing locals first, then incoming importers). Already-verified
// neighbors pass silently — they are simply part of the trace. The first
// unverified neighbor gets an L3 validation attempt on its disk bytes:
//   pass → marked verified in the architect, walk continues to the next
//   fail → marked unverified, errors reported, WALK STOPS at that file.
// The signal stops where verification stops.
async function traceValidateTargets(conn) {
  const targets = [];
  for (const it of (conn.outgoing?.items || [])) {
    if (!it.is_external && it.resolved_abs_path) targets.push(it.resolved_abs_path);
  }
  for (const it of (conn.incoming?.items || [])) {
    if (it.importer_abs_path) targets.push(it.importer_abs_path);
  }
  const seen = new Set();
  const report = [];
  let adb = null;
  try { adb = _openArchitectDbReadOnly(); } catch {}
  for (const p of targets) {
    if (seen.has(p)) continue;
    seen.add(p);
    let status = null;
    try {
      status = adb?.prepare('SELECT verification_status FROM files WHERE abs_path = ?').get(p)?.verification_status ?? null;
    } catch {}
    if (status === 'verified') continue; // verified neighbor: silent pass
    const entry = { file: p, previous_status: status || 'unknown' };
    let lang = null;
    try { lang = detectLanguage(p); } catch {}
    if (!lang) { entry.result = 'skipped_unsupported'; report.push(entry); continue; }
    let content;
    try {
      content = await fs.readFile(p, 'utf8');
    } catch (e) {
      entry.result = 'validation_failed';
      entry.errors = [`read error: ${e.message}`];
      entry.stopped_here = true;
      report.push(entry);
      break;
    }
    let ok = false, msgs = [];
    try {
      const l3 = await verifyL3(p, content, lang);
      ok = !!l3.ok; msgs = l3.messages || [];
    } catch (e) { msgs = [`L3 error: ${e.message}`]; }
    if (ok) {
      entry.result = 'validation_passed';
      entry.level = 3;
      try { markFileVerified(p, 3); } catch {}
      report.push(entry);
      // walk continues to the next target
    } else {
      entry.result = 'validation_failed';
      entry.errors = msgs;
      entry.stopped_here = true;
      try { markFileUnverified(p); } catch {}
      report.push(entry);
      break; // first failure stops the walk
    }
  }
  try { adb?.close?.(); } catch {}
  return report;
}


// ============================================================================
// READ-BEFORE-WRITE MARKS
// ============================================================================
// You cannot modify code you have not looked at. A segment read displays the
// code and records its address here (plus every nested address it displayed).
// Any successful edit or commit wipes the marks for that path — the buffer
// changed, so every previously-displayed view is stale and must be re-read.
const _readMarks = new Map(); // path -> Set<address>

function markRead(path, address, tree) {
  let set = _readMarks.get(path);
  if (!set) { set = new Set(); _readMarks.set(path, set); }
  set.add(String(address));
  const walk = (nodes) => {
    for (const n of (nodes || [])) {
      set.add(String(n.address));
      if (n.children) walk(n.children);
    }
  };
  if (tree) walk(tree);
}

function clearReadMarks(path) {
  _readMarks.delete(path);
}

// A target address is covered if it was displayed directly, or if any marked
// ancestor displayed it (reading a container shows all its children's code).
function isRead(path, address) {
  const set = _readMarks.get(path);
  if (!set) return false;
  const a = String(address).trim();
  if (set.has(a)) return true;
  for (const m of set) {
    if (a.startsWith(m + '.')) return true;
  }
  return false;
}

// Build the rejection: show the code the caller was about to modify, so a
// wrong target is unmissable at the moment of refusal.
function unreadTargetError(buffer, address, verb) {
  const seg = buffer.findSegment(address);
  const preview = seg
    ? (buffer.segmentText.get(seg.id) || '').slice(0, 300)
    : null;
  return {
    error: `unread target: segment ${address} has not been displayed in the current buffer state — read it first (segment: "${address}"), then ${verb}`,
    target: seg ? { address: String(address), id: seg.id, kind: seg.kind, name: seg.name, preview } : { address: String(address), exists: false },
  };
}
// =============================================================================
// MCP TOOL EXPORT
// =============================================================================

export default {
  name: 'read_file',
  description: 'Segment-addressed file editor. Default returns the file skeleton (a list of named segments). Use segment="N" to read a specific part. trace=true follows the file\'s signal through the codebase (imports in/out, databases, external binaries/servers) and validation-walks its direct connections: unverified neighbors get an L3 attempt; the first failure stops the walk. Edits are one-per-transaction: edit → verify → commit, and READ-BEFORE-WRITE: any destructive verb (replace/delete/move/comment_out/uncomment/paste) requires its target segment to have been displayed (segment="N") since the last change — you cannot modify code you have not looked at.',
  schema: {
    path: z.string().optional().describe('File path. Required for everything except action="status".'),
    segment: z.string().optional().describe('Read full text of segment N (or "5.3" for nested). Default if no other op given returns skeleton. Reading a segment also unlocks it (and everything it displays) for destructive verbs.'),
    trace: z.union([z.boolean(), z.string()]).optional().describe('true = trace this file\'s signal flow: outgoing imports (resolved to project files), incoming importers, databases, and external binaries/servers it touches. Unverified direct connections get an L3 validation attempt, walked in order — first failure stops the walk. "N" reserved for segment-level trace (currently returns file-level with a granularity note).'),
    replace: z.string().optional().describe('Address of segment to replace (used with content). Target must have been read in the current buffer state.'),
    content: z.string().optional().describe('New text for replace.'),
    delete: z.array(z.string()).optional().describe('List of segment addresses to remove. Each target must have been read in the current buffer state.'),
    insert: z.object({
      between: z.array(z.string()).length(2).describe('[A, B] segment addresses (must be adjacent; use "start" or "end" for boundaries).'),
      content: z.string(),
    }).optional().describe('Insert a new segment in the gap between two existing segments.'),
    move: z.object({
      seg: z.string().describe('Address of the segment to move. Must have been read in the current buffer state.'),
      after: z.string().optional().describe('Place seg right after this anchor (or "start" for top of file).'),
      before: z.string().optional().describe('Place seg right before this anchor (or "end" for bottom).'),
    }).optional().describe('Reorder a top-level segment.'),
    comment_out: z.string().optional().describe('Wrap segment in #/// line-comment markers (debugging aid). Target must have been read in the current buffer state.'),
    uncomment: z.string().optional().describe('Strip line-comment markers from a previously commented segment. Target must have been read in the current buffer state.'),
    undo: z.union([z.boolean(), z.string()]).optional().describe('true=last edit, "all"=full revert, "<address|segId>"=revert that segment. Structural ops (insert/delete/move) require LIFO undo.'),
    diff: z.boolean().optional().describe('Show changes vs disk.'),
    verify: z.number().optional().describe('Validate buffer at level 1, 2, or 3. Issues verify token on success.'),
    commit: z.boolean().optional().describe('Atomic write to disk. Requires a current verify token.'),
    discard: z.boolean().optional().describe('Drop buffer, no disk change.'),
    paste: z.object({
      from: z.string().optional().describe('Read-buffer segment address to copy (omit or "all" for whole file).'),
      to: z.string().describe('Edit-buffer segment address to overwrite with the copied text. Must have been read in the current buffer state.'),
    }).optional().describe('Clipboard paste: copy verbatim from the read buffer into an edit-target segment.'),
    search: z.string().optional().describe('For huge files: keyword to filter the skeleton to matching segments (grouped in 10s) instead of dumping all titles.'),
    full_skeleton: z.boolean().optional().describe('Force the entire skeleton even if it exceeds the explosion-radius threshold.'),
    action: z.enum(['status']).optional().describe('Tool-level action: "status" lists open buffers.'),
  },
  async handler(args, _ctx) {
    try {
      if (args.action === 'status') return wrap(opStatus());
      if (!args.path) return wrap({ error: 'path is required for all actions except action="status"' });
      if (!existsSync(args.path) && !args.discard) return wrap({ error: `File not found: ${args.path}` });

      if (args.discard) {
        clearReadMarks(args.path);
        const buf = bufferForPath(args.path);
        if (!buf) {
          dbWipePath(args.path);
          return wrap({ discarded: false, message: 'no open buffer' });
        }
        return wrap(opDiscard(buf));
      }

      // TRACE: signal-flow query, fronted by read_file. The architect is an
      // engine module — the model hands over a path, the engine resolves the
      // project and address internally. No project_id bookkeeping in the model.
      // MCP transports may deliver booleans as strings, so normalize first:
      // true/"true"/"1" = file-level trace; any other string = segment address.
      if (args.trace !== undefined && args.trace !== false && args.trace !== 'false') {
        const traceSeg = (args.trace === true || args.trace === 'true' || args.trace === '1')
          ? null
          : String(args.trace);
        const proj = getProjectForFile(args.path);
        if (!proj || proj.match === 'none') {
          return wrap({
            trace: false,
            error: 'no signal map: file is not part of any scanned project — the architect has not ingested it yet',
            path: args.path,
          });
        }
        if (proj.match !== 'exact_file' || !proj.file_address) {
          return wrap({
            trace: false,
            error: `no signal map: file is inside project '${proj.project_name}' but not yet indexed — re-scan the project first`,
            path: args.path,
          });
        }
        const conn = getConnections(proj.project_id, proj.file_address);
        const out = {
          trace: true,
          path: args.path,
          project: proj.project_name,
          ...conn,
        };
        // Validation walk: one hop over direct connections, in order.
        // Verified neighbors pass silently; unverified ones get an L3 attempt;
        // the first failure stops the walk (and says so).
        const walk = await traceValidateTargets(conn);
        if (walk.length) out.targets_validated = walk;
        if (traceSeg !== null) {
          out.granularity = 'file';
          out.note = `segment-level trace not yet available — showing file-level signal flow (requested segment: ${traceSeg})`;
        }
        return wrap(out);
      }

      // ONE-EDIT-PER-TRANSACTION GUARD: the buffer may hold at most one
      // uncommitted edit. A second edit verb is rejected until the pending
      // change passes through verify+commit (advancing the architect's source
      // of truth), or is undone/discarded. Unverified changes never stack and
      // never leak into the source of truth.
      const txGuard = (buffer) => {
        if (buffer.editStack && buffer.editStack.length > 0) {
          return {
            error: 'transaction open: an uncommitted edit is pending — verify+commit, undo, or discard before the next edit',
            edits_pending: buffer.editStack.length,
            dirty: true,
          };
        }
        return null;
      };

      // READ-BEFORE-WRITE GUARD: destructive verbs must target a segment whose
      // code was displayed since the last change to this path. The rejection
      // shows the code at the target address so a wrong target is unmissable.
      const rbwGuard = (buffer, addresses, verb) => {
        for (const addr of addresses) {
          if (!isRead(args.path, addr)) return unreadTargetError(buffer, addr, verb);
        }
        return null;
      };

      // v4 PASTE: copy a segment (or whole contents) from the READ buffer into
      // a segment of the EDIT buffer, verbatim. Accurate code reuse without
      // re-inference. Requires the read buffer loaded (the source) and names
      // the destination segment in the edit buffer.
      if (args.paste !== undefined) {
        if (!_pair().read) return wrap({ error: 'paste needs a read buffer — open the source file with read=true first' });
        const eb = await getEditBuffer(args.path);
        const guarded = txGuard(eb);
        if (guarded) return wrap(guarded);
        const srcAddr = args.paste.from;   // read-buffer segment address (optional: whole file)
        const dstAddr = args.paste.to;     // edit-buffer segment address
        if (dstAddr === undefined) return wrap({ error: 'paste requires { from, to }: to = destination segment in the edit target' });
        const rbw = rbwGuard(eb, [dstAddr], 'paste');
        if (rbw) return wrap(rbw);
        let srcText;
        if (srcAddr === undefined || srcAddr === 'all') {
          srcText = _pair().read.assembleText();
        } else {
          const ss = _pair().read.findSegment(srcAddr);
          if (!ss) return wrap({ error: `paste source segment not found in read buffer: ${srcAddr}` });
          srcText = _pair().read.segmentText.get(ss.id);
          if (srcText === undefined) srcText = _pair().read.originalText.get(ss.id);
        }
        clearReadMarks(args.path);
        return wrap(opReplace(eb, dstAddr, srcText));
      }

      // ROUTING: reads use the READ buffer (opt-in, always fresh, readonly).
      // Everything that mutates / verifies / commits uses the EDIT buffer.
      const wantsEdit = args.commit || args.diff || args.verify !== undefined ||
        args.undo !== undefined || args.insert || args.move ||
        args.comment_out !== undefined || args.uncomment !== undefined ||
        args.delete || args.replace !== undefined;

      if (wantsEdit) {
        const buffer = await getEditBuffer(args.path);

        // Transaction-control verbs: always allowed on a dirty buffer.
        if (args.commit) {
          clearReadMarks(args.path); // disk advances: every displayed view is stale
          return wrap(await opCommit(buffer));
        }
        if (args.diff)                return wrap(opDiff(buffer));
        if (args.verify !== undefined) return wrap(await opVerify(buffer, args.verify));
        if (args.undo !== undefined) {
          clearReadMarks(args.path); // buffer reshaped: re-read before touching
          return await wrapMutate(opUndo(buffer, args.undo), buffer);
        }

        // Edit verbs: blocked while a transaction is open.
        const guarded = txGuard(buffer);
        if (guarded) return wrap(guarded);

        if (args.insert) {
          const [a, b] = args.insert.between;
          clearReadMarks(args.path); // numbering shifts after a structural op
          return await wrapMutate(opInsert(buffer, a, b, args.insert.content), buffer);
        }
        if (args.move) {
          const rbw = rbwGuard(buffer, [args.move.seg], 'move');
          if (rbw) return wrap(rbw);
          clearReadMarks(args.path);
          return await wrapMutate(opMove(buffer, args.move.seg, { after: args.move.after, before: args.move.before }), buffer);
        }
        if (args.comment_out !== undefined) {
          const rbw = rbwGuard(buffer, [args.comment_out], 'comment_out');
          if (rbw) return wrap(rbw);
          clearReadMarks(args.path);
          return wrap(opCommentOut(buffer, args.comment_out));
        }
        if (args.uncomment !== undefined) {
          const rbw = rbwGuard(buffer, [args.uncomment], 'uncomment');
          if (rbw) return wrap(rbw);
          clearReadMarks(args.path);
          return wrap(opUncomment(buffer, args.uncomment));
        }
        if (args.delete) {
          const rbw = rbwGuard(buffer, args.delete, 'delete');
          if (rbw) return wrap(rbw);
          clearReadMarks(args.path);
          return await wrapMutate(opDelete(buffer, args.delete), buffer);
        }
        if (args.replace !== undefined) {
          if (args.content === undefined) return wrap({ error: 'replace requires content' });
          const rbw = rbwGuard(buffer, [args.replace], 'replace');
          if (rbw) return wrap(rbw);
          clearReadMarks(args.path);
          return wrap(opReplace(buffer, args.replace, args.content));
        }
      }

      // READ path: opt-in read buffer (always disk-fresh, readonly).
      const rbuf = await getReadBuffer(args.path);
      if (args.segment !== undefined) {
        const res = opReadSegment(rbuf, args.segment);
        // Displaying code unlocks it: mark this address (and every nested
        // address whose code the response shows) as read for this path.
        if (!res.error) markRead(args.path, args.segment, res.tree);
        return wrap(res);
      }
      return wrap(await opSkeleton(rbuf, { search: args.search || null, fullSkeleton: !!args.full_skeleton }));
    } catch (e) {
      return wrap({ error: `${e.message}`, stack: e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : undefined });
    }
  },
};

function wrap(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// Mutations report only their own receipt — no skeleton, no file dump.
// Fresh structure comes from an explicit reopen (default skeleton read),
// which is the only honest view anyway: addresses shift after structural
// ops, so navigation must restart from a fresh read, not a stale merge.
async function wrapMutate(opResult, _buffer) {
  return wrap(opResult);
}


// Sandbox: forget a wiped slot's buffers, read marks and edit history handle.
(globalThis.__sandboxForgetHooks ||= []).push((slotDir) => {
  const under = (p) => p === slotDir || p.startsWith(slotDir + '/');
  _bufferPairs.delete(slotDir);
  for (const k of [..._readMarks.keys()]) if (under(k)) _readMarks.delete(k);
  for (const [d, h] of _editDbs) if (under(d)) { try { h.close(); } catch {} _editDbs.delete(d); }
});
