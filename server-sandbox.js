// ═══════════════════════════════════════════════════════════════════════════
// Itamos MCP Sandbox Server (v1.1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pre-allocated ZFS slot pool — no sudo at runtime.
// 500 slots pre-created at /fast/sandboxes/slot_001 .. slot_500
// IP → slot assignment in memory. On expiry: wipe slot contents, free slot.
//
// Endpoints:
//   GET  /session/create  → assigns slot to IP, returns MCP URL
//   GET  /health          → pool status
//   POST /mcp             → MCP handler (IP is identity)
//
// ═══════════════════════════════════════════════════════════════════════════

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request sandbox context. Every per-user resource in the tools (architect
// DB, edit history, edit/read buffers, scan lock, caches) is selected from this
// store, so concurrent users in different slots can never touch each other's.
globalThis.__sandboxCtx = new AsyncLocalStorage();
// Tools register cleanup hooks here; wipeSlot() runs them so a reused slot never
// inherits open DB handles, buffers or read marks from its previous user.
globalThis.__sandboxForgetHooks = globalThis.__sandboxForgetHooks || [];

const execFileAsync = promisify(execFile);
const __filename    = fileURLToPath(import.meta.url);
const __dirname     = path.dirname(__filename);

const PORT         = parseInt(process.env.SANDBOX_PORT || '4200', 10);
const SANDBOX_ROOT = '/fast/sandboxes';
const TOTAL_SLOTS  = 500;
const INACTIVE_TTL = 5 * 60 * 1000; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════
// SLOT POOL
// ═══════════════════════════════════════════════════════════════════════════

// ip → { slot, lastActive }
const sessions = new Map();
// slot_XXX → ip (reverse index)
const slotToIp = new Map();

function slotName(n) {
  return `slot_${String(n).padStart(3, '0')}`;
}

function slotPath(n) {
  return path.join(SANDBOX_ROOT, slotName(n));
}

function findFreeSlot() {
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    if (!slotToIp.has(slotName(i))) return i;
  }
  return null;
}

function assignSlot(ip) {
  // Already has a slot
  if (sessions.has(ip)) {
    const s = sessions.get(ip);
    s.lastActive = Date.now();
    return slotPath(s.slot);
  }
  const n = findFreeSlot();
  if (n === null) return null; // pool exhausted
  sessions.set(ip, { slot: n, lastActive: Date.now() });
  slotToIp.set(slotName(n), ip);
  console.log(`[Pool] Assigned ${slotName(n)} → ${ip}`);
  return slotPath(n);
}

function touchSession(ip) {
  if (sessions.has(ip)) sessions.get(ip).lastActive = Date.now();
}

async function wipeSlot(n) {
  const p = slotPath(n);
  for (const forget of globalThis.__sandboxForgetHooks) { try { forget(p); } catch {} }
  try {
    const entries = fs.readdirSync(p);
    for (const e of entries) {
      fs.rmSync(path.join(p, e), { recursive: true, force: true });
    }
  } catch {}
}

async function cleanupExpired() {
  const now = Date.now();
  for (const [ip, { slot, lastActive }] of sessions) {
    if (now - lastActive > INACTIVE_TTL) {
      console.log(`[Watchdog] Expiring ${slotName(slot)} (${ip})`);
      sessions.delete(ip);
      slotToIp.delete(slotName(slot));
      await wipeSlot(slot);
    }
  }
}

setInterval(cleanupExpired, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// JAIL
// ═══════════════════════════════════════════════════════════════════════════

function jailPath(sandboxDir, requestedPath) {
  const resolved = path.resolve(sandboxDir, requestedPath);
  if (!resolved.startsWith(sandboxDir + path.sep) && resolved !== sandboxDir) {
    throw new Error('Access denied — path outside sandbox');
  }
  return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL LOADER
// ═══════════════════════════════════════════════════════════════════════════

async function loadTools(server, sandboxDir, ip) {
  const dir = path.join(__dirname, 'sandbox_tools');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      const tool = mod.default;
      if (!tool?.name || typeof tool.handler !== 'function') continue;
      server.tool(
        tool.name,
        tool.description || '',
        tool.schema || {},
        async (args) => {
          touchSession(ip);
          // Resolve relative paths to absolute sandbox paths for original tools
          const resolvedArgs = { ...args };
          if (resolvedArgs.path !== undefined) {
            resolvedArgs.path = jailPath(sandboxDir, resolvedArgs.path);
          }
          const ctx = { sandboxDir, jailPath: (p) => jailPath(sandboxDir, p), execFileAsync };
          return globalThis.__sandboxCtx.run({
            slotDir: sandboxDir,
            architectDb: path.join(sandboxDir, '.architect.db'),
            stateDir: path.join(sandboxDir, '.read_file_state'),
          }, () => tool.handler(resolvedArgs, ctx));
        },
      );
    } catch (e) {
      console.warn(`[Loader] Skip ${file}: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Sessions are keyed by client IP, so the IP must not be spoofable. Only trust
// X-Forwarded-For when the request comes from our own reverse proxy on this
// host (loopback), and then take the LAST entry, the one the proxy appended.
// Port 4200 is firewalled, so outside clients can only arrive via the proxy.
function clientIp(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fromProxy = peer === '127.0.0.1' || peer === '::1';
  const xff = req.headers['x-forwarded-for'];
  if (fromProxy && xff) {
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return peer;
}

// ── Session create ──────────────────────────────────────────────────────────
app.get('/session/create', (req, res) => {
  const ip = clientIp(req);
  const sandboxDir = assignSlot(ip);
  if (!sandboxDir) {
    return res.status(503).json({ ok: false, error: 'No slots available — try again later' });
  }
  const used  = sessions.size;
  const free  = TOTAL_SLOTS - used;
  res.json({
    ok: true,
    ip,
    sandbox: sandboxDir,
    mcp_url: `http://${req.hostname}:${PORT}/mcp`,
    slots: { used, free, total: TOTAL_SLOTS },
    expires: '5 minutes of inactivity',
  });
});

// ── MCP endpoint ────────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  const ip = clientIp(req);
  const sandboxDir = assignSlot(ip);
  if (!sandboxDir) return res.status(503).json({ error: 'No slots available' });
  try {
    const server = new McpServer({
      name: 'itamos-sandbox',
      version: '1.1.0',
      capabilities: { tools: { listChanged: false } },
    });
    await loadTools(server, sandboxDir, ip);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { try { transport.close?.(); } catch {} });
  } catch (err) {
    console.error('[MCP] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.1.0',
    slots: { used: sessions.size, free: TOTAL_SLOTS - sessions.size, total: TOTAL_SLOTS },
  });
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
═══════════════════════════════════════════════════════════════
  Itamos MCP Sandbox Server v1.1.0
  PORT:         ${PORT}
  SLOTS:        ${TOTAL_SLOTS} pre-allocated ZFS datasets
  SANDBOX_ROOT: ${SANDBOX_ROOT}
  TTL:          5 minutes inactive
═══════════════════════════════════════════════════════════════
`);
});

process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
