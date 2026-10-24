/**
 * Web Skeletonizer — LLM-first web perception tool
 *
 * Gives eyeless LLMs structured perception of web pages.
 * Uses headless Chromium via Chrome DevTools Protocol (CDP).
 * Zero npm dependencies — only Node.js built-ins (code maps reuse the
 * master-architect segmenter, see code_view.js).
 *
 * Actions (the tool remembers the current page per sandbox; read, click and
 * skeleton use it when no url is given):
 *   search   {query}            → results r1, r2 ...; click r3 opens result 3
 *   skeleton {url?, context?}   → map of the page: element ids (e5 ...), ● clickable, ○ content
 *   read     {section}          → text of one element; a code block (e12) gives its parts,
 *                                 a part (e12.3) its code, like read_file
 *   click    {element}          → click e12 on the current page, or open search result r3
 *   home                        → close the current page; next step is search or skeleton
 *
 * Design principles (same as Chain Reader):
 *   - Locality: act on the piece you need, don't ingest the whole page
 *   - Skeletonize everything: skeleton + segments + originals always preserved
 *   - Token efficiency: a map instead of raw HTML
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
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, readlinkSync, rmSync } from 'node:fs';
import { homedir, freemem } from 'node:os';
import { createHash } from 'node:crypto';
import { logCost } from '../../mcp_tools/lib/cost_log.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotateCode, parseCodeAddress, readCode } from './code_view.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Summarizer: titles for text-heavy sections ──
// Any OpenAI-compatible chat endpoint: the Itamos LLM router (:8090, which spreads
// requests over the GPUs by token budget), a single llama-server, or Ollama.
// Set ITAMOS_SUMMARIZER_URL to an empty string to turn titling off.
const SUMMARIZER_URL_SKEL = (process.env.ITAMOS_SUMMARIZER_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '');
// Model name to send; llama-server ignores it, Ollama needs one (e.g. gemma3:4b).
const SUMMARIZER_MODEL_SKEL = process.env.ITAMOS_SUMMARIZER_MODEL || 'summarizer';
const AI_TITLE_MIN_SUMMARY = 80;

// A short title for a text-heavy section from the summarizer, or null if it is off,
// unreachable or slow (the section then keeps its own first line). Only the start of
// the section is sent (TITLE_MAX_CHARS, about 2,000 tokens): plenty for a title, and
// a huge section no longer keeps the GPUs busy while searches wait.
const TITLE_MAX_CHARS = 8000;
async function summarizeTitle(text, maxTokens = 50) {
  if (!SUMMARIZER_URL_SKEL) return null;
  const prompt = `Read the following text and generate a short descriptive title (5-10 words maximum). Output ONLY the title, nothing else.\n\nText:\n${text.slice(0, TITLE_MAX_CHARS)}\n\nTitle:`;
  try {
    const res = await fetch(SUMMARIZER_URL_SKEL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SUMMARIZER_MODEL_SKEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens, temperature: 0.1,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const out = data.choices?.[0]?.message?.content || '';
    return out.trim().split('\n')[0]?.trim().replace(/^["*]+|["*]+$/g, '') || null;
  } catch {
    return null;
  }
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
  await Promise.all(toTitle.map(async (el) => {
    const text = data.sections?.[el.id] || el.summary || '';
    if (text.length < AI_TITLE_MIN_SUMMARY) return;
    const title = await summarizeTitle(text);
    if (title && title.length > 2 && title.length < 120) {
      el.label = title;
      el.aiTitled = true;
    }
  }));
}

// ── Embedder: every segment of the page, searched by meaning ──
// After titling, the page's segments are embedded (EmbeddingGemma through the
// Itamos LLM router :8091, or any OpenAI-compatible /v1/embeddings endpoint).
// An innermost segment (paragraph, item, cell, code block ...) is embedded whole;
// a segment that contains others is embedded by its label and first line, since
// its children carry the rest of its text, so every part of the page is embedded
// once. A text longer than the model's limit (2048 tokens) is cut into pieces by
// the model's own tokenizer, all pointing back to the same segment.
// Vectors are kept with the cached page (768 dimensions, 8-bit), so later
// searches on the page only embed the search itself.
// Set ITAMOS_EMBEDDER_URL to an empty string to turn this off (search then
// matches words only).
const EMBEDDER_URL_SKEL = (process.env.ITAMOS_EMBEDDER_URL ?? 'http://127.0.0.1:8091').replace(/\/$/, '');
const EMBEDDER_MODEL_SKEL = process.env.ITAMOS_EMBEDDER_MODEL || 'embeddinggemma';
const EMBED_DIMS = 768;             // all of EmbeddingGemma's dimensions (256 lost real matches)
const EMBED_PIECE_TOKENS = 1800;    // under the model's 2048, leaving room for the title
const EMBED_SURE_CHARS = 600;       // a text this short is always under the limit
const EMBED_BATCH_CHARS = 24000;    // about 6-8k tokens per request
const EMBED_PARALLEL = 6;           // requests in flight (the router spreads them over the GPUs)
// A segment is a match when it stands out from the rest of THIS page (each page
// has its own background similarity) and is close to the best one.
const MEANING_Z = 2.5;              // standard deviations above the page's average
const MEANING_SPREAD = 0.1;         // within this of the best match
const MEANING_MAX = 10;
// Vector format: 2 = each segment embedded with its section heading as context.
const EMBED_FORMAT = process.env.WEB_SKELETON_EMBED_CONTEXT === '0' ? 1 : 2;
// Meaning candidates are checked by the summarizer (one call per search) when it is on.
const RERANK_ON = process.env.WEB_SKELETON_RERANK !== '0';
const RERANK_CANDIDATES = 20;

async function _embedPost(path, body, timeout = 60000) {
  const res = await fetch(EMBEDDER_URL_SKEL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`embedder ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Run fn over items, at most `n` at a time.
async function _pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

// A text as pieces under the model's limit: short texts (the usual case) are one
// piece; a long one is cut by the model's own tokenizer.
async function _pieces(text) {
  if (text.length <= EMBED_SURE_CHARS) return [text];
  const tokens = (await _embedPost('/tokenize', { content: text })).tokens || [];
  if (tokens.length <= EMBED_PIECE_TOKENS) return [text];
  const out = [];
  for (let i = 0; i < tokens.length; i += EMBED_PIECE_TOKENS) {
    const d = await _embedPost('/detokenize', { tokens: tokens.slice(i, i + EMBED_PIECE_TOKENS) });
    if (d.content) out.push(d.content);
  }
  return out;
}

// First EMBED_DIMS dimensions, unit length, 8-bit, base64 (compact in the page cache).
function _packVec(vec) {
  const v = vec.slice(0, EMBED_DIMS);
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((v[i] / n) * 127)));
  return Buffer.from(q.buffer).toString('base64');
}
function _unpackVec(s) {
  const b = Buffer.from(s, 'base64');
  return new Int8Array(b.buffer, b.byteOffset, b.length);
}

// Embed every segment of a page: { model, dims, ms, segments, ids: { eN: [vec, ...] } },
// or null when the embedder is off or fails (the page still renders; search then
// matches words only).
async function embedElements(data) {
  if (!EMBEDDER_URL_SKEL) return null;
  const t0 = Date.now();
  const els = data.elements || [];
  const unique = new Map();   // same title + text is embedded once (repeated links, menus)
  let heading = '';           // the section a segment sits in: the last heading before it
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const hasChildren = i + 1 < els.length && els[i + 1].depth > el.depth;
    const body = ((hasChildren ? el.summary : (data.sections?.[el.id] || el.summary)) || '').trim();
    const label = (el.label || '').trim();
    if (el.kind === 'heading' && label) heading = label;
    // With context, a paragraph under "Hallucination" is embedded as part of that section.
    const title = EMBED_FORMAT === 2 && heading && heading !== label ? [heading, label].filter(Boolean).join(' › ') : label;
    if (!title && !body) continue;
    const key = title + '\u0000' + body;
    if (!unique.has(key)) unique.set(key, { title, body, ids: [] });
    unique.get(key).ids.push(el.id);
  }
  const jobs = [...unique.values()];
  try {
    const inputs = [];          // { job, text }
    await _pool(jobs, 16, async (job) => {
      const pieces = job.body ? await _pieces(job.body) : [job.title];
      for (const p of pieces) inputs.push({ job, text: `title: ${job.title || 'none'} | text: ${p}` });
    });
    const batches = [];
    let cur = [], len = 0;
    for (const inp of inputs) {
      if (cur.length && len + inp.text.length > EMBED_BATCH_CHARS) { batches.push(cur); cur = []; len = 0; }
      cur.push(inp); len += inp.text.length;
    }
    if (cur.length) batches.push(cur);
    const ids = {};
    await _pool(batches, EMBED_PARALLEL, async (batch) => {
      const d = await _embedPost('/v1/embeddings', { model: EMBEDDER_MODEL_SKEL, input: batch.map((b) => b.text) });
      d.data.forEach((row, k) => {
        const packed = _packVec(row.embedding);
        for (const id of batch[k].job.ids) (ids[id] = ids[id] || []).push(packed);
      });
    });
    return { model: EMBEDDER_MODEL_SKEL, dims: EMBED_DIMS, format: EMBED_FORMAT, ms: Date.now() - t0, segments: Object.keys(ids).length, ids };
  } catch (e) {
    console.error('[web_skeleton] embedding skipped:', e.message);
    return null;
  }
}

// The summarizer reads the best candidates and keeps the ones that really answer
// the search: one call per search, short texts. Returns the kept ids in order,
// [] when none fits, or null when it is off or fails (then the scores decide).
async function rerankCandidates(query, candidates, data) {
  if (!RERANK_ON || !SUMMARIZER_URL_SKEL || !candidates.length) return null;
  const els = new Map((data?.elements || []).map((e) => [e.id, e]));
  const list = candidates.map((c, k) => {
    const el = els.get(c.id) || {};
    const text = [el.label, data?.sections?.[c.id] || el.summary].filter(Boolean).join(' — ').replace(/\s+/g, ' ').slice(0, 300);
    return `${k + 1}. ${text || '(no text)'}`;
  }).join('\n');
  const prompt = `A user searches a web page for: "${query.slice(0, 300)}"\n\n`
    + `Passages from the page:\n${list}\n\n`
    + 'Which passages answer the search or are directly about it? Reply with their numbers only, '
    + 'best first, separated by commas, or "none".';
  try {
    const res = await fetch(SUMMARIZER_URL_SKEL + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SUMMARIZER_MODEL_SKEL, messages: [{ role: 'user', content: prompt }], max_tokens: 40, temperature: 0 }),
      signal: AbortSignal.timeout(5000),   // busy summarizer: fall back to the scores, don't keep the user waiting
    });
    if (!res.ok) return null;
    const out = ((await res.json()).choices?.[0]?.message?.content || '').toLowerCase();
    if (/\bnone\b/.test(out) && !/\d/.test(out)) return [];
    const picked = [];
    for (const m of out.matchAll(/\d+/g)) {
      const c = candidates[Number(m[0]) - 1];
      if (c && !picked.includes(c.id)) picked.push(c.id);
    }
    return picked.length ? picked : null;
  } catch {
    return null;
  }
}

// Segments closest in meaning to the search: [{ id, score }], best first, or null.
async function meaningMatches(vectors, query, data = null) {
  if (!EMBEDDER_URL_SKEL || !vectors?.ids) return null;
  try {
    const d = await _embedPost('/v1/embeddings', {
      model: EMBEDDER_MODEL_SKEL, input: `task: search result | query: ${query.slice(0, 1000)}`,
    }, 15000);
    const q = d.data[0].embedding.slice(0, vectors.dims || EMBED_DIMS);
    let qn = 0; for (const x of q) qn += x * x; qn = Math.sqrt(qn) || 1;
    const scored = [];
    for (const [id, vecs] of Object.entries(vectors.ids)) {
      let best = -1;
      for (const s of vecs) {
        const v = _unpackVec(s);
        let dot = 0, vn = 0;
        for (let i = 0; i < v.length; i++) { dot += q[i] * v[i]; vn += v[i] * v[i]; }
        const score = dot / (qn * (Math.sqrt(vn) || 1));
        if (score > best) best = score;
      }
      scored.push({ id, score: best });
    }
    if (!scored.length) return [];
    const mean = scored.reduce((a, m) => a + m.score, 0) / scored.length;
    const sd = Math.sqrt(scored.reduce((a, m) => a + (m.score - mean) ** 2, 0) / scored.length) || 1;
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0].score;
    const kept = await rerankCandidates(query, scored.slice(0, RERANK_CANDIDATES), data);
    if (kept) {
      const byId = new Map(scored.map((m) => [m.id, m]));
      return kept.slice(0, MEANING_MAX).map((id) => ({ ...byId.get(id), checked: true }));
    }
    return scored
      .map((m) => ({ ...m, z: (m.score - mean) / sd }))
      .filter((m) => m.z >= MEANING_Z && m.score >= top - MEANING_SPREAD)
      .slice(0, MEANING_MAX);
  } catch (e) {
    console.error('[web_skeleton] meaning search skipped:', e.message);
    return null;
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

// ── Chrome's own files go to disk, never to RAM ──
// (/tmp is a RAM disk on many Linux servers.) One profile folder is reused across
// restarts; if another running Chrome already holds it (Chrome locks its profile),
// a temporary folder is used and removed when that Chrome exits. Chrome's shared
// memory files (--disable-dev-shm-usage puts them in TMPDIR) go to a disk folder too.
const WSK_DATA_DIR = process.env.WEB_SKELETON_DATA_DIR || join(homedir(), '.cache', 'web-skeleton');
const WSK_PROFILE_DIR = process.env.WEB_SKELETON_PROFILE_DIR || join(WSK_DATA_DIR, 'chrome-profile');
const WSK_TMP_DIR = process.env.WEB_SKELETON_TMP_DIR || join(WSK_DATA_DIR, 'tmp');

// Is the profile held by a running Chrome? Its lock is a symlink "<host>-<pid>".
function _profileLocked(dir) {
  try {
    const pid = Number(String(readlinkSync(join(dir, 'SingletonLock'))).split('-').pop());
    if (pid > 0) { try { process.kill(pid, 0); return true; } catch { return false; } }
  } catch { /* no lock */ }
  return false;
}

