/**
 * Web Skeletonizer — LLM-first web perception tool
 *
 * Gives eyeless LLMs structured perception of web pages.
 * Uses headless Chromium via Chrome DevTools Protocol (CDP).
 * Zero npm dependencies — only Node.js built-ins.
 *
 * Actions:
 *   search  {query}              → search results with title + one-line summary
 *   skeleton {url}               → structural skeleton of a page (headings, sections, links, forms)
 *                                  each element has: id, tag, label, action, position (% of viewport)
 *   read    {url, section}       → full text content of a specific section by id
 *   click   {url, element_id}    → simulate click / follow link, return new skeleton
 *
 * Design principles (same as Chain Reader):
 *   - Locality: act on the piece you need, don't ingest the whole page
 *   - Skeletonize everything: skeleton + segments + originals always preserved
 *   - Token efficiency: 97% reduction vs raw HTML
 *
 * Chromium binary: expects portable Chromium at ../web-skeleton/chromium/chrome
 * Falls back to system chrome if portable not found.
 *
 * License: All code in this file is original work by Itamos Technologia.
 */

import { z } from 'zod';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { logCost } from '../../mcp_tools/lib/cost_log.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Ollama AI titling for text-heavy sections ──
const OLLAMA_URL_SKEL = 'http://127.0.0.1:11434';
const AI_TITLE_MODEL_SKEL = 'gemma3:1b';
const AI_TITLE_MIN_SUMMARY = 80;

async function ollamaTitle(text, maxTokens = 50) {
  const http = await import('http');
  const prompt = `Read the following text and generate a short descriptive title (5-10 words maximum). Output ONLY the title, nothing else.\n\nText:\n${text.slice(0, 2000)}\n\nTitle:`;
  const payload = JSON.stringify({
    model: AI_TITLE_MODEL_SKEL, prompt, stream: false,
    options: { num_predict: maxTokens, temperature: 0.1 }
  });
  return new Promise((resolve) => {
    const req = http.default.request(OLLAMA_URL_SKEL + '/api/generate', {
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

async function aiTitleElements(data) {
  const TEXT_KINDS = new Set(['text', 'region', 'section', 'main', 'quote', 'item']);
  const candidates = data.elements.filter(el =>
    TEXT_KINDS.has(el.kind)
    && !el.label
    && el.summary
    && el.summary.length >= AI_TITLE_MIN_SUMMARY
  );
  if (candidates.length === 0) return;
  const toTitle = candidates.slice(0, 15);
  for (const el of toTitle) {
    const text = data.sections?.[el.id] || el.summary || '';
    if (text.length < AI_TITLE_MIN_SUMMARY) continue;
    const title = await ollamaTitle(text);
    if (title && title.length > 2 && title.length < 120) {
      el.label = title;
      el.aiTitled = true;
    }
  }
}
// ── URL VALIDATION ──────────────────────────────────────────────────────────
// Only https:// is allowed for public sites.
// http:// is permitted for local/private addresses only (dev servers).
// All other schemes (file://, chrome://, javascript:, data:// etc.) are blocked.

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }

  const scheme = parsed.protocol;
  if (scheme === 'https:') {
    if (process.env.WEB_SKELETON_PUBLIC_ONLY === '1' && isPrivateHost(parsed.hostname)) {
      throw new Error(`Blocked: ${parsed.hostname} is a local/private address, not reachable from this sandbox.`);
    }
    return;
  }

  if (scheme === 'http:') {
    const host = parsed.hostname;
    if (process.env.WEB_SKELETON_PUBLIC_ONLY === '1') {
      // Multi-tenant sandbox: http:// must still resolve to a public address, same as https.
      if (isPrivateHost(host)) {
        throw new Error(`Blocked: ${host} is a local/private address, not reachable from this sandbox.`);
      }
      return;
    }
    // Single-user / dev mode: http:// is also allowed for local/private addresses (dev servers).
    if (isPrivateHost(host)) return;
    throw new Error(`HTTP only allowed for local/private addresses. Got: ${host}. Use HTTPS for public sites.`);
  }

  throw new Error(`Blocked URL scheme: ${scheme} — only https:// and http:// (local only) are allowed.`);
}

// RFC1918 + loopback + link-local — used to gate local/private access in validateUrl().
function isPrivateHost(host) {
  if (host === 'localhost' || host === '127.0.0.1'
      || host === '[::1]' || host === '::1' || host === '0.0.0.0') return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.startsWith('169.254.')) return true;
  return false;
}



// ═══════════════════════════════════════════════════════════════════════════
// CHROMIUM MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const PORTABLE_CHROME = join(__dirname, 'chromium', 'chrome');
const SYSTEM_CHROMES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

let _chromeProcess = null;
let _cdpPort = 9200 + Math.floor(Math.random() * 800);
let _chromeBin = null;

function findChrome() {
  if (_chromeBin) return _chromeBin;
  if (existsSync(PORTABLE_CHROME)) {
    _chromeBin = PORTABLE_CHROME;
    return _chromeBin;
  }
  for (const p of SYSTEM_CHROMES) {
    if (existsSync(p)) {
      _chromeBin = p;
      return _chromeBin;
    }
  }
  throw new Error('No Chrome/Chromium binary found. Install portable Chromium in tools/web-skeleton/chromium/');
}

// ═══════════════════════════════════════════════════════════════════════════
// SANDBOX EGRESS GUARD
// ═══════════════════════════════════════════════════════════════════════════
// In the public sandbox (WEB_SKELETON_PUBLIC_ONLY=1) Chrome sends ALL traffic
// through this in-process proxy: page loads, redirects, iframes, background
// scripts, websockets. The proxy resolves each host itself, refuses private /
// loopback / link-local / metadata addresses, and connects to the exact address
// it checked, so DNS tricks (public name -> 127.0.0.1) and redirects can't
// reach services on this machine or its network.

let _egressProxyPort = null;

function _isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||           // 192.0.0.0/24, TEST-NET-1 (not 192.0.32.0/20 etc.)
      (a === 198 && (b === 18 || b === 19)) ||                     // benchmarking 198.18.0.0/15
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);  // TEST-NET-2/3
  }
  const x = String(ip).toLowerCase();
  if (x.startsWith('::ffff:')) return _isPrivateIp(x.slice(7));
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
}

