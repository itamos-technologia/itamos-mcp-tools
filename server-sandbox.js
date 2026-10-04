// ═══════════════════════════════════════════════════════════════════════════
// Itamos MCP Sandbox Server (v1.1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pre-allocated ZFS slot pool — no sudo at runtime.
// 500 slots pre-created at /fast/sandboxes/slot_001 .. slot_500
// Identity → slot assignment in memory. On expiry: wipe slot contents, free slot.
//
// Identity: requests from the internet arrive through our reverse proxy and
// must carry an OAuth access token (anonymous OAuth, see oauth.js); the slot is
// chosen by the sandbox key behind that token. Hosted clients like claude.ai
// call from shared, rotating IPs, so the IP cannot identify a user. Direct
// local access (no proxy) keeps IP identity, for tests and local clients.
//
// Endpoints:
//   GET  /session/create  → local: assigns a slot by IP; public: how to connect
//   GET  /health          → pool status
//   POST /mcp             → MCP handler
//   OAuth: /.well-known/*, /register, /authorize, /token (oauth.js)
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
import { mountOAuth } from './oauth.js';

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
const SANDBOX_ROOT = process.env.SANDBOX_ROOT || '/fast/sandboxes';
const TOTAL_SLOTS  = parseInt(process.env.SANDBOX_TOTAL_SLOTS || '500', 10);
const DATA_DIR     = process.env.SANDBOX_DATA_DIR || null;   // defaults to ./data
const FULL_MESSAGE = 'Try again later: we are currently at full capacity.';
// Inactivity timeout: a sandbox untouched this long is wiped and its slot freed.
const TTL_MINUTES  = parseInt(process.env.SANDBOX_TTL_MINUTES || '10', 10);
const INACTIVE_TTL = TTL_MINUTES * 60 * 1000;
const TTL_TEXT     = `${TTL_MINUTES} minutes of inactivity`;

// ═══════════════════════════════════════════════════════════════════════════
// SLOT POOL
// ═══════════════════════════════════════════════════════════════════════════

// identity ("ip:<addr>" or "key:<sandbox key>") → { slot, lastActive }
const sessions = new Map();
// slot_XXX → identity (reverse index)
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

// Log-safe label: never print a full sandbox key.
function label(who) {
  return who.startsWith('key:') ? `key:${who.slice(4, 12)}…` : who;
}

function assignSlot(who) {
  // Already has a slot
  if (sessions.has(who)) {
    const s = sessions.get(who);
    s.lastActive = Date.now();
    return slotPath(s.slot);
  }
  const n = findFreeSlot();
  if (n === null) return null; // pool exhausted
  sessions.set(who, { slot: n, lastActive: Date.now() });
  slotToIp.set(slotName(n), who);
  console.log(`[Pool] Assigned ${slotName(n)} → ${label(who)}`);
  return slotPath(n);
}

