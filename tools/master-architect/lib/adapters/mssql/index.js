/**
 * MS SQL Server L3 adapter — PLANNED, NOT IMPLEMENTED.
 *
 * What this adapter should do:
 *   MS SQL Server query validation via SET PARSEONLY ON
 *
 * Recognise (in JS parser walkDatabases):
   *     new mssql.ConnectionPool({...})     — `mssql` driver
   *     mssql.connect({...})                — `mssql` connection function
 *
 * Recognise (in Python parser walkDatabases):
   *     pyodbc.connect('DSN=...; ...')      — pyodbc with connection string
   *     pymssql.connect(server, user, ...)  — pymssql
 *
 * Driver: mssql (npm package, promise-based)
 *
 * Reference: lib/adapters/postgres/ — same network-DB shape with auth
 *
 * To implement:
 *   1. Set implemented = true
 *   2. Implement check(absPath, db) following the contract in ../_contract.js
 *   3. Add the npm dep to parent's package.json if not already present
 *   4. Restart the verifier; the dispatcher picks up the new implementation
 *      automatically (no edits needed to _dispatcher.js or anywhere else)
 */

export const type = 'mssql';
export const implemented = false;
export const description = 'MS SQL Server query validation via SET PARSEONLY ON';
export const driverHint = 'mssql (npm package, promise-based)';

export async function check(absPath, db) {
  throw new Error(
    "MS SQL Server adapter not implemented yet — see comment block in " +
    "lib/adapters/mssql/index.js for spec. Reference: lib/adapters/postgres/ — same network-DB shape with auth"
  );
}