async function _resolvePublic(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.promises.lookup(h, { all: true });
  if (!addrs.length || addrs.some((a) => _isPrivateIp(a.address))) return null;
  // Prefer IPv4 (this host may not route IPv6), keeping the rest as fallbacks.
  return [...addrs.filter((a) => net.isIPv4(a.address)), ...addrs.filter((a) => !net.isIPv4(a.address))].map((a) => a.address);
}

// Connect to the first reachable address from a vetted list.
function _connectFirst(ips, port, onConnect, onFail) {
  const [ip, ...rest] = ips;
  const sock = net.connect(port, ip, () => onConnect(sock));
  sock.once('error', () => { sock.destroy(); rest.length ? _connectFirst(rest, port, onConnect, onFail) : onFail(); });
}

function startEgressProxy() {
  if (_egressProxyPort) return Promise.resolve(_egressProxyPort);
  return new Promise((resolve, reject) => {
    const deny = (sock) => { try { sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); } catch {} };
    const srv = http.createServer(async (req, res) => {
      let u;
      try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
      if (u.protocol !== 'http:') { res.writeHead(403); return res.end(); }
      const ips = await _resolvePublic(u.hostname).catch(() => null);
      if (!ips) { res.writeHead(403); return res.end('blocked: private address'); }
      const ip = ips[0];
      const headers = { ...req.headers };
      delete headers['proxy-connection']; delete headers['proxy-authorization'];
      const up = http.request({ host: ip, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      req.pipe(up);
    });
    srv.on('connect', async (req, client, head) => {
      const m = String(req.url).match(/^(.*):(\d+)$/);
      const ips = m ? await _resolvePublic(m[1]).catch(() => null) : null;
      if (!ips) return deny(client);
      _connectFirst(ips, Number(m[2]), (up) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(client); client.pipe(up);
        up.on('error', () => client.destroy());
        client.on('error', () => up.destroy());
      }, () => deny(client));
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { _egressProxyPort = srv.address().port; resolve(_egressProxyPort); });
  });
}

// One isolated browser context (own tab, cookies, storage) per sandbox slot.
// Outside the sandbox the original single-tab behaviour is kept.
const _slotTargets = new Map();   // slotDir -> { targetId, contextId }

async function _browserSession() {
  const ver = await cdpRequest('/json/version');
  const b = new CDPSession(ver.webSocketDebuggerUrl);
  await b.connect();
  return b;
}

async function getPageTarget(create) {
  const slot = globalThis.__sandboxCtx?.getStore?.()?.slotDir;
  const targets = await cdpRequest('/json/list');
  if (!slot) {
    let t = targets.find((x) => x.type === 'page');
    if (!t && create) t = await cdpRequest('/json/new?about:blank');
    return t || null;
  }
  const known = _slotTargets.get(slot);
  if (known) {
    const t = targets.find((x) => x.id === known.targetId);
    if (t) return t;
    _slotTargets.delete(slot);
  }
  if (!create) return null;
  const b = await _browserSession();
  try {
    const { browserContextId } = await b.send('Target.createBrowserContext');
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
    _slotTargets.set(slot, { targetId, contextId: browserContextId });
  } finally {
    await b.close();
  }
  const fresh = await cdpRequest('/json/list');
  return fresh.find((x) => x.id === _slotTargets.get(slot).targetId) || null;
}

(globalThis.__sandboxForgetHooks ||= []).push((slotDir) => {
  const t = _slotTargets.get(slotDir);
  for (const k of [..._pageCache.keys()]) if (k.startsWith(slotDir + '|')) _pageCache.delete(k);
  if (!t) return;
  _slotTargets.delete(slotDir);
  _browserSession()
    .then(async (b) => { try { await b.send('Target.disposeBrowserContext', { browserContextId: t.contextId }); } catch {} await b.close(); })
    .catch(() => {});
});

async function ensureChrome() {
  if (_chromeProcess && !_chromeProcess.killed) {
    // Verify it's still responding
    try {
      await cdpRequest('/json/version');
      return;
    } catch {
      // Dead process, restart
      _chromeProcess.kill();
      _chromeProcess = null;
    }
  }

  const proxyArgs = process.env.WEB_SKELETON_PUBLIC_ONLY === '1'
    ? [`--proxy-server=http://127.0.0.1:${await startEgressProxy()}`, '--proxy-bypass-list=<-loopback>',
       '--force-webrtc-ip-handling-policy', '--webrtc-ip-handling-policy=disable_non_proxied_udp']
    : [];
  const bin = findChrome();
  _chromeProcess = spawn(bin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-first-run',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-component-extensions-with-background-pages',
    '--disable-popup-blocking',
    '--disable-background-timer-throttling',
    ...proxyArgs,
    `--user-data-dir=/tmp/web-skeleton-profile-${_cdpPort}`,
    `--remote-debugging-port=${_cdpPort}`,
    '--window-size=1920,1080',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    '--lang=en-US,en',
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  _chromeProcess.on('error', (err) => {
    console.error('[WebSkeleton] Chrome spawn error:', err.message);
    _chromeProcess = null;
  });

  _chromeProcess.on('exit', (code) => {
    console.log(`[WebSkeleton] Chrome exited with code ${code}`);
    _chromeProcess = null;
  });

  // Wait for CDP to become available
  await waitForCDP(10000);
}

async function waitForCDP(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await cdpRequest('/json/version');
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Chrome CDP not available after ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════
// CDP CLIENT (pure Node.js http + WebSocket)
// ═══════════════════════════════════════════════════════════════════════════

function cdpRequest(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1',
      port: _cdpPort,
      path,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    r.on('error', reject);
    r.setTimeout(5000, () => { r.destroy(); reject(new Error('CDP HTTP timeout')); });
    r.end();
  });
}

let _msgId = 0;

class CDPSession {
  constructor(wsUrl) {
    this._wsUrl = wsUrl;
    this._ws = null;
    this._pending = new Map();
    this._events = new Map();
  }

  async connect() {
    // Node.js 22 has global WebSocket
    this._ws = new WebSocket(this._wsUrl);
    await new Promise((resolve, reject) => {
      this._ws.onopen = resolve;
      this._ws.onerror = (e) => reject(new Error('WebSocket connection failed'));
      setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
    });

    this._ws.onmessage = (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
      if (msg.method) {
        const handlers = this._events.get(msg.method) || [];
        for (const h of handlers) h(msg.params);
      }
    };
  }

  send(method, params = {}) {
    const id = ++_msgId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(handler);
  }

  async close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE CACHE (keep skeletons in memory for read operations)
// ═══════════════════════════════════════════════════════════════════════════

const _pageCache = new Map();  // url → { skeleton, sections, timestamp }
const MAX_CACHE = 10;
const CACHE_TTL = 300000; // 5 minutes

function _slotKey(url) { return (globalThis.__sandboxCtx?.getStore?.()?.slotDir || '') + '|' + url; }

function cacheSet(url, data) {
  url = _slotKey(url);
  if (_pageCache.size >= MAX_CACHE) {
    // Evict oldest
    let oldest = null, oldestTime = Infinity;
    for (const [k, v] of _pageCache) {
      if (v.timestamp < oldestTime) { oldest = k; oldestTime = v.timestamp; }
    }
    if (oldest) _pageCache.delete(oldest);
  }
  _pageCache.set(url, { ...data, timestamp: Date.now() });
}

function cacheGet(url) {
  url = _slotKey(url);
  const entry = _pageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    _pageCache.delete(url);
    return null;
  }
  return entry;
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM WALKER (injected into page via Runtime.evaluate)
// ═══════════════════════════════════════════════════════════════════════════

const DOM_WALKER_SCRIPT = `
(() => {
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  const scrollH = document.documentElement.scrollHeight || vh;

  // Content elements only — what a user sees on the page
  const CONTENT = new Set([
    'H1','H2','H3','H4','H5','H6',
    'P','SECTION','ARTICLE','MAIN','ASIDE','NAV','HEADER','FOOTER',
    'UL','OL','LI','DL','DT','DD',
    'TABLE','TR','TH','TD',
    'A','BUTTON','IMG','VIDEO','AUDIO','FIGURE','FIGCAPTION',
    'BLOCKQUOTE','DETAILS','SUMMARY',
    'PRE'
  ]);

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','META','LINK','HEAD',
    'INPUT','TEXTAREA','SELECT','FORM','LABEL','FIELDSET','LEGEND']);

  let nextId = 1;
  const elements = [];
  const sections = {};

  function getLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const tag = el.tagName;
    if (tag === 'PRE' || tag === 'CODE') {
      // Detect language from class attribute (e.g. class="language-python", "hljs python")
      const cls = (el.className || '') + ' ' + ((el.querySelector('code') || {}).className || '');
      const langMatch = cls.match(/(?:language-|lang-|hljs\s+)(\w+)/);
      if (langMatch) return langMatch[1];
      // Count lines for summary
      const lineCount = (el.textContent || '').split('\\n').length;
      return lineCount + ' lines';
    }
    if (/^H[1-6]$/.test(tag) || tag === 'A' || tag === 'BUTTON' || tag === 'SUMMARY'
        || tag === 'LI' || tag === 'TH' || tag === 'TD' || tag === 'DT') {
      const txt = el.textContent || '';
      const clean = txt.replace(/\\\\s+/g, ' ').trim();
      return clean.length > 120 ? clean.slice(0, 117) + '...' : clean;
    }
    if (tag === 'IMG') return el.alt || '[image]';
    return '';
  }

  function getKind(el) {
    const tag = el.tagName;
    if (tag === 'PRE' || tag === 'CODE') {
      // Detect language from class attribute (e.g. class="language-python", "hljs python")
      const cls = (el.className || '') + ' ' + ((el.querySelector('code') || {}).className || '');
      const langMatch = cls.match(/(?:language-|lang-|hljs\s+)(\w+)/);
      if (langMatch) return langMatch[1];
      // Count lines for summary
      const lineCount = (el.textContent || '').split('\\n').length;
      return lineCount + ' lines';
    }
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'IMG') return 'image';
    if (tag === 'VIDEO') return 'video';
    if (tag === 'AUDIO') return 'audio';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'HEADER') return 'header';
    if (tag === 'FOOTER') return 'footer';
    if (tag === 'TABLE') return 'table';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'item';
    if (tag === 'SECTION' || tag === 'ARTICLE') return 'section';
    if (tag === 'MAIN') return 'main';
    if (tag === 'ASIDE') return 'sidebar';
    if (tag === 'DETAILS') return 'expandable';
    if (tag === 'SUMMARY') return 'summary';
    if (tag === 'PRE') return 'code';
    if (tag === 'BLOCKQUOTE') return 'quote';
    if (tag === 'FIGURE') return 'figure';
    if (tag === 'FIGCAPTION') return 'caption';
    if (tag === 'DL') return 'definitions';
    if (tag === 'DT') return 'term';
    if (tag === 'DD') return 'definition';
    if (tag === 'P') return 'text';
    if (tag === 'TR') return 'row';
    if (tag === 'TH') return 'column header';
    if (tag === 'TD') return 'cell';
    if (tag === 'DIV') return 'region';
    return 'element';
  }

  // Is this element clickable by a user?
  function isClickable(el) {
    const tag = el.tagName;
    if (tag === 'A' && el.getAttribute('href')) return true;
    if (tag === 'BUTTON') return true;
    if (tag === 'DETAILS' || tag === 'SUMMARY') return true;
    if (el.getAttribute('role') === 'button') return true;
    if (el.getAttribute('tabindex') !== null) return true;
    // Check for cursor pointer via computed style
    try {
      const style = window.getComputedStyle(el);
      if (style.cursor === 'pointer') return true;
    } catch {}
    return false;
  }

  // Where does clicking take you — user-visible description
  function getDestination(el) {
    const tag = el.tagName;
    if (tag === 'A') {
      const href = el.getAttribute('href') || '';
      if (href.startsWith('mailto:')) return 'email ' + href.slice(7);
      if (href.startsWith('tel:')) return 'call ' + href.slice(4);
      if (href.startsWith('#')) return 'scroll down';
      if (href) return href;
      return null;
    }
    if (tag === 'DETAILS') return el.open ? 'collapse' : 'expand';
    return null;
  }

  function getPosition(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round((rect.left / vw) * 1000) / 10,
      y: Math.round(((rect.top + window.scrollY) / scrollH) * 1000) / 10,
      w: Math.round((rect.width / vw) * 1000) / 10,
      h: Math.round((rect.height / scrollH) * 1000) / 10,
    };
  }

  function getFirstLine(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let text = '';
    while (walker.nextNode() && text.length < 200) {
      const val = walker.currentNode.textContent.trim();
      if (val) text += (text ? ' ' : '') + val;
    }
    text = text.replace(/\\\\s+/g, ' ').trim();
    return text.length > 150 ? text.slice(0, 147) + '...' : text;
  }

  // Extract table as pipe-delimited rows
  function getTableText(table) {
    const rows = [];
    const trList = table.querySelectorAll('tr');
    for (const tr of trList) {
      const cells = [];
      for (const cell of tr.querySelectorAll('th, td')) {
        const t = (cell.textContent || '').replace(/\\\\s+/g, ' ').trim();
        if (t) cells.push(t);
      }
      if (cells.length > 0) rows.push(cells.join(' | '));
    }
    return rows.join('\\\\n');
  }

  // Extract <pre>/<code> blocks as-is
  function getPreText(el) {
    return (el.textContent || '').trim();
  }

  function getFullText(el) {
    const tag = el.tagName;

    // Preserve raw code text as-is
    if (tag === 'PRE') return (el.textContent || '').trim();

    // Special handling for TABLE — direct children are THEAD/TBODY which are in SKIP
    if (tag === 'TABLE') {
      return getTableText(el);
    }

    const lines = [];
    function recurse(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.trim();
          if (t) lines.push(t);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const ctag = child.tagName;
          // Hard skip — never extract from these
          if (ctag === 'SCRIPT' || ctag === 'STYLE' || ctag === 'NOSCRIPT' || ctag === 'SVG'
              || ctag === 'META' || ctag === 'LINK' || ctag === 'HEAD') continue;

          // Tables — use table extractor
          if (ctag === 'TABLE') {
            const tt = getTableText(child);
            if (tt) lines.push(tt);
            continue;
          }

          // Pre/code — preserve as-is
          if (ctag === 'PRE' || ctag === 'CODE') {
            const pt = getPreText(child);
            if (pt) lines.push(pt);
            continue;
          }

          // Structural wrappers (THEAD, TBODY, FORM, etc.) — recurse through them
          if (ctag === 'THEAD' || ctag === 'TBODY' || ctag === 'TFOOT'
              || ctag === 'FORM' || ctag === 'FIELDSET' || ctag === 'LABEL'
              || ctag === 'INPUT' || ctag === 'TEXTAREA' || ctag === 'SELECT'
              || ctag === 'LEGEND') {
            recurse(child);
            continue;
          }

          const t = child.textContent?.trim();
          if (t) {
            if (/^H[1-6]$/.test(ctag)) lines.push('## ' + t);
            else if (ctag === 'LI') lines.push('- ' + t);
            else if (ctag === 'A') lines.push('[' + t + '](' + (child.href || '') + ')');
            else if (ctag === 'TR') {
              const cells = [];
              for (const c of child.querySelectorAll('th, td')) {
                const ct = (c.textContent || '').replace(/\\\\s+/g, ' ').trim();
                if (ct) cells.push(ct);
              }
              if (cells.length > 0) lines.push(cells.join(' | '));
            }
            else lines.push(t);
          }
        }
      }
    }
    recurse(el);
    return lines.join('\\\\n');
  }

  function walk(el, depth) {
    if (!el || !el.tagName || SKIP.has(el.tagName)) return;
    if (depth > 15) return;

    // Skip elements hidden by the page (modals, overlays, cookie banners, popups)
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
    } catch(e) {}

    const tag = el.tagName;
    const isContent = CONTENT.has(tag);

    if (tag === 'DIV') {
      const role = el.getAttribute('role');
      const id = el.id;
      const hasRole = role && role !== 'presentation' && role !== 'none';
      const hasSemanticId = id && !/^[0-9]/.test(id);
      if (!hasRole && !hasSemanticId) {
        for (const child of el.children) walk(child, depth);
        return;
      }
    }

    if (isContent || (tag === 'DIV')) {
      const eid = 'e' + (nextId++);
      const pos = getPosition(el);
      // Skip invisible elements
      if (pos.w === 0 && pos.h === 0) {
        for (const child of el.children) walk(child, depth);
        return;
      }
      const label = getLabel(el);
      const kind = getKind(el);
      const clickable = isClickable(el);
      const dest = clickable ? getDestination(el) : null;
      const summary = getFirstLine(el);

      const entry = {
        id: eid,
        kind,
        depth,
        label,
        summary,
        pos,
        clickable,
      };
      if (dest) entry.dest = dest;

      sections[eid] = getFullText(el);
      elements.push(entry);
    }

    for (const child of el.children) walk(child, depth + ((isContent || tag === 'DIV') ? 1 : 0));
  }

  walk(document.body, 0);

  return JSON.stringify({
    title: document.title || '',
    url: window.location.href,
    viewport: { width: vw, height: vh },
    pageHeight: scrollH,
    elementCount: elements.length,
    elements,
    sections,
  });
})()
`;


// ═══════════════════════════════════════════════════════════════════════════
// STEALTH PATCHES (injected before page JS to bypass bot detection)
// ═══════════════════════════════════════════════════════════════════════════

const STEALTH_SCRIPT = `
// Remove webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => false });

// Fake plugins array (real Chrome has at least PDF viewer)
Object.defineProperty(navigator, 'plugins', {
  get: () => [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ],
});

// Fake languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// Fix permissions query
const origQuery = window.Permissions?.prototype?.query;
if (origQuery) {
  window.Permissions.prototype.query = function(params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return origQuery.call(this, params);
  };
}

// Fake chrome runtime (headless lacks this)
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };

// Fix broken iframe contentWindow in headless
const origGetter = HTMLIFrameElement.prototype.__lookupGetter__('contentWindow');
if (origGetter) {
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: function() {
      const w = origGetter.call(this);
      if (w) {
        try { Object.defineProperty(w.navigator, 'webdriver', { get: () => false }); } catch {}
      }
      return w;
    },
  });
}

// Hardware fingerprint (realistic desktop values)
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

// Prevent headless detection via window dimensions
if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });

// Fake connection API (headless often lacks this)
if (!navigator.connection) {
  Object.defineProperty(navigator, 'connection', { get: () => ({
    effectiveType: '4g', downlink: 10, rtt: 50, saveData: false,
    addEventListener: () => {}, removeEventListener: () => {},
  })});
}

// WebGL vendor/renderer (avoid "SwiftShader" or "Google Inc." giveaways)
const getParamOrig = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(p) {
  if (p === 37445) return 'Intel Inc.';              // UNMASKED_VENDOR_WEBGL
  if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
  return getParamOrig.call(this, p);
};
try {
  const getParam2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return 'Intel Inc.';
    if (p === 37446) return 'Intel Iris OpenGL Engine';
    return getParam2.call(this, p);
  };
} catch {}

// Prevent automation detection via stack traces
const origToString = Error.prototype.toString;
const origStackGetter = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
// Hide headless-chrome paths from error stacks
if (origStackGetter && origStackGetter.get) {
  Object.defineProperty(Error.prototype, 'stack', {
    get: function() {
      const stack = origStackGetter.get.call(this);
      if (typeof stack === 'string') {
        return stack.replace(/headless/gi, '').replace(/puppeteer/gi, '');
      }
      return stack;
    }
  });
}

// Media devices (headless has none, real browsers report at least one)
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = async () => {
    const devices = await origEnumerate();
    if (devices.length === 0) {
      return [{ deviceId: 'default', kind: 'audioinput', label: '', groupId: 'default' }];
    }
    return devices;
  };
}
`;
// ═══════════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function actionSkeleton(url, viewport = { width: 1920, height: 1080 }, context = null, layout = null) {
  // Always check cache first — full data is always stored, context only filters display
  const cached = cacheGet(url);
  if (cached) {
    return formatSkeleton({
      title: cached.title || '',
      url: cached.url || url,
      viewport: { width: viewport.width, height: viewport.height },
      pageHeight: cached.pageHeight || 0,
      elementCount: cached.skeleton.length,
      elements: cached.skeleton,
      sections: cached.sections,
      rawBytes: cached.rawBytes || 0,
    }, viewport, context, layout);
  }

  // No cache — need to fetch the page
  await ensureChrome();

  const target = await getPageTarget(true);
  if (!target) throw new Error('could not open a browser tab');

  const session = new CDPSession(target.webSocketDebuggerUrl);
  await session.connect();

  try {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 768,
    });

    await session.send('Page.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: STEALTH_SCRIPT,
    });

    await session.send('Page.navigate', { url });

    await new Promise((resolve) => {
      session.on('Page.loadEventFired', resolve);
      setTimeout(resolve, 15000);
    });

    // Delay for JS rendering + Cloudflare challenge
    await sleep(3000);

    const titleCheck = await session.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const pageTitle = titleCheck.result.value || '';
    if (pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required')
        || pageTitle.includes('Access Denied')) {
      await sleep(5000);
    }

    const rawResult = await session.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML.length',
      returnByValue: true,
    });
    const rawBytes = rawResult.result.value || 0;

    const result = await session.send('Runtime.evaluate', {
      expression: DOM_WALKER_SCRIPT,
      returnByValue: true,
    });

    if (result.exceptionDetails) {
      throw new Error('DOM walker error: ' + JSON.stringify(result.exceptionDetails));
    }

    const data = JSON.parse(result.result.value);
    data.rawBytes = rawBytes;

    // Cache full skeleton + all sections
    cacheSet(url, {
      skeleton: data.elements,
      sections: data.sections,
      title: data.title,
      url: data.url,
      pageHeight: data.pageHeight,
      rawBytes,
    });

    // AI-title text-heavy sections for better navigation
    await aiTitleElements(data);

    return formatSkeleton(data, viewport, context, layout);
  } finally {
    await session.close();
  }
}

