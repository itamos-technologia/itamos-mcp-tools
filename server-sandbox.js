// ═══════════════════════════════════════════════════════════════════════════
// Itamos MCP Sandbox Server (v1.1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pre-allocated ZFS slot pool — no sudo at runtime.
// 500 slots pre-created at /fast/sandboxes/slot_001 .. slot_500
// Identity → slot assignment in memory, taken on the first tool call. On
// expiry: wipe slot contents, free slot. The login stays valid, so the next
// tool call gets a new, empty sandbox. When every slot is taken, tool calls
// wait in a queue and a freed slot goes straight to the front of it.
//
// Identity: requests from the internet arrive through our reverse proxy and
// must carry an OAuth access token (anonymous OAuth, see oauth.js); the slot is
// chosen by the sandbox key behind that token. Hosted clients like claude.ai
// call from shared, rotating IPs, so the IP cannot identify a user. Direct
// local access (no proxy) keeps IP identity, for tests and local clients.
//
// Endpoints:
//   GET  /session/create  → local: assigns a slot by IP; public: how to connect
//   GET  /health          → pool status and queue length
//   POST /mcp             → MCP handler
//   OAuth: /.well-known/*, /register, /authorize, /token (oauth.js)
//
// ═══════════════════════════════════════════════════════════════════════════

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';
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

// ── Waiting queue ─────────────────────────────────────────────────────────
// Connecting never needs a slot; a slot is taken when a tool is first called.
// When every slot is taken, that tool call joins the queue instead (in memory
// only). A freed slot goes straight to the front of the queue: the sandbox is
// created at once, its queue entry ends, and its normal inactivity clock starts.
const waitQueue = new Map();   // identity → time it joined (Map keeps arrival order)
const releases  = [];          // times slots were freed recently (for the wait estimate)
const notices   = new Map();   // identity → one-time note shown with its next tool result
const expiredAt = new Map();   // identity → when its last sandbox expired
const LOGIN_MAX_MS = 30 * 24 * 60 * 60 * 1000;   // refresh tokens last 30 days (oauth.js)

// ── "Sandbox ready" email (optional, asked for on the consent page) ─────────
// Sent once, when the sandbox is created from the queue. The address is kept
// in memory only, never written to disk or logs, and deleted when the email is
// sent or after 24 hours. The text is fixed: it never includes anything the
// client chose (such as its registered name), so nobody can use it to put
// their own words in an email from our address.
const notifyEmails   = new Map();   // identity → { email, added }
const NOTIFY_KEEP_MS = 24 * 60 * 60 * 1000;
const MAIL_PER_HOUR  = 60;          // server-wide cap
const mailTimes      = [];
const MAIL_HELPER    = path.join(__dirname, 'notify_email.py');
const READY_MAIL_BODY = [
  'Your Itamos MCP sandbox is ready.',
  '',
  'Go back to the AI app you connected from and keep working: your next tool call uses it.',
  `The sandbox is deleted after ${TTL_TEXT}, so use it soon. If it has expired by then, your next tool call starts a new one (through the queue if all sandboxes are in use).`,
  '',
  'You get this one-time message because you asked for it when connecting. Your email address has now been deleted from our server.',
  '',
  'Itamos Technologia',
  'https://mcp.itamos-technologia.com',
].join('\n');

function sendReadyEmail(who) {
  const n = notifyEmails.get(who);
  if (!n) return;
  notifyEmails.delete(who);
  const now = Date.now();
  while (mailTimes.length && now - mailTimes[0] > 60 * 60 * 1000) mailTimes.shift();
  if (mailTimes.length >= MAIL_PER_HOUR) {
    console.warn(`[Mail] Hourly cap reached; ready email for ${label(who)} not sent`);
    return;
  }
  mailTimes.push(now);
  const child = spawn('python3', [MAIL_HELPER], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 60000 });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => console.warn(`[Mail] Could not start sender: ${e.message}`));
  child.on('close', (code) => {
    if (code === 0) console.log(`[Mail] Ready email sent for ${label(who)}`);
    else console.warn(`[Mail] Ready email for ${label(who)} failed: ${err.trim() || `exit ${code}`}`);
  });
  child.stdin.end(JSON.stringify({ to: n.email, subject: 'Your Itamos MCP sandbox is ready', body: READY_MAIL_BODY }));
}

