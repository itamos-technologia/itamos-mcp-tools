# Python placeholder translation for MySQL/Postgres adapters — PLANNED FIX

## The bug

Python code uses DB-API placeholder syntax that's driver-side, not server-side:

  - `cursor.execute('SELECT ... WHERE id = %s', (id,))`  — pymysql, mysql.connector, psycopg2
  - `cursor.execute('SELECT ... WHERE id = ?', (id,))`   — sqlite3, mariadb-connector-python (some)

The `%s` placeholder is substituted by the driver before sending to the server. The server never sees `%s`.

When the L3 verifier extracts these queries and runs `PREPARE stmt FROM 'SELECT ... WHERE id = %s'` against the live server, MySQL/MariaDB/Postgres reject with a syntax error because they expect their own placeholder style (`?` for MySQL/MariaDB, `$1, $2, ...` for Postgres).

## Observed in real session 2026-05-08

Test file `pyclient.py` calling `cursor.execute('SELECT id, fullname FROM customers WHERE id = %s', (cid,))` produced:

  > "You have an error in your SQL syntax; check the manual that corresponds to your MariaDB server version for the right syntax to use near '%s' at line 1"

The intended catch was the schema mismatch (column `fullname` doesn't exist; correct name is `name`). Instead we false-positive-caught a syntax error that doesn't actually exist in the running code.

This affects:
  - Python + MySQL/MariaDB (pymysql, mysql.connector — both use `%s`)
  - Python + Postgres (psycopg2 — uses `%s`)
  - Python + SQLite is fine (sqlite3 uses `?` natively)
  - All JS adapters fine (drivers natively use the server-side placeholder style)

## The fix

In each adapter (mysql, postgres) inside the check function, before calling PREPARE, detect Python-style placeholders in the query and translate them:

  1. Detect: query contains `%s` or `%(name)s` AND the source file's language is Python (we know this from the `files.language` column joined onto the query)
  2. Translate to the server's native style:
     - MySQL/MariaDB: `%s` → `?`, `%(name)s` → `?` with name-tracking dropped (positional binding)
     - Postgres: `%s` → `$1, $2, $3, ...` (numbered, in order of appearance), `%(name)s` → likewise
  3. Run PREPARE on the translated query

Edge case: a literal `%s` inside a string literal (e.g., `WHERE name LIKE '%s'`) should NOT be translated. This means a real SQL parser is needed, not a regex. Cheap version: check if `%s` is inside a string literal (track quote state across the SQL) and skip translation for those.

## Implementation order

1. Add a `getQueryLanguage()` helper that pulls the source file's language for each query group
2. Add `translatePythonPlaceholdersForMysql(sql)` and `translatePythonPlaceholdersForPostgres(sql)` helpers (with quote-aware skipping)
3. Apply translation in the per-query loop, before PREPARE
4. Test against pyclient.py — the schema mismatch should now surface instead of the syntax error

## Effort estimate

~1.5 hours including the quote-aware translation and tests against existing test files.

## When to build

Before launch — Python + MySQL/Postgres is a real combination customers will use. Without this, every Python codebase produces false-positive syntax errors that mask the real schema bugs underneath.

Priority: high. Same level as MySQL adapter itself.
