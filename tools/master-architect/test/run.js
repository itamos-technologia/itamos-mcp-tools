/**
 * CLI test harness — exercises master-architect components without MCP.
 *
 *   node test/run.js languages
 *   node test/run.js detect <file_path>
 *   node test/run.js dbinit
 *   node test/run.js scan <project_root> [name]
 *   node test/run.js summary <project_name>          (project file/dir/module counts)
 *   node test/run.js skeleton <project_name>         (level-1 listing: dirs + files)
 *   node test/run.js navigate <project> <address>    (not yet implemented)
 */

import { detectLanguage, listLanguages } from '../lib/registry.js';
import { getDb, dbPath } from '../lib/db.js';
import { scanProject } from '../lib/scan.js';
import { estimateScan } from '../lib/estimate.js';
import {
  getProjectForFile, associateFile, discoverProject,
  navigate, getConnections, getFileContext, getMissing,
} from '../lib/query.js';

const SCRATCH_DB = process.env.MASTER_ARCHITECT_DB || '/scratch/bncs/dev-master-architect/master-architect.db';
process.env.MASTER_ARCHITECT_DB = SCRATCH_DB;

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {

    case 'languages': {
      const langs = listLanguages();
      console.log(`Languages known: ${langs.length}\n`);
      const groups = {};
      for (const l of langs) (groups[l.status] = groups[l.status] || []).push(l);
      for (const [status, items] of Object.entries(groups)) {
        console.log(`[${status}] (${items.length})`);
        for (const it of items) console.log(`  ${it.language.padEnd(20)} ${it.extensions.join(' ')}`);
        console.log('');
      }
      break;
    }

    case 'detect': {
      console.log(JSON.stringify(detectLanguage(args[0]), null, 2));
      break;
    }

    case 'dbinit': {
      const db = getDb(SCRATCH_DB);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      console.log(`DB at: ${dbPath()}\nTables (${tables.length}):`);
      for (const t of tables) console.log(`  ${t.name}`);
      break;
    }

    case 'estimate': {
      if (!args[0]) { console.error('usage: estimate <root>'); process.exit(1); }
      const r = estimateScan(args[0]);
      console.log(`Scan estimate for: ${r.root_path}`);
      console.log(`  Walk completed in: ${r.walk_duration_ms} ms`);
      console.log(`  Directories: ${r.directories_total}`);
      console.log(`  Files total: ${r.files_total}`);
      console.log(`  By category:`);
      for (const [k, v] of Object.entries(r.by_category)) {
        if (v > 0) console.log(`    ${k.padEnd(15)}: ${v}`);
      }
      console.log(`  By language (top 10):`);
      const langs = Object.entries(r.by_language).slice(0, 10);
      for (const [lang, n] of langs) console.log(`    ${lang.padEnd(20)}: ${n}`);
      console.log(`  Skipped: unrecognized=${r.skipped.unrecognized}, ignored_dirs=${r.skipped.ignored_directories}, ignored_files=${r.skipped.ignored_files}`);
      console.log(`  Estimated full scan: ${r.est_duration_seconds}s (${r.est_duration_ms} ms)`);
      if (r.warning) console.log(`  ⚠ ${r.warning}`);
      break;
    }

    case 'scan': {
      if (!args[0]) { console.error('usage: scan <root> [name]'); process.exit(1); }
      const result = await scanProject(args[0], args[1]);
      console.log(`✓ Scanned ${result.project_name} at ${result.root_path}`);
      console.log(`  Duration: ${result.duration_ms} ms`);
      console.log(`  Files total:           ${result.files_total}`);
      console.log(`    parsed (supported):  ${result.files_parsed}`);
      console.log(`    pending language:    ${result.files_pending_lang}`);
      console.log(`    opaque:              ${result.files_opaque}`);
      console.log(`    skipped:             ${result.files_skipped}`);
      console.log(`    errored:             ${result.files_errored}`);
      break;
    }

    case 'summary': {
      const db = getDb(SCRATCH_DB);
      const proj = db.prepare('SELECT * FROM projects WHERE name = ?').get(args[0]);
      if (!proj) { console.error(`No project: ${args[0]}`); process.exit(1); }
      const counts = {
        directories: db.prepare('SELECT COUNT(*) c FROM directories WHERE project_id = ?').get(proj.id).c,
        files:       db.prepare('SELECT COUNT(*) c FROM files WHERE project_id = ?').get(proj.id).c,
        modules:     db.prepare('SELECT COUNT(*) c FROM modules m JOIN files f ON m.file_id=f.id WHERE f.project_id = ?').get(proj.id).c,
        methods:     db.prepare('SELECT COUNT(*) c FROM methods me JOIN modules m ON me.module_id=m.id JOIN files f ON m.file_id=f.id WHERE f.project_id = ?').get(proj.id).c,
        imports:     db.prepare('SELECT COUNT(*) c FROM imports i JOIN files f ON i.file_id=f.id WHERE f.project_id = ?').get(proj.id).c,
        databases:   db.prepare('SELECT COUNT(*) c FROM databases WHERE project_id = ?').get(proj.id).c,
      };
      const byCat = db.prepare(
        'SELECT category, COUNT(*) c FROM files WHERE project_id = ? GROUP BY category'
      ).all(proj.id);
      console.log(`Project: ${proj.name}  (root: ${proj.root_path})`);
      console.log(`Last scanned: ${proj.last_scan_at}\n`);
      for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(15)}: ${v}`);
      console.log('');
      console.log('Files by category:');
      for (const row of byCat) console.log(`  ${row.category.padEnd(20)}: ${row.c}`);
      break;
    }

    case 'skeleton': {
      const db = getDb(SCRATCH_DB);
      const proj = db.prepare('SELECT * FROM projects WHERE name = ?').get(args[0]);
      if (!proj) { console.error(`No project: ${args[0]}`); process.exit(1); }

      console.log(`# ${proj.name}  (${proj.root_path})\n`);

      // Print directories with their files, indented by depth
      const dirs = db.prepare(
        "SELECT * FROM directories WHERE project_id = ? ORDER BY CAST(SUBSTR(address || '.', 1, INSTR(address || '.', '.') - 1) AS INTEGER), address"
      ).all(proj.id);
      const filesByDirId = new Map();
      const rootFiles = db.prepare(
        "SELECT * FROM files WHERE project_id = ? AND directory_id IS NULL ORDER BY CASE WHEN substr(address,1,1) GLOB '[0-9]' THEN 0 ELSE 1 END, CAST(address AS INTEGER), address"
      ).all(proj.id);

      const allFiles = db.prepare(
        "SELECT * FROM files WHERE project_id = ? AND directory_id IS NOT NULL ORDER BY directory_id, CASE WHEN substr(address,1,1) GLOB '[0-9]' THEN 0 ELSE 1 END, address"
      ).all(proj.id);
      for (const f of allFiles) {
        if (!filesByDirId.has(f.directory_id)) filesByDirId.set(f.directory_id, []);
        filesByDirId.get(f.directory_id).push(f);
      }

      function fileLine(f, indent) {
        // Skeleton-able files: show structural info (modules/methods), no token estimate.
        // Other files: show line count + token estimate (LLM may want to raw-load).
        // Binary files: show only byte size.
        let detail;
        if (f.category === 'supported') {
          const mc = db.prepare('SELECT COUNT(*) c FROM modules WHERE file_id = ?').get(f.id).c;
          const methodsCount = db.prepare(
            'SELECT COUNT(*) c FROM methods me JOIN modules m ON me.module_id = m.id WHERE m.file_id = ?'
          ).get(f.id).c;
          detail = `${f.language}, ${f.line_count} lines, ${mc} modules` +
                   (methodsCount ? `, ${methodsCount} methods` : '');
        } else if (f.category === 'opaque_binary') {
          detail = `${f.language}, ${(f.byte_size / 1024).toFixed(1)} KB`;
        } else {
          // coming_soon or opaque_text
          detail = `${f.language}, ${f.line_count} lines, ~${f.est_tokens.toLocaleString()} tok`;
        }
        const status =
          f.parse_status === 'pending_language_support' ? ' [parser coming soon]' :
          f.category === 'opaque_binary' ? ' [binary, not readable]' :
          f.category === 'opaque_text' ? ' [readable, no structure]' :
          f.parse_status === 'parse_error' ? ' [parse error]' : '';
        console.log(`${indent}${f.address}. ${f.name.padEnd(30)} (${detail})${status}`);
      }

      // Print root files first
      for (const f of rootFiles) fileLine(f, '');

      // Print each directory + its files
      for (const d of dirs) {
        const depth = d.address.split('.').length - 1;
        const indent = '  '.repeat(depth);
        console.log(`${indent}${d.address}. ${d.name}/`);
        const files = filesByDirId.get(d.id) || [];
        for (const f of files) fileLine(f, indent + '  ');
      }
      break;
    }

    case 'project_for': {
      if (!args[0]) { console.error('usage: project_for <abs_path>'); process.exit(1); }
      console.log(JSON.stringify(getProjectForFile(args[0]), null, 2));
      break;
    }

    case 'discover': {
      if (!args[0]) { console.error('usage: discover <abs_path>'); process.exit(1); }
      const r = await discoverProject(args[0]);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case 'associate': {
      if (!args[0] || !args[1]) { console.error('usage: associate <file_path> <project_id>'); process.exit(1); }
      const r = await associateFile(args[0], parseInt(args[1], 10));
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case 'navigate': {
      if (!args[0] || !args[1]) { console.error('usage: navigate <project_id> <address> [raw]'); process.exit(1); }
      const mode = args[2] === 'raw' ? 'raw' : 'structural';
      const r = navigate(parseInt(args[0], 10), args[1], { mode });
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case 'connections': {
      if (!args[0] || !args[1]) { console.error('usage: connections <project_id> <address>'); process.exit(1); }
      const r = getConnections(parseInt(args[0], 10), args[1]);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case 'context': {
      if (!args[0]) { console.error('usage: context <abs_path>'); process.exit(1); }
      const r = getFileContext(args[0]);
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case 'missing': {
      if (!args[0]) { console.error('usage: missing <project_id>'); process.exit(1); }
      const r = getMissing(parseInt(args[0], 10));
      console.log(`Missing imports in project ${r.project_id}: ${r.count}`);
      for (const m of r.missing.slice(0, 30)) {
        console.log(`  ${m.file_address}. ${m.file_name}:${m.line}  →  '${m.import_path}'`);
      }
      if (r.count > 30) console.log(`  ... and ${r.count - 30} more`);
      break;
    }

    default:
      console.error('Commands: languages | detect <path> | dbinit | estimate <root> | scan <root> [name] | summary <name> | skeleton <name> | project_for <path> | discover <path> | associate <path> <pid> | navigate <pid> <addr> [raw] | connections <pid> <addr> | context <path> | missing <pid>');
      process.exit(1);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
