// Shared pool for the heavy background work: validating one file (a child
// process) or indexing one large file. At most POOL_SIZE such jobs run at
// once across all sandboxes; each sandbox runs at most one at a time (its
// validation queue and its large-file indexer never overlap, see read_file.js
// and lib/scan.js). A job takes a permit before it starts and returns it when
// it ends; when every permit is taken, waiters are served in arrival order,
// so busy sandboxes take turns one file at a time.

const POOL_SIZE = Math.max(1, parseInt(process.env.WORK_POOL_SIZE || '16', 10) || 16);

let _inUse = 0;
const _waiters = [];   // resolve functions, oldest first

export function acquireWorker() {
  if (_inUse < POOL_SIZE) { _inUse += 1; return Promise.resolve(); }
  return new Promise((resolve) => _waiters.push(resolve));
}

export function releaseWorker() {
  const next = _waiters.shift();
  if (next) next();          // the permit passes straight to the next waiter
  else _inUse = Math.max(0, _inUse - 1);
}

// Run fn as one heavy job of sandbox `key`: first wait for that sandbox's
// previous job (never two at once in one sandbox), then for a pool permit.
// The permit and the sandbox turn are always given back.
const _keyTail = new Map();   // key -> promise of that sandbox's latest job
export async function withWorker(key, fn) {
  const prev = _keyTail.get(key) || Promise.resolve();
  let finish;
  const mine = new Promise((resolve) => { finish = resolve; });
  const tail = prev.then(() => mine);
  _keyTail.set(key, tail);
  try {
    await prev;
    await acquireWorker();
    try { return await fn(); } finally { releaseWorker(); }
  } finally {
    finish();
    if (_keyTail.get(key) === tail) _keyTail.delete(key);
  }
}

export function workPoolStatus() {
  return { size: POOL_SIZE, in_use: _inUse, waiting: _waiters.length };
}

// Key of the sandbox the current call runs for (its slot folder), or one key
// for the whole process outside the sandbox.
export function workKey() {
  return globalThis.__sandboxCtx?.getStore?.()?.slotDir || process.env.MASTER_ARCHITECT_DB || 'default';
}
