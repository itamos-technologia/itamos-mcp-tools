/**
 * L3 Verification Adapter Contract
 * ================================
 *
 * Every adapter is a self-contained directory under lib/adapters/<type>/
 * with an index.js that exports the standard interface defined here.
 *
 * The dispatcher (lib/adapters/_dispatcher.js) discovers adapters by
 * convention: any directory whose name doesn't start with "_" and which
 * contains an index.js is an adapter. The dispatcher imports each
 * lazily (only when a file actually uses that DB type) and routes
 * verification requests through them.
 *
 * Required exports
 * ----------------
 *
 * export const type = 'sqlite' | 'postgres' | 'lmdb' | 'mysql' | ...
 *   String identifier matching the value stored in master-architect's
 *   `databases.type` column. The dispatcher uses this to route queries.
 *
 * export const implemented = true | false
 *   When false, the adapter is a planned-but-not-built stub. The
 *   dispatcher reports "no adapter for type X" with a pointer to the
 *   stub file's spec comment. When true, the adapter will be invoked
 *   for matching queries.
 *
 * export const description = 'human-readable one-liner'
 *   Surfaced in error messages and adapter listings.
 *
 * export const driverHint = 'npm package or system dep needed'
 *   For adapters whose deps are non-trivial, this string explains what
 *   needs to be installed (e.g., 'pg' for postgres, 'system python3-lmdb'
 *   for lmdb). Used when the adapter fails to load due to missing deps.
 *
 * export async function check(absPath, db)
 *   The verification function. Receives:
 *     absPath  — absolute path to the file being verified
 *     db       — open better-sqlite3 connection to the architect DB
 *                (read-only for the adapter — never write to architect DB)
 *
 *   Returns:
 *     { ok: true,  checked: N, failures: [], diagnostics: [...] }
 *     { ok: false, checked: N, failures: [{ line, ..., error }], diagnostics: [...] }
 *     { ok: true,  checked: 0, note: 'reason for skipping' }
 *
 *   The shape is uniform across all adapters so the dispatcher can
 *   aggregate without type-specific knowledge.
 *
 * Self-containment rules
 * ----------------------
 *
 * 1. An adapter must not import from outside its own directory or from
 *    standard Node modules. No reaching into ../../../something/.
 *
 * 2. If an adapter needs a probe script (like the python LMDB probe),
 *    that script lives inside the adapter's directory.
 *
 * 3. If an adapter needs an npm package, the parent's package.json
 *    declares it. The adapter documents this need via driverHint.
 *
 * 4. Adapters never reach into other adapters. Cross-cutting concerns
 *    (e.g., shared helpers) live in lib/adapters/_helpers.js, NOT
 *    spread across siblings.
 *
 * 5. An adapter's failure mode is well-defined: throws bubble up to
 *    the dispatcher which catches them and surfaces them as L3 failures
 *    rather than crashing the verifier.
 *
 * Adding a new adapter
 * --------------------
 *
 * 1. Create lib/adapters/<type>/index.js with the required exports.
 *    Set implemented=false initially with a throw in check().
 * 2. If needed, add a probe script in the same directory.
 * 3. If needed, add the driver dep to the parent's package.json and
 *    document via driverHint.
 * 4. The dispatcher picks it up automatically on next load — no other
 *    edits needed.
 *
 * The architect tool can be pointed at lib/adapters/ to track adapter
 * progress as a project: each unverified adapter file is work-to-do.
 */

// This file is documentation only. No runtime exports.
export const ADAPTER_CONTRACT_VERSION = 1;