function giveSlot(who, n) {
  sessions.set(who, { slot: n, lastActive: Date.now() });
  slotToIp.set(slotName(n), who);
  console.log(`[Pool] Assigned ${slotName(n)} → ${label(who)}`);
  if (expiredAt.has(who)) {
    expiredAt.delete(who);
    notices.set(who, `Note: your previous sandbox was deleted after ${TTL_TEXT}. This is a new, empty sandbox.`);
  }
}

// Hand free slots to the front of the queue, in arrival order.
function drainQueue() {
  for (const [who, joined] of waitQueue) {
    const n = findFreeSlot();
    if (n === null) return;
    waitQueue.delete(who);
    giveSlot(who, n);
    const note = notices.get(who);
    notices.set(who, `Your sandbox is ready (you waited in the queue).${note ? ` ${note}` : ''}`);
    console.log(`[Queue] ${label(who)} left the queue after ${Math.round((Date.now() - joined) / 1000)}s`);
    sendReadyEmail(who);
  }
}

// Estimated wait from how often slots were freed in the last hour.
function waitEstimate(position) {
  const now = Date.now();
  while (releases.length && now - releases[0] > 60 * 60 * 1000) releases.shift();
  if (releases.length < 3) return 'not known yet';
  const msPerSlot = (now - releases[0]) / releases.length;
  const min = Math.max(1, Math.ceil((position * msPerSlot) / 60000));
  return `about ${min} minute${min === 1 ? '' : 's'}`;
}

function queueMessage(position) {
  return `${FULL_MESSAGE} You are in position ${position} in the queue; estimated wait: ${waitEstimate(position)}. `
    + 'Your sandbox is created automatically when a slot frees up, so you can keep working and try again later.';
}

// { dir } when `who` has (or just got) a sandbox, else { position } in the queue.
function requestSlot(who) {
  const s = sessions.get(who);
  if (s) { s.lastActive = Date.now(); return { dir: slotPath(s.slot) }; }
  if (!waitQueue.size) {
    const n = findFreeSlot();
    if (n !== null) { giveSlot(who, n); return { dir: slotPath(n) }; }
  }
  if (!waitQueue.has(who)) {
    waitQueue.set(who, Date.now());
    console.log(`[Queue] ${label(who)} joined at position ${waitQueue.size}`);
  }
  drainQueue();
  const got = sessions.get(who);
  if (got) return { dir: slotPath(got.slot) };
  return { position: [...waitQueue.keys()].indexOf(who) + 1 };
}

// Local /session/create: a directory, or null while queued.
function assignSlot(who) {
  return requestSlot(who).dir || null;
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
      releases.push(Date.now());
      notices.delete(who);
      // The login stays valid: its next tool call gets a new, empty sandbox
      // (through the queue when every slot is taken).
      if (who.startsWith('key:')) expiredAt.set(who, now);
    }
  }
  if (releases.length > 1000) releases.splice(0, releases.length - 1000);
  for (const [who, t] of expiredAt) if (now - t > LOGIN_MAX_MS) expiredAt.delete(who);
  // Email addresses never used within 24 hours are deleted.
  for (const [who, n] of notifyEmails) if (now - n.added > NOTIFY_KEEP_MS) notifyEmails.delete(who);
  // Freed slots go to the front of the queue right away.
  drainQueue();
}

