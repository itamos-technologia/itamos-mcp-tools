/**
 * DuckDB L3 adapter — PLANNED, NOT IMPLEMENTED.
 *
 * What this adapter should do:
 *   DuckDB query validation via prepare() (SQLite-shaped, embedded)
 *
 * Recognise (in JS parser walkDatabases):
   *     new duckdb.Database('path')         — `duckdb` driver (sync API)
   *     duckdb.async.Database.create(...)   — `duckdb-async` driver
 *
 * Recognise (in Python parser walkDatabases):
   *     duckdb.connect('path')              — `duckdb` package
   *     duckdb.connect()                    — in-memory; treat as unverifiable
 *
 * Driver: duckdb (npm package — sync API is fine for prepare-only)
 *
 * Reference: lib/adapters/sqlite/ — structurally identical (embedded, file-based, prepare()-validates)
 *
 * To implement:
 *   1. Set implemented = true
 *   2. Implement check(absPath, db) following the contract in ../_contract.js
 *   3. Add the npm dep to parent's package.json if not already present
 *   4. Restart the verifier; the dispatcher picks up the new implementation
 *      automatically (no edits needed to _dispatcher.js or anywhere else)
 */

export const type = 'duckdb';
export const implemented = false;
export const description = 'DuckDB query validation via prepare() (SQLite-shaped, embedded)';
export const driverHint = 'duckdb (npm package — sync API is fine for prepare-only)';

export async function check(absPath, db) {
  throw new Error(
    "DuckDB adapter not implemented yet — see comment block in " +
    "lib/adapters/duckdb/index.js for spec. Reference: lib/adapters/sqlite/ — structurally identical (embedded, file-based, prepare()-validates)"
  );
}