function _pickProfile() {
  mkdirSync(WSK_TMP_DIR, { recursive: true });
  if (!_profileLocked(WSK_PROFILE_DIR)) {
    mkdirSync(WSK_PROFILE_DIR, { recursive: true });
    return { dir: WSK_PROFILE_DIR, temp: false };
  }
  const dir = join(WSK_DATA_DIR, `chrome-profile-${process.pid}-${_cdpPort}`);
  mkdirSync(dir, { recursive: true });
  return { dir, temp: true };
}

// Images, video and audio are never downloaded: the skeleton reads labels and
// alt text, not pixels or sound, so they would only cost memory and bandwidth.
// (Ads are NOT blocked: some pages lock up or refuse to load when they are.)
async function _blockHeavy(session) {
  try {
    session.on('Fetch.requestPaused', (p) => {
      session.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await session.send('Fetch.enable', { patterns: [{ resourceType: 'Image' }, { resourceType: 'Media' }] });
  } catch { /* the page still renders, just with media */ }
}

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
  const profile = _pickProfile();
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
    '--blink-settings=imagesEnabled=false',
    '--mute-audio',
    '--autoplay-policy=user-gesture-required',
    '--js-flags=--max-old-space-size=512',
    ...proxyArgs,
    `--user-data-dir=${profile.dir}`,
    `--remote-debugging-port=${_cdpPort}`,
    '--window-size=1920,1080',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    '--lang=en-US,en',
    'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, TMPDIR: WSK_TMP_DIR },
  });

  _chromeProcess.on('error', (err) => {
    console.error('[WebSkeleton] Chrome spawn error:', err.message);
    _chromeProcess = null;
  });

  _chromeProcess.on('exit', (code) => {
    console.log(`[WebSkeleton] Chrome exited with code ${code}`);
    _chromeProcess = null;
    if (profile.temp) { try { rmSync(profile.dir, { recursive: true, force: true }); } catch {} }
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

// In the sandbox each slot keeps its own small page cache ON DISK, inside the
// slot (wiped with it): SLOT_CACHE_PAGES pages, no expiry. Outside the sandbox
// the in-memory cache below is used unchanged.
const SLOT_CACHE_PAGES = 3;
function _slot() { return globalThis.__sandboxCtx?.getStore?.()?.slotDir || null; }
function _slotCacheDir(slot) { return join(slot, '.web_cache'); }
function _slotCacheFile(slot, url) {
  return join(_slotCacheDir(slot), createHash('sha1').update(url).digest('hex') + '.json');
}
// Cached pages of a slot, oldest first: [{ file, url, timestamp }]
function _slotCacheList(slot) {
  const dir = _slotCacheDir(slot);
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of names) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      out.push({ file: join(dir, f), url: d.url, timestamp: d.timestamp || 0 });
    } catch {}
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
const _evicted = new Map();   // slot -> url dropped from the cache by the last render

function cacheSet(url, data) {
  const slot = _slot();
  if (slot) {
    mkdirSync(_slotCacheDir(slot), { recursive: true });
    const file = _slotCacheFile(slot, url);
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ ...data, url, timestamp: Date.now() }));
    renameSync(tmp, file);
    const pages = _slotCacheList(slot).filter((e) => e.file !== file);
    while (pages.length > SLOT_CACHE_PAGES - 1) {
      const old = pages.shift();
      try { unlinkSync(old.file); } catch {}
      _evicted.set(slot, old.url);
    }
    return;
  }
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

