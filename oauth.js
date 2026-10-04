// ═══════════════════════════════════════════════════════════════════════════
// Anonymous OAuth 2.1 for the public sandbox
// ═══════════════════════════════════════════════════════════════════════════
//
// Hosted MCP clients (claude.ai and other cloud agents) call from shared,
// rotating egress IPs, so the client IP cannot identify a user. Instead every
// user gets a sandbox identity through a standard OAuth flow that needs no
// account: the "login" page has a single "Create my sandbox" button.
//
//   discovery     GET  /.well-known/oauth-protected-resource[/mcp]   (RFC 9728)
//                 GET  /.well-known/oauth-authorization-server       (RFC 8414)
//   registration  POST /register                                     (RFC 7591)
//   authorize     GET  /authorize  -> consent page
//                 POST /authorize  -> redirect back with a one-time code
//   token         POST /token      (authorization_code + PKCE S256,
//                                   refresh_token with rotation)
//
// An access token maps to a random sandbox key and the server picks the slot
// by that key. Clients and tokens are stored HASHED in a small JSON file so
// they survive restarts (the slots themselves never do). Authorization codes
// and pending consent requests are short-lived and kept in memory only.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ACCESS_TTL_S   = 60 * 60;             // 1 hour
const REFRESH_TTL_S  = 30 * 24 * 60 * 60;   // 30 days
const CODE_TTL_MS    = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_CLIENTS    = 10000;
const SCOPE          = 'sandbox';
const AUTH_METHODS   = ['none', 'client_secret_post', 'client_secret_basic'];

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sha256b64url = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function okRedirectUri(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
  } catch { return false; }
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2433;--muted:#5b6474;--accent:#2563eb;--line:rgba(127,127,127,.35)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#181c24;--fg:#e7ebf2;--muted:#9aa3b2;--accent:#5b8cff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{background:var(--card);max-width:440px;width:calc(100% - 32px);padding:28px;border-radius:14px;
  box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.3rem;margin:0 0 8px}
p,ul{color:var(--muted);margin:0 0 16px}
ul{padding-left:20px}
.row{display:flex;flex-direction:row-reverse;gap:10px}
button{flex:1;padding:12px;border-radius:10px;font-size:1rem;cursor:pointer}
.go{background:var(--accent);color:#fff;border:0}
.no{background:transparent;color:var(--muted);border:1px solid var(--line)}`;

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main class="card">${body}</main></body></html>`;
}

// The approve button comes first in the markup so that pressing Enter creates
// the sandbox; row-reverse puts it on the right visually.
function consentHtml(clientName, requestId, ttlText) {
  return shell('Itamos MCP Sandbox', `
<h1>Create your sandbox</h1>
<p><strong>${esc(clientName)}</strong> wants to connect to an Itamos MCP sandbox.</p>
<ul>
  <li>No account or sign-up needed.</li>
  <li>You get a private workspace with code tools: read_file, write_file, master_architect, git and web_skeleton.</li>
  <li>Your sandbox and its files are deleted after ${esc(ttlText)}. After that, connect again to get a new one.</li>
  <li><strong>Demonstration service:</strong> don't put anything sensitive or confidential in the sandbox. It is built for trying the tools, not for private data.</li>
</ul>
<form method="post" action="/authorize">
  <input type="hidden" name="request_id" value="${esc(requestId)}">
  <div class="row">
    <button class="go" name="decision" value="approve">Create my sandbox</button>
    <button class="no" name="decision" value="deny">Cancel</button>
  </div>
</form>`);
}

