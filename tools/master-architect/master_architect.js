/**
 * master_architect — MCP tool wrapper.
 *
 * Single tool exposing all master-architect operations as discriminated actions.
 * Read-only actions are unconditionally available. Mutating actions (scan,
 * discover, associate) use the per-user lock from scan.js.
 *
 * Action surface:
 *   estimate    — fast pre-scan size/duration estimate, no DB writes
 *   scan        — full project scan, populates DB
 *   project_for — does this file belong to a known project?
 *   discover    — file isn't known, follow imports, build connected component
 *   associate   — explicitly add a file to an existing project
 *   navigate    — fetch what's at an address (structural | raw)
 *   connections — incoming/outgoing imports + db references for an address
 *   context     — convenience: connections by absolute path
 *   missing     — broken local imports report
 *   languages   — list known languages and their support status
 *   stats       — overall summary across all projects
 *   list        — list projects in the DB
 */

import { z } from 'zod';
import { scanProject, listActiveScans } from './lib/scan.js';
import { estimateScan } from './lib/estimate.js';
import {
  getProjectForFile, associateFile, registerDiscoveredProject,
  navigate, getConnections, getPing, getFileContext, getMissing, getTopology, getBones,
} from './lib/query.js';
import { listLanguages } from './lib/registry.js';
import { getDb } from './lib/db.js';import { chainReactionCrawl } from './lib/editor/architect-link.js';


// Hard ceiling on response size — enforced on every action that could
// return variable-size data. If a response would exceed this token budget
// the action is blocked and the model is redirected to a cheaper alternative.
const MAX_RESPONSE_TOKENS = 4000;

