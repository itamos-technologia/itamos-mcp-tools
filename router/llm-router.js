#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Itamos LLM router: token-budget load balancing across llama.cpp servers
// ═══════════════════════════════════════════════════════════════════════════
//
// One router per model pool (summarizer, embedder), each on its own port, in
// front of several llama-server backends (one per GPU). Before a request is
// sent, its size in tokens is measured with the backend's own /tokenize, plus
// the tokens it may generate. The request goes to a GPU whose KV pool has room
// for it; if none has room it waits in line until a running request finishes.
//
//   - Capacity: each backend's KV pool is read from its /props (n_ctx; with
//     --kv-unified that is the whole pool). Only BUDGET_FRACTION of it is used.
//   - Choice: among GPUs with room and a free slot, the least loaded relative to
//     its weight (a faster GPU gets a higher weight and so more of the work).
//   - Failure: a backend that errors is skipped for FAIL_SKIP_MS and the request
//     is retried on another (up to 3 tries).
//   - A request larger than any single GPU can hold is refused at once (413).
//
// Transparent: every path and method is passed through unchanged (/completion,
// /v1/chat/completions, /embedding, /v1/embeddings, /props, /health ...).
// Status: GET /router/status.
//
// Config (environment):
//   ROUTES  "name|listen-port|backend@weight[@pool],backend@weight[@pool];name|port|..."
//           pool = the backend's KV pool in tokens (its -c with --kv-unified). Optional:
//           without it the pool is read from /props, which reports the per-request
//           limit, so it is safe but may undercount a unified pool.
//   e.g.    "summarizer|8090|http://127.0.0.1:8190@4,http://127.0.0.1:8092@1,http://127.0.0.1:8094@1;
//            embedder|8091|http://127.0.0.1:8191@4,http://127.0.0.1:8093@1,http://127.0.0.1:8095@1"
//   ROUTER_HOST (127.0.0.1)  BUDGET_FRACTION (0.9)  DEFAULT_GEN_TOKENS (512)
//   QUEUE_TIMEOUT_MS (600000)  FAIL_SKIP_MS (15000)
// No npm dependencies.

import http from 'node:http';

const HOST = process.env.ROUTER_HOST || '127.0.0.1';
const BUDGET_FRACTION = Number(process.env.BUDGET_FRACTION || 0.9);
const DEFAULT_GEN_TOKENS = Number(process.env.DEFAULT_GEN_TOKENS || 512);
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS || 600000);
const FAIL_SKIP_MS = Number(process.env.FAIL_SKIP_MS || 15000);
const TEMPLATE_MARGIN = 32;          // chat template tokens around the messages
const REFRESH_MS = 30000;            // re-read capacities (picks up new flags)

// ── small HTTP helpers ──────────────────────────────────────────────────────
function request(base, path, { method = 'GET', body = null, headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const req = http.request(u, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const json = (b) => { try { return JSON.parse(b.toString()); } catch { return null; } };

// ── one pool of backends (one model, several GPUs) ──────────────────────────
class Pool {
  constructor(name, port, spec) {
    this.name = name;
    this.port = port;
    this.backends = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [url, w, pool] = s.split('@');
      return { url: url.replace(/\/$/, ''), weight: Number(w) || 1, pool: Number(pool) || 0,
               capacity: 0, perRequest: 0, slots: 1,
               reserved: 0, inflight: 0, downUntil: 0, served: 0 };
    });
    this.queue = [];               // waiting requests: { tokens, resolve, reject, timer }
  }

  async refresh() {
    await Promise.all(this.backends.map(async (b) => {
      try {
        const r = await request(b.url, '/props', { timeout: 5000 });
        const p = json(r.body);
        const nctx = p?.default_generation_settings?.n_ctx;
        if (r.status === 200 && nctx) {
          b.perRequest = nctx;
          b.capacity = Math.floor((b.pool || nctx) * BUDGET_FRACTION);
          b.slots = p.total_slots || 1;
        }
      } catch { /* keep the last known capacity; failures are handled per request */ }
    }));
    this.drain();
  }

  maxRequest() {
    return Math.max(0, ...this.backends.map((b) => Math.min(b.capacity, b.perRequest || b.capacity)));
  }

  // Least loaded backend (relative to its weight) that has room and a free slot.
  pick(tokens, exclude = new Set()) {
    const now = Date.now();
    let best = null, bestLoad = Infinity;
    for (const b of this.backends) {
      if (exclude.has(b) || b.downUntil > now || !b.capacity) continue;
      if (tokens > (b.perRequest || b.capacity)) continue;
      if (b.reserved + tokens > b.capacity || b.inflight >= b.slots) continue;
      const load = (b.inflight + 1) / b.weight;
      if (load < bestLoad) { best = b; bestLoad = load; }
    }
    return best;
  }

  // Reserve room for `tokens`, waiting in line if no backend has it now.
  acquire(tokens, exclude) {
    const b = this.queue.length ? null : this.pick(tokens, exclude);
    if (b) { this.take(b, tokens); return Promise.resolve(b); }
    return new Promise((resolve, reject) => {
      const item = { tokens, exclude, resolve, reject };
      item.timer = setTimeout(() => {
        this.queue.splice(this.queue.indexOf(item), 1);
        reject(Object.assign(new Error('timed out waiting for GPU capacity'), { status: 503 }));
      }, QUEUE_TIMEOUT_MS);
      this.queue.push(item);
    });
  }

  take(b, tokens) { b.reserved += tokens; b.inflight += 1; }

  release(b, tokens) {
    b.reserved = Math.max(0, b.reserved - tokens);
    b.inflight = Math.max(0, b.inflight - 1);
    this.drain();
  }

  // First in line goes first: later requests do not overtake it.
  drain() {
    while (this.queue.length) {
      const item = this.queue[0];
      const b = this.pick(item.tokens, item.exclude);
      if (!b) return;
      this.queue.shift();
      clearTimeout(item.timer);
      this.take(b, item.tokens);
      item.resolve(b);
    }
  }

  // Tokens a request will occupy: its input (counted by the model's own
  // tokenizer) plus what it may generate.
  async measure(body) {
    const req = json(body) || {};
    let text = '';
    if (typeof req.prompt === 'string') text = req.prompt;
    else if (Array.isArray(req.prompt)) text = req.prompt.join('\n');
    else if (Array.isArray(req.messages)) {
      text = req.messages.map((m) => (typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('\n') : '')).join('\n');
    } else if (typeof req.content === 'string') text = req.content;
    else if (typeof req.input === 'string') text = req.input;
    else if (Array.isArray(req.input)) text = req.input.join('\n');

    const gen = req.n_predict > 0 ? req.n_predict
      : req.max_tokens > 0 ? req.max_tokens
      : req.max_completion_tokens > 0 ? req.max_completion_tokens
      : (req.prompt !== undefined || req.messages) ? DEFAULT_GEN_TOKENS : 0;

    let input = Math.ceil(text.length / 2);          // safe fallback: over-estimate
    const live = this.backends.find((b) => b.downUntil <= Date.now() && b.capacity) || this.backends[0];
    try {
      const r = await request(live.url, '/tokenize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }), timeout: 5000,
      });
      const t = json(r.body)?.tokens;
      if (r.status === 200 && Array.isArray(t)) input = t.length;
    } catch { /* keep the over-estimate */ }
    return input + gen + (req.messages ? TEMPLATE_MARGIN : 8);
  }
}

