/**
 * MongoDB L3 adapter — PLANNED, NOT IMPLEMENTED.
 *
 * What this adapter should do:
 *   MongoDB collection-existence check (no schema validation v1)
 *
 * Recognise (in JS parser walkDatabases):
   *     new MongoClient('mongodb://host/db') — `mongodb` driver
   *     mongoose.connect('mongodb://...')    — `mongoose` ORM
 *
 * Recognise (in Python parser walkDatabases):
   *     pymongo.MongoClient('mongodb://...') — pymongo
   *     motor.motor_asyncio.AsyncIOMotorClient() — motor (async pymongo)
 *
 * Driver: mongodb (npm package, official driver)
 *
 * Reference: lib/adapters/lmdb/ — namespace-existence check rather than schema validation
 *
 * To implement:
 *   1. Set implemented = true
 *   2. Implement check(absPath, db) following the contract in ../_contract.js
 *   3. Add the npm dep to parent's package.json if not already present
 *   4. Restart the verifier; the dispatcher picks up the new implementation
 *      automatically (no edits needed to _dispatcher.js or anywhere else)
 */

export const type = 'mongodb';
export const implemented = false;
export const description = 'MongoDB collection-existence check (no schema validation v1)';
export const driverHint = 'mongodb (npm package, official driver)';

export async function check(absPath, db) {
  throw new Error(
    "MongoDB adapter not implemented yet — see comment block in " +
    "lib/adapters/mongodb/index.js for spec. Reference: lib/adapters/lmdb/ — namespace-existence check rather than schema validation"
  );
}
