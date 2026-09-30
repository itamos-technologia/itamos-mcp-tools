/**
 * ClickHouse L3 adapter — PLANNED, NOT IMPLEMENTED.
 *
 * What this adapter should do:
 *   ClickHouse query validation via EXPLAIN PLAN
 *
 * Recognise (in JS parser walkDatabases):
   *     createClient({ host: 'http://...', ... })  — `@clickhouse/client`
 *
 * Recognise (in Python parser walkDatabases):
   *     clickhouse_driver.Client('host', ...)      — `clickhouse-driver`
   *     clickhouse_connect.get_client(...)         — `clickhouse-connect`
 *
 * Driver: @clickhouse/client (npm, official)
 *
 * Reference: lib/adapters/postgres/ — network-connected SQL DB, very similar shape
 *
 * To implement:
 *   1. Set implemented = true
 *   2. Implement check(absPath, db) following the contract in ../_contract.js
 *   3. Add the npm dep to parent's package.json if not already present
 *   4. Restart the verifier; the dispatcher picks up the new implementation
 *      automatically (no edits needed to _dispatcher.js or anywhere else)
 */

export const type = 'clickhouse';
export const implemented = false;
export const description = 'ClickHouse query validation via EXPLAIN PLAN';
export const driverHint = '@clickhouse/client (npm, official)';

export async function check(absPath, db) {
  throw new Error(
    "ClickHouse adapter not implemented yet — see comment block in " +
    "lib/adapters/clickhouse/index.js for spec. Reference: lib/adapters/postgres/ — network-connected SQL DB, very similar shape"
  );
}