// ── Viewport ─────────────────────────────────────────────────────────────
// The agent chooses the size: viewport="WIDTHxHEIGHT" in pixels. Below 768 px
// wide the page is emulated as mobile (touch, mobile layout).
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
function parseViewport(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = String(v).trim().match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!m) throw new Error(`viewport must look like "1920x1080" (width x height in pixels), got "${v}"`);
  const width = +m[1], height = +m[2];
  if (width < 240 || width > 3840 || height < 240 || height > 2160) {
    throw new Error(`viewport ${width}x${height} is out of range: width 240-3840, height 240-2160`);
  }
  return { width, height };
}
const sameViewport = (a, b) => !!a && !!b && a.width === b.width && a.height === b.height;
// The size a cached page was rendered at (entries from before this field: the default).
const cachedViewport = (c) => (c && c.viewport) || DEFAULT_VIEWPORT;
// A cached page usable for a skeleton at `viewport`: same URL AND same size.
function cacheGetFor(url, viewport) {
  const c = cacheGet(url);
  return c && sameViewport(cachedViewport(c), viewport) ? c : null;
}
// Layout tag: x and w are % of the viewport width; y and h are % of the full page height.
function posTag(el) {
  const p = el.pos || {};
  return ` @${p.x}%,${p.y}%` + (p.w !== undefined && p.h !== undefined ? ` ${p.w}%×${p.h}%` : '');
}