async function actionRead(url, sectionId) {
  const cached = cacheGet(url);
  if (!cached) {
    // Need to skeleton first
    await actionSkeleton(url);
    const cached2 = cacheGet(url);
    if (!cached2) throw new Error('Failed to cache page');
    if (!(sectionId in cached2.sections)) return `Section ${sectionId} not found. Available: ${Object.keys(cached2.sections).join(', ')}`;
    const text = cached2.sections[sectionId];
    return text || `[Section ${sectionId} exists but has no extractable text content]`;
  }
  if (!(sectionId in cached.sections)) return `Section ${sectionId} not found. Available: ${Object.keys(cached.sections).join(', ')}`;
  const text = cached.sections[sectionId];
  return text || `[Section ${sectionId} exists but has no extractable text content]`;
}

async function actionClick(url, elementId, viewport = { width: 1920, height: 1080 }) {
  await ensureChrome();

  const target = await getPageTarget(false);
  if (!target) throw new Error('No browser tab open. Run skeleton first.');

  const session = new CDPSession(target.webSocketDebuggerUrl);
  await session.connect();

  try {
    // Set viewport
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 768,
    });

    // The tab may have moved on since the skeleton was taken (an earlier
    // click, or a skeleton answered from cache without reloading). Element ids
    // are only valid for the page they came from, so make sure the tab shows
    // that page before resolving the id.
    if (url) {
      const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '');
      const here = await session.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      if (norm(here?.result?.value) !== norm(url)) {
        validateUrl(url);
        await session.send('Page.enable');
        const loaded = new Promise((resolve) => { session.on('Page.loadEventFired', resolve); setTimeout(resolve, 15000); });
        await session.send('Page.navigate', { url });
        await loaded;
        await sleep(1500);
      }
    }

    // Find the element by re-walking the DOM with the same id counter,
    // then scroll into view and click
    const clickScript = `(() => {
      const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','META','LINK','HEAD']);
      const STRUCTURAL = new Set([
        'H1','H2','H3','H4','H5','H6',
        'P','SECTION','ARTICLE','MAIN','ASIDE','NAV','HEADER','FOOTER',
        'UL','OL','LI','DL','DT','DD',
        'TABLE','THEAD','TBODY','TR','TH','TD',
        'FORM','INPUT','BUTTON','SELECT','TEXTAREA',
        'A','IMG','VIDEO','AUDIO','FIGURE','FIGCAPTION',
        'BLOCKQUOTE','PRE','CODE','DETAILS','SUMMARY'
      ]);
      let nextId = 1;

      function findEl(el) {
        if (!el || !el.tagName || SKIP.has(el.tagName)) return null;
        const tag = el.tagName;
        let isStructural = STRUCTURAL.has(tag);
        if (tag === 'DIV') {
          const role = el.getAttribute('role');
          const id = el.id;
          isStructural = (role && role !== 'presentation' && role !== 'none')
                      || (id && !/^[0-9]/.test(id));
        }
        if (isStructural) {
          const eid = 'e' + (nextId++);
          if (eid === '${elementId}') return el;
        }
        if (!isStructural && tag === 'DIV') {
          // Walk children of non-semantic divs without incrementing
        }
        for (const child of el.children) {
          const found = findEl(child);
          if (found) return found;
        }
        return null;
      }

      const el = findEl(document.body);
      if (!el) return JSON.stringify({ error: 'Element ${elementId} not found' });

      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      el.click();

      return JSON.stringify({
        clicked: '${elementId}',
        kind: (() => { const t = el.tagName; if (t === "A") return "link"; if (t === "BUTTON") return "button"; if (/^H[1-6]$/.test(t)) return "heading"; return t.toLowerCase(); })(),
        destination: el.tagName === "A" ? (el.getAttribute("href") || "") : null,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100)
      });
    })()`;

    const clickResult = await session.send('Runtime.evaluate', {
      expression: clickScript,
      returnByValue: true,
    });

    const clickData = JSON.parse(clickResult.result.value);
    if (clickData.error) throw new Error(clickData.error);

    // Wait for potential navigation or DOM update
    await sleep(2000);

    // Check current URL
    const locResult = await session.send('Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true,
    });
    const newUrl = locResult.result.value;

    // Re-run DOM walker on the updated/new page
    const walkerResult = await session.send('Runtime.evaluate', {
      expression: DOM_WALKER_SCRIPT,
      returnByValue: true,
    });

    if (walkerResult.exceptionDetails) {
      throw new Error('DOM walker error after click: ' + JSON.stringify(walkerResult.exceptionDetails));
    }

    const data = JSON.parse(walkerResult.result.value);

    // Update cache with new URL
    cacheSet(newUrl, {
      skeleton: data.elements,
      sections: data.sections,
    });

    // Format with click context
    const header = [];
    header.push(`CLICKED: [${clickData.clicked}] ${clickData.kind} "${clickData.text}"`);
    if (newUrl !== url) {
      header.push(`NAVIGATED: ${url} → ${newUrl}`);
    } else {
      header.push('PAGE: same (DOM may have updated)');
    }

    return header.join('\n') + '\n' + formatSkeleton(data, viewport);
  } finally {
    await session.close();
  }
}