function touchSession(who) {
  if (sessions.has(who)) sessions.get(who).lastActive = Date.now();
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
  for (const [who, { slot, lastActive }] of sessions) {
    if (now - lastActive > INACTIVE_TTL) {
      console.log(`[Watchdog] Expiring ${slotName(slot)} (${label(who)})`);
      sessions.delete(who);
      slotToIp.delete(slotName(slot));
      await wipeSlot(slot);
      // A login lives only as long as its sandbox: revoke its tokens too.
      if (who.startsWith('key:') && oauth.revokeSandbox(who.slice(4))) {
        console.log(`[OAuth] Revoked login of ${label(who)} with its sandbox`);
      }
    }
  }
  // Logins that never used a sandbox (or whose sandbox is gone) expire too.
  const idle = oauth.revokeIdle((key) => sessions.has(`key:${key}`), INACTIVE_TTL);
  if (idle) console.log(`[OAuth] Revoked ${idle} idle login(s) without a sandbox`);
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

async function loadTools(server, sandboxDir, who) {
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
          touchSession(who);
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
app.use(express.urlencoded({ extended: false }));   // OAuth /token and consent form
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id');
  res.header('Access-Control-Expose-Headers', 'WWW-Authenticate');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Sessions are keyed by client IP, so the IP must not be spoofable. Only trust
// X-Forwarded-For when the request comes from our own reverse proxy on this
// host (loopback), and then take the LAST entry, the one the proxy appended.
// Port 4200 is firewalled, so outside clients can only arrive via the proxy.
// The MCP URL to hand back to clients. Behind our reverse proxy that is the
// public origin with the proxy's scheme and no port (:PORT is firewalled from
// outside); direct local access keeps the http://host:PORT form.
// PUBLIC_MCP_URL overrides both.
function publicMcpUrl(req) {
  if (process.env.PUBLIC_MCP_URL) return process.env.PUBLIC_MCP_URL;
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const fromProxy = peer === '127.0.0.1' || peer === '::1';
  const proto = req.headers['x-forwarded-proto'];
  if (fromProxy && proto) return `${proto === 'https' ? 'https' : 'http'}://${req.hostname}/mcp`;
  return `http://${req.hostname}:${PORT}/mcp`;
}

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

// A request is public when it came in through our reverse proxy (the proxy is
// the only way in from outside: port PORT is firewalled).
function isPublic(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return (peer === '127.0.0.1' || peer === '::1') && !!req.headers['x-forwarded-for'];
}

// Public origin used in OAuth metadata. PUBLIC_BASE_URL overrides.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'];
  if (isPublic(req) && proto) return `${proto === 'https' ? 'https' : 'http'}://${req.hostname}`;
  return `http://${req.hostname}:${PORT}`;
}

const oauth = mountOAuth(app, {
  storePath: path.join(DATA_DIR || path.join(__dirname, 'data'), 'oauth.json'),
  baseUrl,
  // No new sandboxes while every slot is taken (existing holders keep theirs).
  isFull: () => findFreeSlot() === null,
  fullMessage: FULL_MESSAGE,
  ttlText: TTL_TEXT,
  clientIp,
});

// 503 for "no free slot", as a JSON-RPC error so MCP clients show the message.
function sendFull(req, res) {
  res.set('Retry-After', '120');
  res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: FULL_MESSAGE }, id: req.body?.id ?? null });
}

// ── Session create ──────────────────────────────────────────────────────────
app.get('/session/create', (req, res) => {
  if (isPublic(req)) {
    // No IP-based slots from the internet: hosted clients share IPs.
    return res.json({
      ok: true,
      mcp_url: publicMcpUrl(req),
      auth: 'oauth',
      how_to_connect: 'Add mcp_url as a connector in your MCP client. It opens a page where you create your sandbox with one click. No account needed.',
      expires: TTL_TEXT,
    });
  }
  const ip = clientIp(req);
  const sandboxDir = assignSlot(`ip:${ip}`);
  if (!sandboxDir) {
    res.set('Retry-After', '120');
    return res.status(503).json({ ok: false, error: FULL_MESSAGE });
  }
  const used  = sessions.size;
  const free  = TOTAL_SLOTS - used;
  res.json({
    ok: true,
    ip,
    sandbox: sandboxDir,
    mcp_url: publicMcpUrl(req),
    slots: { used, free, total: TOTAL_SLOTS },
    expires: TTL_TEXT,
  });
});

// ── MCP endpoint ────────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  let who;
  if (isPublic(req)) {
    const sandboxKey = oauth.authenticate(req);
    if (!sandboxKey) return oauth.challenge(req, res);
    who = `key:${sandboxKey}`;
  } else {
    who = `ip:${clientIp(req)}`;
  }
  const sandboxDir = assignSlot(who);
  if (!sandboxDir) return sendFull(req, res);
  try {
    const server = new McpServer({
      name: 'itamos-sandbox',
      version: '1.1.0',
      capabilities: { tools: { listChanged: false } },
    });
    await loadTools(server, sandboxDir, who);
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

// Sessions live only in memory, so after a restart no slot belongs to anyone.
// Wipe every non-empty slot at startup; otherwise the next user handed a slot
// would inherit the previous occupant's files and index. (The wipe uses sync
// fs calls, so it completes before the first request is served.)
(async () => {
  let wiped = 0;
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    try {
      if (fs.readdirSync(slotPath(i)).length) { await wipeSlot(i); wiped += 1; }
    } catch {}
  }
  if (wiped) console.log(`[Pool] Startup: wiped ${wiped} slot(s) left over from before the restart`);
})();

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
═══════════════════════════════════════════════════════════════
  Itamos MCP Sandbox Server v1.1.0
  PORT:         ${PORT}
  SLOTS:        ${TOTAL_SLOTS} pre-allocated ZFS datasets
  SANDBOX_ROOT: ${SANDBOX_ROOT}
  TTL:          ${TTL_MINUTES} minutes inactive
═══════════════════════════════════════════════════════════════
`);
});

process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
