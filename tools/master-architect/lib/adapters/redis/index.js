/**
 * Redis L3 adapter — PLANNED, NOT IMPLEMENTED.
 *
 * What this adapter should do:
 *   Redis connection check (key-value, no schema validation)
 *
 * Recognise (in JS parser walkDatabases):
   *     redis.createClient({...})            — `redis` v4+
   *     new Redis({...})                     — `ioredis`
   *     new Redis('redis://host:port')       — ioredis URL constructor
 *
 * Recognise (in Python parser walkDatabases):
   *     redis.Redis(host=, port=, ...)       — `redis-py`
   *     redis.from_url('redis://...')
 *
 * Driver: redis v4+ (npm, native promises) or ioredis
 *
 * Reference: lib/adapters/lmdb/ — also key-value oriented
 *
 * To implement:
 *   1. Set implemented = true
 *   2. Implement check(absPath, db) following the contract in ../_contract.js
 *   3. Add the npm dep to parent's package.json if not already present
 *   4. Restart the verifier; the dispatcher picks up the new implementation
 *      automatically (no edits needed to _dispatcher.js or anywhere else)
 */

export const type = 'redis';
export const implemented = false;
export const description = 'Redis connection check (key-value, no schema validation)';
export const driverHint = 'redis v4+ (npm, native promises) or ioredis';

export async function check(absPath, db) {
  throw new Error(
    "Redis adapter not implemented yet — see comment block in " +
    "lib/adapters/redis/index.js for spec. Reference: lib/adapters/lmdb/ — also key-value oriented"
  );
}