async function actionSearch(query) {
  await ensureChrome();

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const target = await getPageTarget(true);
  if (!target) throw new Error('could not open a browser tab');

  const session = new CDPSession(target.webSocketDebuggerUrl);
  await session.connect();

  try {
    await session.send('Page.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SCRIPT });
    await session.send('Page.navigate', { url: searchUrl });

    await new Promise((resolve) => {
      session.on('Page.loadEventFired', resolve);
      setTimeout(resolve, 15000);
    });
    await sleep(2000);

    // Extract search results directly from DuckDuckGo HTML structure
    const extractScript = `(() => {
      const results = [];
      // DuckDuckGo HTML results are in .result elements
      const items = document.querySelectorAll('.result');
      for (const item of items) {
        const linkEl = item.querySelector('.result__a');
        const snippetEl = item.querySelector('.result__snippet');
        const urlEl = item.querySelector('.result__url');
        if (!linkEl) continue;

        const title = (linkEl.textContent || '').replace(/\\s+/g, ' ').trim();
        let href = linkEl.getAttribute('href') || '';
        // DuckDuckGo wraps URLs in redirect — extract the real URL
        const uddgMatch = href.match(/uddg=([^&]+)/);
        if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);

        const snippet = snippetEl ? snippetEl.textContent.replace(/\\s+/g, ' ').trim() : '';
        const displayUrl = urlEl ? urlEl.textContent.replace(/\\s+/g, ' ').trim() : '';

        if (title) {
          results.push({ title, url: href, displayUrl, snippet });
        }
      }
      return JSON.stringify(results);
    })()`;

    const result = await session.send('Runtime.evaluate', {
      expression: extractScript,
      returnByValue: true,
    });

    const searchResults = JSON.parse(result.result.value || '[]');

    // Format as clean list: number, title, one-line summary, URL
    const lines = [];
    lines.push(`SEARCH: "${query}"`);
    lines.push(`RESULTS: ${searchResults.length}`);
    lines.push('---');

    for (let i = 0; i < searchResults.length; i++) {
      const r = searchResults[i];
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(`    ${r.displayUrl || r.url}`);
      if (r.snippet) lines.push(`    ${r.snippet}`);
      lines.push('');
    }

    // Token stats
    const rawResult = await session.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML.length',
      returnByValue: true,
    });
    const rawBytes = rawResult.result.value || 0;
    const output = lines.join('\n');
    const rawTokens = Math.round(rawBytes / 4);
    const skelTokens = Math.round(output.length / 4);
    const savings = rawTokens > 0 ? Math.round((1 - skelTokens / rawTokens) * 100) : 0;
    try { logCost("web_skeleton", rawTokens, skelTokens); } catch{}

    lines.push('---');
    lines.push(`TOKENS: ~${skelTokens.toLocaleString()} (raw page: ~${rawTokens.toLocaleString()}) | saved: ${savings}% | ${rawTokens > 0 ? (rawTokens / skelTokens).toFixed(1) : '?'}x smaller`);

    return lines.join('\n');
  } finally {
    await session.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FORMAT HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function formatSkeleton(data, viewport, context = null, layout = null) {
  const lines = [];
  lines.push(`PAGE: ${data.title}`);
  lines.push(`URL: ${data.url}`);
  lines.push(`VIEWPORT: ${viewport.width}x${viewport.height} scrollH:${data.pageHeight}`);

  const elements = data.elements;

  if (!context) {
    // ── Smart collapse: pre-scan for collapsible regions ──────────────
    const COLLAPSE_KINDS = new Set(['navigation', 'footer']);
    const collapseMap = new Map();

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const base = el.depth;
      let type = null;

      if (COLLAPSE_KINDS.has(el.kind)) {
        type = el.kind === 'navigation' ? 'nav' : 'footer';
      } else if ((el.kind === 'button' || el.kind === 'summary') && el.clickable) {
        if (i + 1 < elements.length && elements[i + 1].depth > base) {
          type = 'dropdown';
        }
      }

      if (!type) continue;

      let items = 0, links = 0, endIdx = i;
      for (let j = i + 1; j < elements.length; j++) {
        if (elements[j].depth <= base) break;
        endIdx = j;
        if (elements[j].kind === 'item') items++;
        if (elements[j].kind === 'link' || (elements[j].clickable && elements[j].dest)) links++;
      }

      const children = endIdx - i;
      if (children >= 3) {
        collapseMap.set(i, { type, items, links, endIdx });
      }
    }

    // ── Code block collapse: PRE elements with >3 lines ─────────────
    for (let i = 0; i < elements.length; i++) {
      if (collapseMap.has(i)) continue;
      const el = elements[i];
      if (el.kind !== 'code' && !/^\d+ lines$/.test(el.label || '')) continue;
      const text = data.sections?.[el.id] || '';
      const lineCount = text.split('\n').length;
      if (lineCount > 3) {
        let codeEnd = i;
        for (let j = i + 1; j < elements.length; j++) {
          if (elements[j].depth <= el.depth) break;
          codeEnd = j;
        }
        collapseMap.set(i, { type: 'code', items: lineCount, links: 0, endIdx: codeEnd });
      }
    }

    // ── Render pass ──────────────────────────────────────────────────
    let skipUntil = -1;
    let collapsed = 0;

    lines.push(`ELEMENTS: ${elements.length}`);
    lines.push('---');

    for (let i = 0; i < elements.length; i++) {
      if (i <= skipUntil) continue;

      const el = elements[i];
      const indent = '  '.repeat(el.depth);
      const click = el.clickable ? '●' : '○';
      const info = collapseMap.get(i);

      if (info) {
        const count = info.type === 'dropdown' ? info.items || info.links
                    : info.type === 'code' ? info.items
                    : info.links || info.items;
        const unit  = info.type === 'code' ? 'lines'
                    : info.type === 'dropdown' ? 'items'
                    : 'links';
        const posStr = (layout === 'all' || layout === el.id) ? ` @${el.pos.x}%,${el.pos.y}%` : '';
        let labelStr;
        if (info.type === 'code') {
          const lang = (el.label && !/^\d+ lines$/.test(el.label)) ? el.label : '';
          labelStr = lang ? ` "${lang}"` : '';
        } else {
          labelStr = ` "${el.label || el.kind}"`;
        }
        lines.push(`${indent}${click} [${el.id}] ${info.type}${labelStr} (${count} ${unit})${posStr} — read [${el.id}] to expand`);
        skipUntil = info.endIdx;
        collapsed += (info.endIdx - i);
        continue;
      }

      // Normal element
      let line = `${indent}${click} [${el.id}] ${el.kind}`;
      if (el.label) line += ` "${el.label}"`;
      if (el.dest) line += ` → ${el.dest}`;
      if (layout === 'all' || layout === el.id) line += ` @${el.pos.x}%,${el.pos.y}%`;
      // Summary only for leaf elements — parents' children show the content
      const hasChildren = (i + 1 < elements.length && elements[i + 1].depth > el.depth);
      if (!hasChildren && el.summary && el.summary !== el.label && el.summary.length > 5) {
        line += `\n${indent}  └ ${el.summary}`;
      }
      lines.push(line);
    }

    if (collapsed > 0) {
      lines.push(`(${collapsed} elements collapsed — use read [id] to expand any section)`);
    }

  } else {
    // ── Context filter — only expand sections matching search terms ───
    const terms = context.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    lines.push(`CONTEXT: "${context}"`);

    const matchSet = new Set();
    for (const el of elements) {
      const haystack = [
        el.label || '',
        el.summary || '',
        data.sections?.[el.id] || '',
      ].join(' ').toLowerCase();

      const hits = terms.filter(t => haystack.includes(t)).length;
      if (hits > 0) matchSet.add(el.id);
    }

    const parentIds = new Set();
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (matchSet.has(el.id) || parentIds.has(el.id)) {
        for (let j = i - 1; j >= 0; j--) {
          if (elements[j].depth < el.depth) {
            parentIds.add(elements[j].id);
            break;
          }
        }
      }
    }

    lines.push(`MATCHES: ${matchSet.size} of ${data.elementCount} elements`);
    lines.push('---');

    for (const el of elements) {
      const isMatch = matchSet.has(el.id);
      const isParent = parentIds.has(el.id);
      const indent = '  '.repeat(el.depth);
      const click = el.clickable ? '●' : '○';

      if (isMatch) {
        let line = `${indent}${click} [${el.id}] ${el.kind}`;
        if (el.label) line += ` "${el.label}"`;
        if (el.dest) line += ` → ${el.dest}`;
        if (layout === 'all' || layout === el.id) line += ` @${el.pos.x}%,${el.pos.y}%`;
        line += ' ★';
        if (el.summary && el.summary !== el.label) {
          line += `\n${indent}  └ ${el.summary}`;
        }
        lines.push(line);
      } else if (isParent) {
        let line = `${indent}${click} [${el.id}] ${el.kind}`;
        if (el.label) line += ` "${el.label}"`;
        if (layout === 'all' || layout === el.id) line += ` @${el.pos.x}%,${el.pos.y}%`;
        lines.push(line);
      } else if (el.kind === 'heading') {
        let line = `${indent}  [${el.id}] ${el.kind}`;
        if (el.label) line += ` "${el.label}"`;
        if (layout === 'all' || layout === el.id) line += ` @${el.pos.x}%,${el.pos.y}%`;
        lines.push(line);
      }
    }
  }

  // Token stats footer
  const output = lines.join('\n');
  const rawTokens = Math.round((data.rawBytes || 0) / 4);
  const skelTokens = Math.round(output.length / 4);
  const savings = rawTokens > 0 ? Math.round((1 - skelTokens / rawTokens) * 100) : 0;
  const ratio = rawTokens > 0 ? (rawTokens / skelTokens).toFixed(1) : '?';
  try { logCost("web_skeleton", rawTokens, skelTokens); } catch{}

  const stats = [
    '---',
    `TOKENS: ~${skelTokens.toLocaleString()} (raw page: ~${rawTokens.toLocaleString()}) | saved: ${savings}% | ${ratio}x smaller`,
  ].join('\n');

  return output + '\n' + stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP TOOL EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export default {
  name: 'web_skeleton',
  description: 'Web page skeletonizer — LLM-first web perception. '
    + 'Actions: skeleton (parse page structure, optional context to filter), read (get section text), click (interact with element), search (web search via skeleton). '
    + '97% token reduction vs raw HTML.',
  schema: {
    action: z.enum(['skeleton', 'read', 'click', 'search']).describe(
      'skeleton: parse a URL into structural skeleton with element positions. Use context to filter for relevant sections only. '
      + 'read: get full text of a section by id (requires prior skeleton). '
      + 'click: click an element by id, triggers navigation/action, returns new skeleton. '
      + 'search: perform web search, return results as skeleton.'
    ),
    url: z.string().optional().describe('URL to skeletonize or read from'),
    context: z.string().optional().describe('Search context to filter skeleton — only sections matching these terms are expanded, rest collapsed to headings'),
    section: z.string().optional().describe('Section id to read (from skeleton output, e.g. "e5")'),
    element: z.string().optional().describe('Element id to click (from skeleton output, e.g. "e12")'),
    query: z.string().optional().describe('Search query (for action=search)'),
    layout: z.string().optional().describe('Show element positions. "all" = every element, or an element id like "e5" for just that subtree. Omit for no positions (default).'),
  },
  async handler(args, ctx) {
    try {
      let result;

      switch (args.action) {
        case 'skeleton':
          if (!args.url) throw new Error('url required for skeleton action');
          validateUrl(args.url);
          result = await actionSkeleton(args.url, undefined, args.context || null, args.layout || null);
          break;

        case 'read':
          if (!args.url) throw new Error('url required for read action');
          if (!args.section) throw new Error('section required for read action');
          validateUrl(args.url);
          result = await actionRead(args.url, args.section);
          break;

        case 'click':
          if (!args.url) throw new Error('url required for click action');
          if (!args.element) throw new Error('element required for click action');
          validateUrl(args.url);
          result = await actionClick(args.url, args.element);
          break;

        case 'search':
          if (!args.query) throw new Error('query required for search action');
          result = await actionSearch(args.query, ctx);
          break;

        default:
          throw new Error(`Unknown action: ${args.action}`);
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `[WebSkeleton Error] ${err.message}` }] };
    }
  },
};

// Cleanup on process exit
process.on('exit', () => {
  if (_chromeProcess && !_chromeProcess.killed) {
    _chromeProcess.kill();
  }
});