function tokenEstimate(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

function isFileAddress(address) {
  // File addresses are numeric dot-separated: "13", "h.n.2", "g.13"
  // Directory addresses are single letters or short alphanumeric: "h", "g", "1"
  // A file address always resolves to a file row, not a directory row.
  // We check this by the presence of a dot or purely numeric string with depth > 1
  if (!address) return false;
  const parts = address.split('.');
  // single segment — could be file or dir, let navigate decide
  // multi-segment — definitely file or module level
  return parts.length >= 2;
}

export default {
  name: 'master_architect',
  description: 'Project-aware code skeleton + navigation. START with topology(project_id) to see the data-flow graph. Then bones(project_id, address) to see a file\'s structure. Then read_file to read/edit specific segments. NEVER call navigate or list to browse the full project — always start with topology.',

  schema: {
    action: z.enum([
      'estimate', 'scan', 'project_for', 'register', 'associate',
      'navigate', 'connections', 'ping', 'context', 'missing',
      'topology', 'bones', 'languages', 'stats', 'list', 'crawl',
    ]).describe('Operation. ALWAYS start with topology to orient. bones = compact file structure view (imports + modules). navigate = only for file/module/method addresses when you already know the exact address from bones. topology = data-flow graph entry point. NEVER use navigate to browse directories.'),
    path: z.string().optional().describe('Absolute file path (for path-based actions, or bones by path)'),
    project_id: z.number().int().optional().describe('Project id (for navigate/connections/missing/topology/bones/crawl)'),
    project_name: z.string().optional().describe('Optional project name override (for scan)'),
    address: z.string().optional().describe('Hierarchical address e.g. 1.2.3 (for navigate/connections/bones) — must be a file or module address, not a directory'),
    mode: z.enum(['structural', 'raw']).optional().describe('navigate mode: structural skeleton or raw content (default structural)'),
    max_depth: z.number().int().optional().describe('discover crawl depth limit (default 5)'),
  },

  async handler(args, ctx) {
    const userId = ctx?.userId || process.env.MCP_USER_ID || 'default';

    try {
      switch (args.action) {

        case 'estimate': {
          if (!args.path) return errResp('path required for estimate');
          return okResp(estimateScan(args.path));
        }

        case 'scan': {
          if (!args.path) return errResp('path required for scan');
          let expectedMs = null;
          try { expectedMs = estimateScan(args.path).est_duration_ms; } catch {}
          const result = await scanProject(args.path, args.project_name, { userId, expectedMs });
          return okResp(result);
        }

        case 'project_for': {
          if (!args.path) return errResp('path required for project_for');
          return okResp(getProjectForFile(args.path));
        }

        case 'register': {
          if (!args.path)         return errResp('path required for register (the seed file from discover)');
          if (!args.project_name) return errResp('project_name required for register');
          const opts = { maxDepth: args.max_depth };
          if (args.address && args.address.startsWith('/')) {
            opts.rootPath = args.address;
          }
          const result = await registerDiscoveredProject(args.path, args.project_name, opts);
          return okResp(result);
        }

        case 'associate': {
          if (!args.path)       return errResp('path required for associate');
          if (!args.project_id) return errResp('project_id required for associate');
          const result = await associateFile(args.path, args.project_id);
          return okResp(result);
        }

        case 'crawl': {
          if (!args.path)       return errResp('path required for crawl (the seed file)');
          if (!args.project_id) return errResp('project_id required for crawl (the target project)');
          const result = chainReactionCrawl(args.path, args.project_id, { maxDepth: args.max_depth });
          return okResp(result);
        }

        case 'navigate': {
          if (!args.project_id) return errResp('project_id required for navigate');
          if (!args.address)    return errResp('address required for navigate');
          const navResult = navigate(args.project_id, args.address, { mode: args.mode || 'structural' });
          if (navResult.kind === 'directory') {
            return okResp({
              ok: false,
              redirected: true,
              reason: 'navigate on a directory would dump too many files. Use topology(project_id) to see the data-flow graph, then bones(project_id, address) to inspect a specific file.',
              hint: `Call topology(project_id=${args.project_id}) first.`,
            });
          }
          if (tokenEstimate(navResult) > MAX_RESPONSE_TOKENS) {
            return okResp({
              ok: false,
              redirected: true,
              reason: `Response would be ~${tokenEstimate(navResult)} tokens — too large. Use bones(project_id, address) for a compact view of this file first.`,
              hint: `Call bones(project_id=${args.project_id}, address="${args.address}") instead.`,
            });
          }
          return okResp(navResult);
        }

        case 'bones': {
          if (!args.project_id && !args.path) return errResp('project_id + address, or path required for bones');
          if (args.project_id && !args.address && !args.path) {
            return okResp({
              ok: false,
              redirected: true,
              reason: 'bones requires a file address or path. Use topology(project_id) first to find file addresses.',
              hint: `Call topology(project_id=${args.project_id}) to see the data-flow graph and find file addresses.`,
            });
          }
          const bonesResult = getBones(args.project_id, args.address, args.path);
          if (tokenEstimate(bonesResult) > MAX_RESPONSE_TOKENS) {
            if (bonesResult.imports) {
              bonesResult.imports = bonesResult.imports.filter(i => !i.external);
              bonesResult._trimmed = 'external imports removed to fit token budget';
            }
          }
          return okResp(bonesResult);
        }

        case 'connections': {
          if (!args.project_id) return errResp('project_id required for connections');
          if (!args.address)    return errResp('address required for connections');
          return okResp(getConnections(args.project_id, args.address));
        }

        case 'ping': {
          if (!args.project_id) return errResp('project_id required for ping');
          if (!args.address)    return errResp('address required for ping');
          return okResp(getPing(args.project_id, args.address, { maxHops: args.max_depth }));
        }

        case 'context': {
          if (!args.path) return errResp('path required for context');
          return okResp(getFileContext(args.path));
        }

        case 'missing': {
          if (!args.project_id) return errResp('project_id required for missing');
          return okResp(getMissing(args.project_id));
        }

        case 'topology': {
          if (!args.project_id) return errResp('project_id required for topology');
          const topoResult = getTopology(args.project_id);
          if (tokenEstimate(topoResult) > MAX_RESPONSE_TOKENS) {
            return okResp({
              ...topoResult,
              nodes: topoResult.nodes.slice(0, 50),
              edges: topoResult.edges.slice(0, 100),
              _trimmed: `Response trimmed: showing 50/${topoResult.nodes.length} nodes, 100/${topoResult.edges.length} edges. Use bones(address) to inspect specific files.`,
            });
          }
          return okResp(topoResult);
        }

        case 'languages': {
          return okResp({ languages: listLanguages() });
        }

        case 'stats': {
          const db = getDb();
          const counts = {
            projects:    db.prepare('SELECT COUNT(*) c FROM projects').get().c,
            files:       db.prepare('SELECT COUNT(*) c FROM files').get().c,
            modules:     db.prepare('SELECT COUNT(*) c FROM modules').get().c,
            methods:     db.prepare('SELECT COUNT(*) c FROM methods').get().c,
            imports:     db.prepare('SELECT COUNT(*) c FROM imports').get().c,
            databases:   db.prepare('SELECT COUNT(*) c FROM databases').get().c,
          };
          const lastScan = db.prepare(
            "SELECT root_path, finished_at, files_total, duration_ms FROM scans s JOIN projects p ON s.project_id = p.id ORDER BY s.id DESC LIMIT 1"
          ).get();
          const active = listActiveScans(userId);
          return okResp({ counts, last_scan: lastScan, active_scans: active });
        }

        case 'list': {
          const db = getDb();
          const projects = db.prepare(`
            SELECT p.id, p.name, p.root_path, p.last_scan_at,
                   (SELECT COUNT(*) FROM files WHERE project_id = p.id) AS file_count,
                   (SELECT COUNT(*) FROM modules m JOIN files f ON m.file_id = f.id WHERE f.project_id = p.id) AS module_count
            FROM projects p
            ORDER BY p.last_scan_at DESC NULLS LAST
          `).all();
          const known = projects.filter(p => !p.root_path.startsWith('unknown://'));
          const unknownCount = projects.length - known.length;
          return okResp({
            projects: known,
            ...(unknownCount > 0 ? { unknown: `unknown(${unknownCount}) — orphan files with no scanned project root` } : {}),
          });
        }

        default:
          return errResp(`unknown action: ${args.action}`);
      }
    } catch (err) {
      return errResp(err.message, { stack: err.stack });
    }
  },
};

function okResp(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errResp(message, extra = {}) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }] };
}