// ── proxying one request ────────────────────────────────────────────────────
function forward(b, req, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url, b.url);
    const headers = { ...req.headers, host: u.host };
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const up = http.request(u, { method: req.method, headers, timeout: 600000 }, resolve);
    up.on('timeout', () => up.destroy(new Error('backend timeout')));
    up.on('error', reject);
    if (body) up.write(body);
    up.end();
  });
}

async function handle(pool, req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  if (req.method === 'GET' && req.url === '/router/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      pool: pool.name, queue: pool.queue.length, budget_fraction: BUDGET_FRACTION,
      backends: pool.backends.map((b) => ({
        url: b.url, weight: b.weight, capacity_tokens: b.capacity, per_request_max: b.perRequest,
        reserved_tokens: b.reserved,
        slots: b.slots, inflight: b.inflight, served: b.served, down: b.downUntil > Date.now(),
      })),
    }, null, 2));
  }

  // Only generation and embedding requests use the budget; everything else
  // (health, props, models, tokenize ...) goes to any live backend.
  const budgeted = req.method === 'POST' && body && !/\/(tokenize|detokenize|props|slots)/.test(req.url);
  const tokens = budgeted ? await pool.measure(body) : 0;
  if (budgeted && tokens > pool.maxRequest()) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `request needs ${tokens} tokens; the largest GPU pool holds ${pool.maxRequest()}` }));
  }

  const tried = new Set();
  for (let attempt = 0; attempt < 3; attempt++) {
    let b;
    try {
      if (budgeted) b = await pool.acquire(tokens, tried);
      else {
        b = pool.backends.find((x) => !tried.has(x) && x.downUntil <= Date.now()) || pool.backends[0];
        pool.take(b, 0);
      }
    } catch (e) {
      res.writeHead(e.status || 503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
    let released = false;
    const done = () => { if (!released) { released = true; pool.release(b, tokens); } };
    try {
      const up = await forward(b, req, body);
      if ((up.statusCode === 502 || up.statusCode === 503) && attempt < 2) {
        up.resume(); done(); b.downUntil = Date.now() + FAIL_SKIP_MS; tried.add(b); continue;
      }
      b.served += 1;
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      up.on('end', done);
      up.on('error', done);
      res.on('close', done);
      return;
    } catch {
      done(); b.downUntil = Date.now() + FAIL_SKIP_MS; tried.add(b);
    }
  }
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no backend answered' }));
  }
}

// ── start ───────────────────────────────────────────────────────────────────
const routes = (process.env.ROUTES || '').split(';').map((s) => s.trim()).filter(Boolean);
if (!routes.length) { console.error('ROUTES is not set (see the header of this file)'); process.exit(78); }

for (const r of routes) {
  const [name, port, spec] = r.split('|').map((s) => s.trim());
  const pool = new Pool(name, Number(port), spec);
  await pool.refresh();
  setInterval(() => pool.refresh(), REFRESH_MS).unref();
  http.createServer((req, res) => handle(pool, req, res).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  })).listen(pool.port, HOST, () => {
    const caps = pool.backends.map((b) => `${b.url} w${b.weight} ${b.capacity} tok/${b.slots} slots`).join(' | ');
    console.log(`[router] ${name} on ${HOST}:${port} -> ${caps}`);
  });
}