setInterval(cleanupExpired, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// JAIL
// ═══════════════════════════════════════════════════════════════════════════

function jailPath(sandboxDir, requestedPath) {
  const deny = () => { throw new Error('Access denied — path outside sandbox'); };
  const resolved = path.resolve(sandboxDir, requestedPath);
  if (!resolved.startsWith(sandboxDir + path.sep) && resolved !== sandboxDir) deny();
  // The text check alone is not enough: a symlink inside the sandbox (e.g. from
  // a cloned repo) can point anywhere. Find the deepest part of the path that
  // exists (lstat, so a dangling link still counts as existing) and check where
  // it really lives. A link that cannot be resolved is refused.
  let probe = resolved;
  for (;;) {
    try { fs.lstatSync(probe); break; }
    catch { const up = path.dirname(probe); if (up === probe) deny(); probe = up; }
  }
  let real, rootReal;
  try { real = fs.realpathSync(probe); rootReal = fs.realpathSync(sandboxDir); }
  catch { deny(); }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) deny();
  return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL LOADER
// ═══════════════════════════════════════════════════════════════════════════

// Tools are registered without a slot, so connecting and listing tools always
// work. The slot is taken (or the queue joined) when a tool is called.
async function loadTools(server, who) {
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
          const slot = requestSlot(who);
          if (!slot.dir) {
            return { isError: true, content: [{ type: 'text', text: queueMessage(slot.position) }] };
          }
          const sandboxDir = slot.dir;
          // Resolve relative paths to absolute sandbox paths for original tools
          const resolvedArgs = { ...args };
          if (resolvedArgs.path !== undefined) {
            resolvedArgs.path = jailPath(sandboxDir, resolvedArgs.path);
          }
          const ctx = { sandboxDir, jailPath: (p) => jailPath(sandboxDir, p), execFileAsync };
          const result = await globalThis.__sandboxCtx.run({
            slotDir: sandboxDir,
            architectDb: path.join(sandboxDir, '.architect.db'),
            stateDir: path.join(sandboxDir, '.read_file_state'),
          }, () => tool.handler(resolvedArgs, ctx));
          // One-time note (sandbox ready after the queue, or a new sandbox
          // after expiry) goes in front of the first result it can join.
          const note = notices.get(who);
          if (note && Array.isArray(result?.content)) {
            notices.delete(who);
            return { ...result, content: [{ type: 'text', text: note }, ...result.content] };
          }
          return result;
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
  // Connecting is always allowed; when full, the consent page says so and the
  // first tool call joins the queue.
  busyNote: () => (findFreeSlot() === null || waitQueue.size
    ? 'All sandboxes are in use right now. You can still connect: your sandbox is created automatically when a slot frees up, and your tools will tell you your place in the queue.'
    : null),
  // One sandbox per network: a network counts as busy while its identity
  // holds a sandbox or a queue place (oauth.js adds recent logins).
  isActive: (key) => sessions.has(`key:${key}`) || waitQueue.has(`key:${key}`),
  activeWindowMs: INACTIVE_TTL,
  // Optional "email me when ready" (in memory only; see sendReadyEmail).
  onNotifyEmail: (key, email) => notifyEmails.set(`key:${key}`, { email, added: Date.now() }),
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
// No slot is needed here: connecting and listing tools always work. Each tool
// call takes the sandbox (or a queue place) itself, see loadTools().
app.post('/mcp', async (req, res) => {
  let who;
  if (isPublic(req)) {
    const sandboxKey = oauth.authenticate(req);
    if (!sandboxKey) return oauth.challenge(req, res);
    who = `key:${sandboxKey}`;
  } else {
    who = `ip:${clientIp(req)}`;
  }
  try {
    const server = new McpServer({
      name: 'itamos-sandbox',
      version: '1.1.0',
      capabilities: { tools: { listChanged: false } },
    });
    await loadTools(server, who);
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
    queue: waitQueue.size,
  });
});

// ── ZFS requirement ─────────────────────────────────────────────────────────
// Every slot must be its own ZFS dataset with a hard size limit (quota) and
// compression. A plain folder has neither, so one user could fill the disk for
// everyone. Checked once at startup, before any slot is touched; the server
// refuses to start otherwise. Create the slots with scripts/create-slots.sh.
function verifyZfsSlots() {
  let rows;
  try {
    rows = execFileSync('zfs', ['list', '-H', '-p', '-t', 'filesystem', '-o', 'mountpoint,quota,compression'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    return [`cannot run "zfs list" (${e.code || e.message.split('\n')[0]}): is ZFS installed?`];
  }
  const byMount = new Map();
  for (const line of rows.split('\n')) {
    const [mount, quota, compression] = line.split('\t');
    if (mount) byMount.set(mount, { quota: Number(quota) || 0, compression });
  }
  const problems = [];
  for (let i = 1; i <= TOTAL_SLOTS && problems.length < 5; i++) {
    const p = slotPath(i);
    const ds = byMount.get(p);
    if (!ds) problems.push(`${p} is not a ZFS dataset`);
    else if (!ds.quota) problems.push(`${p} has no quota`);
    else if (!ds.compression || ds.compression === 'off') problems.push(`${p} has compression off`);
  }
  return problems;
}
{
  const problems = verifyZfsSlots();
  if (problems.length) {
    console.error('[Pool] ZFS check failed: every slot must be a ZFS dataset with a quota and compression.\n  - '
      + problems.join('\n  - ') + '\nCreate the slots with scripts/create-slots.sh, then start again.');
    process.exit(1);
  }
  console.log(`[Pool] ZFS check passed: ${TOTAL_SLOTS} slots are datasets with a quota and compression`);
}

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