function cacheGet(url) {
  const slot = _slot();
  if (slot) {
    try { return JSON.parse(readFileSync(_slotCacheFile(slot, url), 'utf8')); } catch { return null; }
  }
  url = _slotKey(url);
  const entry = _pageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    _pageCache.delete(url);
    return null;
  }
  return entry;
}

// ═════════════════════════════════════════════════
// SANDBOX RENDER LIMITS
// ═════════════════════════════════════════════════
// Rendering is the only expensive part of this tool (a Chromium renderer per
// page). In the sandbox: RENDER_LIMIT new renders per window per slot, at most
// MAX_PARALLEL_RENDERS at once across all slots (the rest wait briefly), and
// the slot's tab is closed right after each render so its renderer process
// ends. Reading cached pages costs nothing and is never limited.
const RENDER_LIMIT = parseInt(process.env.WEB_SKELETON_RENDERS_PER_WINDOW || '3', 10);
const RENDER_WINDOW_MS = parseInt(process.env.WEB_SKELETON_RENDER_WINDOW_MIN || '5', 10) * 60000;
const MAX_PARALLEL_RENDERS = parseInt(process.env.WEB_SKELETON_MAX_PARALLEL || '16', 10);
const RENDER_WAIT_MS = 60000;
const _renderLog = new Map();   // slot -> timestamps of recent renders
let _activeRenders = 0;
const _renderWaiters = [];

// A new render starts only while enough RAM is free, so many users on heavy
// pages queue up instead of exhausting memory. Renders started in the last few
// seconds have not used their memory yet, so each counts as RENDER_EST_MB more.
// One render is always allowed, so the queue never stalls.
const RENDER_MIN_FREE_MB = parseInt(process.env.WEB_SKELETON_MIN_FREE_MB || '3072', 10);
const RENDER_EST_MB = 400;
const RENDER_RAMP_MS = 8000;
const _renderStarts = [];
let _memCache = { t: 0, mb: Infinity };
function _freeMemMB() {
  const now = Date.now();
  if (now - _memCache.t < 250) return _memCache.mb;
  let mb;
  try { mb = Number(readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1]) / 1024; }
  catch { mb = freemem() / 1048576; }
  _memCache = { t: now, mb };
  return mb;
}
function _roomForRender() {
  if (_activeRenders === 0) return true;
  if (_activeRenders >= MAX_PARALLEL_RENDERS) return false;
  const now = Date.now();
  while (_renderStarts.length && now - _renderStarts[0] > RENDER_RAMP_MS) _renderStarts.shift();
  return _freeMemMB() - _renderStarts.length * RENDER_EST_MB >= RENDER_MIN_FREE_MB;
}
function _startRender() { _activeRenders += 1; _renderStarts.push(Date.now()); }
let _renderPoll = null;
function _admitWaiters() {
  while (_renderWaiters.length && _roomForRender()) { _startRender(); _renderWaiters.shift().resolve(); }
  if (_renderWaiters.length && !_renderPoll) {
    // Memory can free up without a render ending (other processes): look again.
    _renderPoll = setInterval(() => {
      _admitWaiters();
      if (!_renderWaiters.length) { clearInterval(_renderPoll); _renderPoll = null; }
    }, 500);
  }
}
function _acquireRender() {
  if (!_renderWaiters.length && _roomForRender()) { _startRender(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const w = {};
    const timer = setTimeout(() => {
      const i = _renderWaiters.indexOf(w);
      if (i >= 0) _renderWaiters.splice(i, 1);
      reject(new Error('The web renderer is busy right now. Try again in a minute; pages you already loaded can still be read.'));
    }, RENDER_WAIT_MS);
    w.resolve = () => { clearTimeout(timer); resolve(); };
    _renderWaiters.push(w);
    _admitWaiters();
  });
}
function _releaseRender() {
  _activeRenders -= 1;
  _admitWaiters();
}

// Called by a render as soon as it has read the page: closes the tab and lets
// the next render start, while titling and embedding (no Chrome needed) go on.
const _earlyRelease = new Map();   // slot -> release()
function _doneWithChrome() {
  const slot = _slot();
  if (slot) _earlyRelease.get(slot)?.();
}
function _closeSlotTab(slot) {
  const t = _slotTargets.get(slot);
  if (!t) return;
  _slotTargets.delete(slot);
  _browserSession()
    .then(async (b) => { try { await b.send('Target.disposeBrowserContext', { browserContextId: t.contextId }); } catch {} await b.close(); })
    .catch(() => {});
}
function _recentRenders(slot) {
  const now = Date.now();
  const log = (_renderLog.get(slot) || []).filter((t) => now - t < RENDER_WINDOW_MS);
  _renderLog.set(slot, log);
  return log;
}
async function withRender(fn) {
  const slot = _slot();
  if (!slot) return fn();   // outside the sandbox: unchanged
  const limitError = () => {
    const log = _recentRenders(slot);
    const wait = Math.max(1, Math.ceil((RENDER_WINDOW_MS - (Date.now() - log[0])) / 1000));
    const cached = _slotCacheList(slot).map((e) => e.url);
    return new Error(`Render limit reached: ${RENDER_LIMIT} new pages per ${RENDER_WINDOW_MS / 60000} minutes. `
      + `The next one is available in ${wait}s.`
      + (cached.length ? ` Pages you can still read without limit (read action): ${cached.join(', ')}` : ''));
  };
  if (_recentRenders(slot).length >= RENDER_LIMIT) throw limitError();
  await _acquireRender();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    _releaseRender();
    _closeSlotTab(slot);   // close the tab: frees its renderer
  };
  _earlyRelease.set(slot, release);
  try {
    const log = _recentRenders(slot);
    if (log.length >= RENDER_LIMIT) throw limitError();   // a parallel call got there first
    log.push(Date.now());
    let out = await fn();
    const dropped = _evicted.get(slot);
    _evicted.delete(slot);
    if (dropped) out += `\n[Cache holds ${SLOT_CACHE_PAGES} pages per sandbox; dropped ${dropped}. Render it again if you need it.]`;
    return out;
  } finally {
    if (_earlyRelease.get(slot) === release) _earlyRelease.delete(slot);
    release();
  }
}
(globalThis.__sandboxForgetHooks ||= []).push((slotDir) => {
  _renderLog.delete(slotDir);
  _evicted.delete(slotDir);
});

