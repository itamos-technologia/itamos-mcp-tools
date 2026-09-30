# MySQL PREPARE-FROM-parameter limitation — PLANNED INVESTIGATION

## The bug

MySQL/MariaDB adapter currently validates queries via:

```sql
PREPARE stmt_name FROM ?
```

with the SQL passed as a parameter. This works for most cases but appears to short-circuit on certain syntax errors before they can be reported.

## Observed in real session 2026-05-08

Test file `bad.js` had three intentional bugs:
  1. `SELECT id, username, email FROM customers ...` (column `username` doesn't exist) → caught ✓
  2. `SELECT order_id, total FROM order_records ...` (table `order_records` doesn't exist) → caught ✓
  3. `SELEKT * FROM customers` (typo of SELECT) → NOT caught ✗

The third one slipped through. The verifier reported only "2 of 2 failed" and the SELEKT query was apparently valid.

## Why this likely happens

`PREPARE stmt FROM ?` with a parameter goes through MySQL's binary protocol. The server may not fully parse the parameter as SQL until execution time, OR the prepared-statement-via-parameter path is more lenient than the literal-string PREPARE.

The literal form `PREPARE stmt FROM 'SELECT ...'` would parse the SQL at PREPARE time and throw on syntax errors immediately. The parameter form might defer parsing.

## Investigation needed

Test both forms against the SELEKT case:
  1. `PREPARE stmt FROM ?` with `?` = `'SELEKT * FROM customers'` (current adapter behavior)
  2. `PREPARE stmt FROM 'SELEKT * FROM customers'` (literal form, would need careful escaping)

If form 2 catches the syntax error and form 1 doesn't, the fix is to switch to literal form. Escaping concern: SQL literals embedded in PREPARE need the inner SQL to escape any single quotes. Doable with a simple replace, but adds a layer.

If form 2 also doesn't catch it, the issue is elsewhere — possibly in mysql2 driver's protocol handling of malformed SQL.

## Workaround in the meantime

The two main bug classes (wrong column, wrong table) ARE caught. Pure syntax-typo bugs slip through. Lower priority than schema-mismatch detection because syntax typos usually fail at runtime AND are caught by IDE syntax highlighting, while schema mismatches are exactly the silent-bug category the verifier exists to catch.

## Effort estimate

~30 minutes to test both forms and decide on the fix. Implementation either way is ~15 more minutes (switch to literal form with escaping, or accept the limitation and document).

## When to fix

Lower priority than placeholder translation. The placeholder issue produces false positives (annoying); this issue produces false negatives (a class of bug we miss). False negatives in syntax errors are tolerable because typos fail loudly elsewhere; false positives in adapter output erode trust.

Address after launch unless an audit run surfaces it as a frequent problem.