function errorPage(res, status, title, message) {
  res.status(status).set('Cache-Control', 'no-store')
    .send(shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`));
}

function redirectWith(res, redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  res.redirect(302, u.toString());
}

/**
 * Mount the OAuth endpoints on an express app.
 *   storePath  JSON file for registered clients and hashed tokens
 *   baseUrl    (req) => public origin, e.g. "https://mcp.itamos-technologia.com"
 * Returns { authenticate(req) -> sandboxKey|null, challenge(req, res) }.
 */
export function mountOAuth(app, {
  storePath, baseUrl,
  isFull = () => false,
  fullMessage = 'At full capacity, try again later.',
  ttlText = '10 minutes of inactivity',
  clientIp = (req) => req.socket.remoteAddress || '',
}) {
  // One sandbox per network (IP) during the alpha. The consent page is the one
  // request that comes from the user's own browser, so its IP is the real one.
  // The same browser (cookie) may reconnect and resumes its own sandbox.
  // Kept in memory only: IPs are never written to disk.
  const ipOwner = new Map();   // ip -> { sandboxKey, browserId }
  const onePerIpMessage = `A sandbox is already active from your network. During the alpha it is one sandbox per connection. Try again after it has had ${ttlText}.`;
  // ── persistent store ─────────────────────────────────────────────────────
  let store = { clients: {}, tokens: {} };
  try { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch {}
  store.clients = store.clients || {};
  store.tokens = store.tokens || {};

  function save() {
    const now = Date.now();
    for (const [h, t] of Object.entries(store.tokens)) if (t.expires < now) delete store.tokens[h];
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
  }

  function pruneClients() {
    // Drop the least recently used half when the cap is reached.
    const list = Object.entries(store.clients).sort((a, b) => a[1].last_used - b[1].last_used);
    for (const [id] of list.slice(0, Math.ceil(list.length / 2))) delete store.clients[id];
  }

  function getCookie(req, name) {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ── short-lived, in memory ───────────────────────────────────────────────
  const pending = new Map();   // request_id -> consent request
  const codes = new Map();     // sha256(code) -> grant
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
  }, 60 * 1000).unref();

  function issueTokens(clientId, sandboxKey) {
    const access = `sba_${rand()}`;
    const refresh = `sbr_${rand()}`;
    const now = Date.now();
    store.tokens[sha256hex(access)] = { type: 'access', sandboxKey, clientId, issued: now, expires: now + ACCESS_TTL_S * 1000 };
    store.tokens[sha256hex(refresh)] = { type: 'refresh', sandboxKey, clientId, issued: now, expires: now + REFRESH_TTL_S * 1000 };
    save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
  }

  // ── discovery ────────────────────────────────────────────────────────────
  const resourceMetadata = (req) => ({
    resource: `${baseUrl(req)}/mcp`,
    authorization_servers: [baseUrl(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Itamos MCP Sandbox',
  });
  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json(resourceMetadata(req)));
  app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => res.json(resourceMetadata(req)));
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const b = baseUrl(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/authorize`,
      token_endpoint: `${b}/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      scopes_supported: [SCOPE],
    });
  });

  // ── dynamic client registration ──────────────────────────────────────────
  app.post('/register', (req, res) => {
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || uris.length > 10 ||
        !uris.every((u) => typeof u === 'string' && u.length <= 2000 && okRedirectUri(u))) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be https URLs (or http://localhost)',
      });
    }
    const method = b.token_endpoint_auth_method || 'client_secret_basic';
    if (!AUTH_METHODS.includes(method)) {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: `unsupported token_endpoint_auth_method: ${method}`,
      });
    }
    if (Object.keys(store.clients).length >= MAX_CLIENTS) pruneClients();
    const clientId = `sbc_${rand(18)}`;
    const clientSecret = method === 'none' ? null : rand();
    const name = String(b.client_name || 'An MCP client').slice(0, 100);
    store.clients[clientId] = {
      redirect_uris: uris, name, method,
      secret_hash: clientSecret ? sha256hex(clientSecret) : null,
      created: Date.now(), last_used: Date.now(),
    };
    save();
    console.log(`[OAuth] Registered client ${clientId.slice(0, 10)}… "${name}"`);
    res.status(201).json({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ── authorization (consent page, no account) ─────────────────────────────
  app.get('/authorize', (req, res) => {
    const q = req.query;
    const client = store.clients[String(q.client_id || '')];
    if (!client) {
      return errorPage(res, 400, 'Unknown client',
        'This connection request is not valid. Remove the connector and add it again.');
    }
    let redirectUri = q.redirect_uri ? String(q.redirect_uri) : '';
    if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      // Never redirect to an address the client did not register.
      return errorPage(res, 400, 'Invalid redirect', 'The return address does not match this client.');
    }
    const state = q.state ? String(q.state) : undefined;
    if (q.response_type !== 'code') return redirectWith(res, redirectUri, { error: 'unsupported_response_type', state });
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return redirectWith(res, redirectUri, {
        error: 'invalid_request', error_description: 'PKCE with S256 is required', state,
      });
    }
    const chk = ipCheck(req);
    if (!chk.ok) return errorPage(res, 429, 'Sandbox already active', onePerIpMessage);
    if (!chk.replace && isFull()) {
      res.set('Retry-After', '120');
      return errorPage(res, 503, 'At full capacity', fullMessage);
    }
    if (!getCookie(req, 'sbid')) {
      res.cookie('sbid', rand(18), {
        httpOnly: true, sameSite: 'lax', path: '/', maxAge: 24 * 3600 * 1000,
        secure: req.headers['x-forwarded-proto'] === 'https',
      });
    }
    const requestId = rand(24);
    pending.set(requestId, {
      clientId: String(q.client_id), redirectUri, state,
      codeChallenge: String(q.code_challenge), expires: Date.now() + PENDING_TTL_MS,
    });
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'");
    res.set('Cache-Control', 'no-store');
    res.send(consentHtml(client.name, requestId, ttlText));
  });

  app.post('/authorize', (req, res) => {
    const requestId = String(req.body?.request_id || '');
    const p = pending.get(requestId);
    pending.delete(requestId);
    if (!p || p.expires < Date.now()) {
      return errorPage(res, 400, 'Request expired',
        'This request has expired. Go back to your app and connect again.');
    }
    if (req.body.decision !== 'approve') {
      return redirectWith(res, p.redirectUri, { error: 'access_denied', state: p.state });
    }
    const chk = ipCheck(req);
    if (!chk.ok) return errorPage(res, 429, 'Sandbox already active', onePerIpMessage);
    if (!chk.replace && isFull()) {
      res.set('Retry-After', '120');
      return errorPage(res, 503, 'At full capacity', fullMessage);
    }
    const code = rand();
    // Same browser reconnecting before its sandbox expired: resume that sandbox
    // (same key, same slot, files kept) with fresh tokens; the old ones end.
    const sandboxKey = chk.replace || `sbk_${rand(24)}`;
    if (chk.replace) revokeSandbox(chk.replace);
    ipOwner.set(chk.ip, { sandboxKey, browserId: getCookie(req, 'sbid') });
    codes.set(sha256hex(code), {
      clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge,
      sandboxKey, expires: Date.now() + CODE_TTL_MS,
    });
    console.log(`[OAuth] ${chk.replace ? 'Resumed' : 'New'} sandbox identity ${sandboxKey.slice(0, 8)}… for "${store.clients[p.clientId]?.name}"`);
    redirectWith(res, p.redirectUri, { code, state: p.state });
  });

  // ── token endpoint ───────────────────────────────────────────────────────
  function authenticateClient(req) {
    let id = req.body?.client_id;
    let secret = req.body?.client_secret;
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const raw = Buffer.from(h.slice(6), 'base64').toString();
      const i = raw.indexOf(':');
      try {
        id = decodeURIComponent((i < 0 ? raw : raw.slice(0, i)).replace(/\+/g, ' '));
        secret = i < 0 ? '' : decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' '));
      } catch { return null; }
    }
    const client = store.clients[String(id || '')];
    if (!client) return null;
    if (client.secret_hash && !(secret && safeEqual(sha256hex(secret), client.secret_hash))) return null;
    return { id: String(id), client };
  }

  app.post('/token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    const b = req.body || {};
    const c = authenticateClient(req);
    if (!c) return res.status(401).json({ error: 'invalid_client' });

    if (b.grant_type === 'authorization_code') {
      const key = sha256hex(b.code || '');
      const grant = codes.get(key);
      codes.delete(key);   // one use only, even if this attempt fails
      if (!grant || grant.expires < Date.now() || grant.clientId !== c.id) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      if (b.redirect_uri && b.redirect_uri !== grant.redirectUri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      if (!b.code_verifier || !safeEqual(sha256b64url(b.code_verifier), grant.codeChallenge)) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      c.client.last_used = Date.now();
      return res.json(issueTokens(c.id, grant.sandboxKey));
    }

    if (b.grant_type === 'refresh_token') {
      const key = sha256hex(b.refresh_token || '');
      const t = store.tokens[key];
      if (!t || t.type !== 'refresh' || t.expires < Date.now() || t.clientId !== c.id) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      delete store.tokens[key];   // rotation: each refresh token works once
      c.client.last_used = Date.now();
      return res.json(issueTokens(c.id, t.sandboxKey));
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // ── revocation: a login lives only as long as its sandbox ────────────────
  function revokeSandbox(sandboxKey) {
    let n = 0;
    for (const [h, t] of Object.entries(store.tokens)) {
      if (t.sandboxKey === sandboxKey) { delete store.tokens[h]; n += 1; }
    }
    for (const [k, g] of codes) if (g.sandboxKey === sandboxKey) codes.delete(k);
    for (const [ip, o] of ipOwner) if (o.sandboxKey === sandboxKey) ipOwner.delete(ip);
    if (n) save();
    return n;
  }

  // An identity is alive while it has a token, or a code not yet exchanged.
  function identityAlive(sandboxKey) {
    for (const t of Object.values(store.tokens)) if (t.sandboxKey === sandboxKey) return true;
    for (const g of codes.values()) if (g.sandboxKey === sandboxKey && g.expires > Date.now()) return true;
    return false;
  }

  // { ok, ip, replace? }: ok=false when another browser on this IP already
  // holds a live sandbox; replace=<old key> when this same browser reconnects.
  function ipCheck(req) {
    const ip = clientIp(req);
    const owner = ipOwner.get(ip);
    if (!owner || !identityAlive(owner.sandboxKey)) { ipOwner.delete(ip); return { ok: true, ip }; }
    const browserId = getCookie(req, 'sbid');
    if (browserId && browserId === owner.browserId) return { ok: true, ip, replace: owner.sandboxKey };
    return { ok: false, ip };
  }

  // Revoke identities that hold no sandbox (never used one, or theirs was
  // wiped) and got no new token within ttlMs.
  function revokeIdle(isActive, ttlMs) {
    const now = Date.now();
    const newest = new Map();
    for (const t of Object.values(store.tokens)) {
      newest.set(t.sandboxKey, Math.max(newest.get(t.sandboxKey) || 0, t.issued || 0));
    }
    let revoked = 0;
    for (const [key, issued] of newest) {
      if (!isActive(key) && now - issued > ttlMs) { revokeSandbox(key); revoked += 1; }
    }
    return revoked;
  }

  // ── resource-server side ─────────────────────────────────────────────────
  return {
    revokeSandbox,
    revokeIdle,
    // Returns the sandbox key behind a valid access token, else null.
    authenticate(req) {
      const h = req.headers.authorization || '';
      if (!h.startsWith('Bearer ')) return null;
      const t = store.tokens[sha256hex(h.slice(7).trim())];
      if (!t || t.type !== 'access' || t.expires < Date.now()) return null;
      return t.sandboxKey;
    },
    // 401 that tells MCP clients where to start the OAuth flow.
    challenge(req, res) {
      const meta = `${baseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
      const hadToken = (req.headers.authorization || '').startsWith('Bearer ');
      res.set('WWW-Authenticate',
        `Bearer ${hadToken ? 'error="invalid_token", ' : ''}resource_metadata="${meta}"`);
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required: add this server as a connector to create your sandbox.' },
        id: null,
      });
    },
  };
}