// ═══════════════════════════════════════════════════════════════════════════
// DOM WALKER (injected into page via Runtime.evaluate)
// ═══════════════════════════════════════════════════════════════════════════

const DOM_WALKER_SCRIPT = `
(() => {
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  const scrollH = document.documentElement.scrollHeight || vh;
    // Element ids are stamped on the page (data-wsk) so click can find exactly
    // the element this walker numbered; old stamps are cleared first.
    try { document.querySelectorAll('[data-wsk]').forEach((n) => n.removeAttribute('data-wsk')); } catch (e) {}

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
      const clean = txt.replace(/\\s+/g, ' ').trim();
      return clean.length > 80 ? clean.slice(0, 79) + '…' : clean;
    }
    if (tag === 'IMG') return el.alt || '[image]';
    return '';
  }

  function shortLabel(t) {
    const clean = String(t || '').replace(/\\s+/g, ' ').trim();
    return clean.length > 80 ? clean.slice(0, 79) + '…' : clean;
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
    text = text.replace(/\\s+/g, ' ').trim();
    return text.length > 150 ? text.slice(0, 147) + '...' : text;
  }

  // Extract table as pipe-delimited rows
  function getTableText(table) {
    const rows = [];
    const trList = table.querySelectorAll('tr');
    for (const tr of trList) {
      const cells = [];
      for (const cell of tr.querySelectorAll('th, td')) {
        const t = (cell.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) cells.push(t);
      }
      if (cells.length > 0) rows.push(cells.join(' | '));
    }
    return rows.join('\\n');
  }

  // Extract <pre>/<code> blocks as-is
  function getPreText(el) {
    return (el.textContent || '').trim();
  }

  // Code blocks: <pre>, and code drawn as a table (GitHub file views and
  // embedded snippets: td.blob-code cells, table.highlight). Each is ONE
  // element; its lines are not walked.
  function isCodeTable(el) {
    if (el.tagName !== 'TABLE') return false;
    return el.classList.contains('highlight')
      || !!el.querySelector('td.blob-code, td.blob-code-inner, td.js-file-line');
  }
  function isCodeBlock(el) { return el.tagName === 'PRE' || isCodeTable(el); }
  // Language hint from the block's classes or its wrappers' (language-py, hljs js, highlight-source-c++).
  function codeLang(el) {
    let cls = String(el.className || '') + ' ' + String((el.querySelector('code') || {}).className || '');
    for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) cls += ' ' + String(p.className || '');
    const m = cls.match(/(?:language-|lang-|highlight-source-|highlight-(?!source)|hljs\\s+)([\\w+#-]+)/);
    return m ? m[1].toLowerCase() : '';
  }
  function codeText(el) {
    if (el.tagName === 'PRE') return (el.textContent || '').replace(/\\s+$/, '');
    const out = [];
    for (const tr of el.querySelectorAll('tr')) {
      const cell = tr.querySelector('td.blob-code, td.blob-code-inner, td.js-file-line') || tr.querySelector('td:last-child');
      out.push(cell ? (cell.textContent || '').replace(/\\s+$/, '') : '');
    }
    return out.join('\\n');
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
            const tt = isCodeTable(child) ? codeText(child) : getTableText(child);
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
                const ct = (c.textContent || '').replace(/\\s+/g, ' ').trim();
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
    return lines.join('\\n');
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

    if (isCodeBlock(el)) {
      const eid = 'e' + (nextId++);
      try { el.setAttribute('data-wsk', eid); } catch (e) {}
      const pos = getPosition(el);
      if (pos.w === 0 && pos.h === 0) return;
      elements.push({ id: eid, kind: 'code', depth, label: codeLang(el), summary: '', pos, clickable: false });
      sections[eid] = codeText(el);
      return;
    }

    if (isContent || (tag === 'DIV')) {
      const eid = 'e' + (nextId++);
      try { el.setAttribute('data-wsk', eid); } catch (e) {}
      const pos = getPosition(el);
      // Skip invisible elements
      if (pos.w === 0 && pos.h === 0) {
        for (const child of el.children) walk(child, depth);
        return;
      }
      const label = shortLabel(getLabel(el));
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


// ── CURRENT PAGE (per sandbox) ──────────────────────────────────────────────
// The browser tab is closed as soon as a page has been read; what stays is the
// address of the page the model is on (or the last search's results), so read
// and click need only an element id. 'home' forgets it. Page data itself stays
// in the disk cache, so going back to a page is instant.
const _current = new Map();   // sandbox key → { url, viewport } or { query, results: [url...] }
const _curKey = () => _slot() || 'local';
function currentPage() { return _current.get(_curKey()) || null; }
function setCurrentPage(url, viewport = null) { _current.set(_curKey(), { url, viewport }); }
function setSearchResults(query, urls) { _current.set(_curKey(), { query, results: urls }); }
function goHome() {
  _current.delete(_curKey());
  const slot = _slot();
  if (slot) _closeSlotTab(slot);
}
const NO_PAGE = 'No page open. Next: search with a query, or skeleton with a url.';

// "example.com/x" → "https://example.com/x": addresses are often shown without
// a scheme (search results, links in text), and the model copies what it sees.
function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return s;
  if (s.startsWith('//')) s = 'https:' + s;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  return s;
}
// ═══════════════════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function actionSkeleton(url, viewport = DEFAULT_VIEWPORT, context = null, layout = null, full = false) {
// Cache first — but only a page rendered at THIS size (a different size reflows the page).
const cached = cacheGetFor(url, viewport);
  if (cached) {
    if (context && (cached.vectors?.format || 1) !== EMBED_FORMAT) {
      const vectors = await embedElements({ elements: cached.skeleton, sections: cached.sections });
      if (vectors) { cached.vectors = vectors; cacheSet(url, cached); }
    }
    return formatSkeleton({
      title: cached.title || '',
      url: cached.url || url,
      viewport: { width: viewport.width, height: viewport.height },
      pageHeight: cached.pageHeight || 0,
      elementCount: cached.skeleton.length,
      elements: cached.skeleton,
      sections: cached.sections,
      rawBytes: cached.rawBytes || 0,
      meaning: context ? await meaningMatches(cached.vectors, context, { elements: cached.skeleton, sections: cached.sections }) : null,
    }, viewport, context, layout, full);
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
    await _blockHeavy(session);
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
    _doneWithChrome();   // page read: close the tab now, titling and embedding need no Chrome

    // AI-title text-heavy sections for better navigation, then embed every
    // segment (titles included) so the page can be searched by meaning.
    await aiTitleElements(data);
    // Code blocks: language, size and a title (first definition), kept with the page.
    await annotateCode(data);
    const vectors = await embedElements(data);

    // Cache full skeleton + all sections + vectors (after titling, so the
    // titles are kept for later reads of the page)
    cacheSet(url, {
      skeleton: data.elements,
      sections: data.sections,
      title: data.title,
      url: data.url,
      pageHeight: data.pageHeight,
      rawBytes,
      viewport: { width: viewport.width, height: viewport.height },
      vectors,
    });

    if (context) data.meaning = await meaningMatches(vectors, context, data);
    return formatSkeleton(data, viewport, context, layout, full);
  } finally {
    await session.close();
  }
}

// Page text without layout noise: lines trimmed, runs of blank lines folded.
function tidyText(text) {
  return String(text || '').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function actionRead(url, sectionId) {
  let cached = cacheGet(url);
  if (!cached) {
    // Need to skeleton first
    await actionSkeleton(url);
    cached = cacheGet(url);
    if (!cached) throw new Error('Failed to cache page');
  }
  // "e12" is an element; "e12.3" / "e12.3.1" are parts of a code block.
  const addr = parseCodeAddress(sectionId);
  const id = addr ? addr.elementId : String(sectionId || '').trim();
  if (!(id in cached.sections)) {
    const ids = Object.keys(cached.sections);
    return `[WebSkeleton Error] There is no ${id} on this page; its ids are e1 ... ${ids[ids.length - 1] || 'e1'}.`;
  }
  const el = (cached.skeleton || []).find((e) => e.id === id);
  const text = cached.sections[id];
  if (el && el.kind === 'code') return readCode(id, addr ? addr.path : [], text || '', el.lang || el.label || '');
  if (addr && addr.path.length) return `[WebSkeleton Error] ${id} is not code, so it has no parts; read it as "${id}".`;
  if (!text) return `[${id} has no text of its own; read the elements inside it]`;
  return tidyText(text);
}

async function actionClick(url, elementId, viewport = null) {
// Keep browsing at the size the page was skeletoned at, unless told otherwise.
viewport = viewport || cachedViewport(cacheGet(url));
await ensureChrome();

  // In the sandbox tabs are closed after every render, so open a fresh one;
  // the check below loads the page before the element is resolved.
  const target = await getPageTarget(!!_slot());
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
        await _blockHeavy(session);
        const loaded = new Promise((resolve) => { session.on('Page.loadEventFired', resolve); setTimeout(resolve, 15000); });
        await session.send('Page.navigate', { url });
        await loaded;
        await sleep(1500);
      }
    }

    // Number the page with the SAME walker the skeleton used (same rules, same
    // viewport), so an id means the same element in both. The walker stamps each
    // numbered element with data-wsk; the click selects exactly that element.
    if (!/^e\d{1,6}$/.test(String(elementId))) throw new Error(`element must be an id from the skeleton, like "e12"`);
    const stamp = await session.send('Runtime.evaluate', { expression: DOM_WALKER_SCRIPT, returnByValue: true });
    if (stamp.exceptionDetails) throw new Error('DOM walker error before click: ' + JSON.stringify(stamp.exceptionDetails));
    const clickScript = `(() => {
      const el = document.querySelector('[data-wsk="${elementId}"]');
      if (!el) return JSON.stringify({ error: 'Element ${elementId} is not on the page as it is now; take a new skeleton' });

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
    // Raw page size, as the skeleton measures it, for the token line.
    try {
      const raw = await session.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML.length', returnByValue: true });
      data.rawBytes = raw?.result?.value || 0;
    } catch { data.rawBytes = 0; }

    // Code blocks: language, size and a title, kept with the page.
    await annotateCode(data);
    // Update cache with new URL
    cacheSet(newUrl, {
      skeleton: data.elements,
      sections: data.sections,
      title: data.title,
      url: newUrl,
      pageHeight: data.pageHeight,
      rawBytes: data.rawBytes,
      viewport: { width: viewport.width, height: viewport.height },
    });
    // The model is now on the page the click led to (same page if it did not navigate).
    setCurrentPage(newUrl, viewport);

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
    await _blockHeavy(session);
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
      lines.push(`[r${i + 1}] ${r.title}`);
      lines.push(`    ${r.displayUrl || r.url}`);
      if (r.snippet) lines.push(`    ${r.snippet}`);
      lines.push('');
    }
    // Remember the results: "click r3" opens result 3, no address to copy.
    setSearchResults(query, searchResults.map((r) => r.url));
    if (searchResults.length) lines.push(`Open a result: click with element "r1" ... "r${searchResults.length}".`);

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

// Same rule as read_file: a skeleton over ~3000 tokens without context is not
// dumped; the agent gets the page's outline and how to narrow it.
const WEB_TOKEN_LIMIT = 3000;
const OUTLINE_KINDS = new Set(['main', 'navigation', 'nav', 'sidebar', 'aside', 'region', 'header', 'footer', 'section', 'article', 'form']);
function buildOutline(data, viewport, layout, fullTokens) {
  const out = [
    `PAGE: ${data.title}`,
    `URL: ${data.url}`,
    `VIEWPORT: ${viewport.width}x${viewport.height} scrollH:${data.pageHeight}`,
    `TOO LARGE: the full skeleton is ~${fullTokens.toLocaleString()} tokens (${data.elements.length} elements). Outline: landmarks and headings.`,
    'NEXT: skeleton with context="<words to look for>", read [id] for one section, or full_skeleton=true for everything.',
    '---',
  ];
  let budget = WEB_TOKEN_LIMIT * 4 - out.join('\n').length - 200;
  let omitted = 0, shown = 0;
  for (const el of data.elements) {
    if (!(el.kind === 'heading' || (OUTLINE_KINDS.has(el.kind) && el.depth <= 2))) continue;
    let line = `${'  '.repeat(Math.min(el.depth, 6))}[${el.id}] ${el.kind}${el.label ? ` "${el.label}"` : ''}`;
    if (layout === 'all' || layout === el.id) line += posTag(el);
    if (line.length + 1 > budget) { omitted++; continue; }
    budget -= line.length + 1;
    out.push(line);
    shown++;
  }
  if (omitted) out.push(`(${omitted} more headings and landmarks not shown — narrow with context)`);
  // Pages without headings (link lists, tables): show their first links instead.
  if (shown < 5) {
    out.push('Few headings on this page; its first links:');
    let more = 0;
    for (const el of data.elements) {
      if (!el.clickable || !el.label) continue;
      let line = `  [${el.id}] ${el.kind} "${el.label}"${el.dest ? ` → ${el.dest}` : ''}`;
      if (layout === 'all' || layout === el.id) line += posTag(el);
      if (line.length + 1 > budget) { more++; continue; }
      budget -= line.length + 1;
      out.push(line);
    }
    if (more) out.push(`(${more} more links — narrow with context)`);
  }
  return out.join('\n');
}

function formatSkeleton(data, viewport, context = null, layout = null, full = false) {
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

    // ── Code blocks: always one line (title, language, size); read gives their map ──
    for (let i = 0; i < elements.length; i++) {
      if (collapseMap.has(i)) continue;
      const el = elements[i];
      if (el.kind !== 'code' && !/^\d+ lines$/.test(el.label || '')) continue;
      const text = data.sections?.[el.id] || '';
      const lineCount = el.lines || text.split('\n').length;
      let codeEnd = i;
      for (let j = i + 1; j < elements.length; j++) {
        if (elements[j].depth <= el.depth) break;
        codeEnd = j;
      }
      collapseMap.set(i, { type: 'code', items: lineCount, links: 0, endIdx: codeEnd });
    }

    // ── Render pass ──────────────────────────────────────────────────
    let skipUntil = -1;
    let collapsed = 0;

    lines.push(`ELEMENTS: ${elements.length}`);
    lines.push('KEY: ● can be clicked (click its id) · ○ content (read its id)');
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
        const posStr = (layout === 'all' || layout === el.id) ? posTag(el) : '';
        if (info.type === 'code') {
          // One line per code block: language, title (its first definition), size.
          const lang = el.lang || ((el.label && !/^\d+ lines$/.test(el.label)) ? el.label : '');
          const title = el.codeTitle ? ` "${el.codeTitle}"` : '';
          lines.push(`${indent}○ [${el.id}] code${lang && lang !== 'plaintext' ? ' ' + lang : ''}${title} (${count} ${unit})${posStr} — read [${el.id}] for its parts`);
        } else {
          lines.push(`${indent}${click} [${el.id}] ${info.type} "${el.label || el.kind}" (${count} ${unit})${posStr} — read [${el.id}] to expand`);
        }
        skipUntil = info.endIdx;
        collapsed += (info.endIdx - i);
        continue;
      }

      // Normal element
      let line = `${indent}${click} [${el.id}] ${el.kind}`;
      if (el.label) line += ` "${el.label}"`;
      if (el.dest) line += ` → ${el.dest}`;
      if (layout === 'all' || layout === el.id) line += posTag(el);
      // Summary only for leaf elements — parents' children show the content
      const hasChildren = (i + 1 < elements.length && elements[i + 1].depth > el.depth);
      // Nothing to show or do: no label, no destination, no text, no children
      // (empty wrappers, unlabeled images and icon buttons). Ids stay as they are.
      if (!hasChildren && !el.dest && (!el.label || el.label === '[image]')
          && !(el.summary && el.summary.length > 5)) continue;
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
    lines.push(`CONTEXT: "${context}"`);

    // Exact phrase first, then all words (or the one word), then meaning, then any
    // word, then word roots — the first that finds something wins, so a specific
    // search is never drowned by its common words.
    const q = context.trim().toLowerCase().replace(/\s+/g, ' ');
    const words = q.split(' ').filter(t => t.length > 2);
    const textOf = (el) => [el.label || '', el.summary || '', data.sections?.[el.id] || ''].join(' ').toLowerCase();
    const pick = (pred) => { const set = new Set(); for (const el of elements) if (pred(textOf(el))) set.add(el.id); return set; };
    const ownText = new Map(elements.map((el, i) => {
      const hasChildren = i + 1 < elements.length && elements[i + 1].depth > el.depth;
      return [el.id, hasChildren ? [el.label || '', el.summary || ''].join(' ').toLowerCase() : textOf(el)];
    }));
    const pickOwn = (pred) => { const set = new Set(); for (const el of elements) if (pred(ownText.get(el.id))) set.add(el.id); return set; };
    let matchMode = 'any word';
    let matchSet = new Set();
    if (q.includes(' ')) { matchSet = pick(t => t.includes(q)); matchMode = 'exact phrase'; }
    if (!matchSet.size && words.length >= 2) { matchSet = pickOwn(t => words.every(w => t.includes(w))); matchMode = 'all words'; }
    if (!matchSet.size && q && !q.includes(' ')) { matchSet = pick(t => t.includes(q)); matchMode = 'word'; }
    if (!matchSet.size && data.meaning?.length) { matchSet = new Set(data.meaning.map((m) => m.id)); matchMode = 'meaning'; }
    if (!matchSet.size && words.length >= 2) { matchSet = pick(t => words.some(w => t.includes(w))); matchMode = 'any word'; }
    if (!matchSet.size && words.length) {
      // Word roots: "installation", "installing" and "installed" all match "install".
      const roots = words.map((w) => w.replace(/(ations?|ments?|ings?|ed|es|s|ly)$/, '')).filter((r) => r.length >= 4);
      if (roots.length) { matchSet = pick(t => roots.some(r => t.includes(r))); matchMode = 'word root'; }
    }
    // Most specific only: a container whose content matches inside a child is
    // context (shown as a parent), not a match itself.
    for (let i = 0; i < elements.length; i++) {
      if (!matchSet.has(elements[i].id)) continue;
      for (let j = i + 1; j < elements.length && elements[j].depth > elements[i].depth; j++) {
        if (matchSet.has(elements[j].id)) { matchSet.delete(elements[i].id); break; }
      }
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

    lines.push(`MATCHES: ${matchSet.size} of ${data.elementCount ?? elements.length} elements (${matchMode})`);
    lines.push('---');

    for (const el of elements) {
      const isMatch = matchSet.has(el.id);
      const isParent = parentIds.has(el.id);
      const indent = '  '.repeat(el.depth);
      const click = el.clickable ? '●' : '○';
      if (el.kind === 'code' && (isMatch || isParent)) {
        const lang = el.lang && el.lang !== 'plaintext' ? ' ' + el.lang : '';
        const title = el.codeTitle ? ` "${el.codeTitle}"` : '';
        const size = el.lines ? ` (${el.lines} lines)` : '';
        lines.push(`${indent}○ [${el.id}] code${lang}${title}${size}${isMatch ? ' ★' : ''}`);
        continue;
      }

      if (isMatch) {
        let line = `${indent}${click} [${el.id}] ${el.kind}`;
        if (el.label) line += ` "${el.label}"`;
        if (el.dest) line += ` → ${el.dest}`;
        if (layout === 'all' || layout === el.id) line += posTag(el);
        line += ' ★';
        if (el.summary && el.summary !== el.label) {
          line += `\n${indent}  └ ${el.summary}`;
        }
        lines.push(line);
      } else if (isParent) {
        let line = `${indent}${click} [${el.id}] ${el.kind}`;
        if (el.label) line += ` "${el.label}"`;
        if (layout === 'all' || layout === el.id) line += posTag(el);
        lines.push(line);
      } else if (el.kind === 'heading') {
        let line = `${indent}  [${el.id}] ${el.kind}`;
        if (el.label) line += ` "${el.label}"`;
        if (layout === 'all' || layout === el.id) line += posTag(el);
        lines.push(line);
      }
    }
  }

  // Token stats footer
  let output = lines.join('\n');
  if (!context && !full && output.length / 4 > WEB_TOKEN_LIMIT) {
    output = buildOutline(data, viewport, layout, Math.round(output.length / 4));
  }
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
  description: 'Browse the web as a map instead of raw HTML. '
    + 'search(query) lists results r1, r2 ...; click r3 opens result 3. skeleton(url) opens a page and shows its map with element ids (e5, e12 ...). '
    + 'The tool remembers the page you are on: read(section="e5") shows that part, click(element="e12") follows a link or presses a button; no url needed. '
    + 'In maps, ● = can be clicked, ○ = content to read. home closes the page and starts fresh.',
  schema: {
    action: z.enum(['search', 'skeleton', 'read', 'click', 'home']).describe(
      'search: web search, results get ids r1, r2 ... '
      + 'skeleton: open a page (url) and show its map. Optional context keeps only the parts about it. '
      + 'read: show the full content of one element of the current page (section). '
      + 'click: click an element of the current page (e12), or open a search result (r3); returns the new map. '
      + 'home: close the current page; next step is search or skeleton.'
    ),
    url: z.string().optional().describe('Page address for skeleton ("example.com/page" works). Left out, skeleton, read and click use the current page.'),
    context: z.string().optional().describe('Words about what you are looking for: only matching parts of the page are expanded, the rest collapsed to headings'),
    section: z.string().optional().describe('Element id to read, from the map, e.g. "e5"'),
    element: z.string().optional().describe('Element id to click, e.g. "e12", or a search result id, e.g. "r3"'),
    query: z.string().optional().describe('Search words (for search)'),
    layout: z.string().optional().describe('Show element positions. "all" = every element, or an element id like "e5" for just that subtree. Omit for no positions (default). Format @x%,y% w%×h%: x and w are % of the viewport width, y and h are % of the full page height.'),
    full_skeleton: z.boolean().optional().describe('Show the whole map even when it is very large (above ~3000 tokens a map without context returns the page outline instead).'),
    viewport: z.string().optional().describe('Screen size to render at, "WIDTHxHEIGHT" in pixels, e.g. "390x844" (phone), "1366x768" (laptop). Default 1920x1080. Below 768 px wide the page is rendered as mobile. For skeleton and click; read uses the size of the last skeleton.'),
  },
  async handler(args, ctx) {
    try {
      let result;
      const cur = currentPage();
      // The page to act on: an explicit url, else the page the model is on.
      const pageUrl = () => (args.url ? normalizeUrl(args.url) : (cur && cur.url) || null);
      const openPage = async (url, vp) => {
        const full = !!args.full_skeleton;
        const out = cacheGetFor(url, vp)
          ? await actionSkeleton(url, vp, args.context || null, args.layout || null, full)
          : await withRender(() => actionSkeleton(url, vp, args.context || null, args.layout || null, full));
        setCurrentPage(url, vp);
        return out;
      };

      switch (args.action) {
        case 'skeleton': {
          // No url: the current page again (with context, full_skeleton or another size).
          const url = pageUrl();
          if (!url) throw new Error('url required for skeleton (or search, then click a result like "r1")');
          validateUrl(url);
          result = await openPage(url, parseViewport(args.viewport) || (!args.url && cur && cur.viewport) || DEFAULT_VIEWPORT);
          break;
        }

        case 'read': {
          if (!args.section) throw new Error('section required for read, an element id from the map like "e5"');
          const url = pageUrl();
          if (!url) throw new Error(NO_PAGE);
          validateUrl(url);
          result = cacheGet(url)
            ? await actionRead(url, args.section)
            : await withRender(() => actionRead(url, args.section));
          if (args.url) setCurrentPage(url, (cur && cur.viewport) || null);
          break;
        }

        case 'click': {
          if (!args.element) throw new Error('element required for click, like "e12" (or "r3" for a search result)');
          const rm = /^r(\d+)$/i.exec(String(args.element).trim());
          if (rm && !args.url) {
            if (!cur || !cur.results) throw new Error('No search results open: r-ids come from a search. Run search first.');
            const target = cur.results[Number(rm[1]) - 1];
            if (!target) throw new Error(`There is no result r${rm[1]}; this search has r1 ... r${cur.results.length}.`);
            const url = normalizeUrl(target);
            validateUrl(url);
            result = await openPage(url, parseViewport(args.viewport) || DEFAULT_VIEWPORT);
            break;
          }
          const url = pageUrl();
          if (!url) throw new Error(NO_PAGE);
          validateUrl(url);
          const clickVp = parseViewport(args.viewport);   // null → the size the page was browsed at
          result = await withRender(() => actionClick(url, args.element, clickVp));
          break;
        }

        case 'search':
          if (!args.query) throw new Error('query required for search');
          result = await withRender(() => actionSearch(args.query, ctx));
          break;

        case 'home':
          goHome();
          result = 'Home: no page open. Next: search with a query, or skeleton with a url.';
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
