#!/usr/bin/env python3
"""LMDB env probe — lists named sub-DBs without reading any data.

Reads an LMDB env path from stdin, opens read-only, iterates the master DB
and tries env.open_db(key) for each entry. Real sub-DBs open successfully;
data keys (in single-namespace envs) raise lmdb.IncompatibleError.

Outputs JSON to stdout:
  {ok: true, exists: bool, env_path, sub_dbs: [...]}
  {ok: false, error: '...', env_path}
"""

import sys
import os
import json

try:
    import lmdb
except ImportError:
    print(json.dumps({'ok': False, 'error': 'lmdb python package not available'}))
    sys.exit(0)

env_path = sys.stdin.readline().strip()

if not os.path.exists(env_path):
    print(json.dumps({'ok': True, 'exists': False, 'env_path': env_path}))
    sys.exit(0)

try:
    env = lmdb.open(
        env_path,
        readonly=True,
        lock=False,
        max_dbs=128,
        subdir=os.path.isdir(env_path),
    )
except lmdb.Error as e:
    print(json.dumps({'ok': False, 'error': f'cannot open lmdb env: {e}', 'env_path': env_path}))
    sys.exit(0)

sub_dbs = []
try:
    with env.begin() as txn:
        cursor = txn.cursor()
        for key, _ in cursor:
            try:
                env.open_db(key, txn=txn)
                # Successful open means it's a real named sub-DB
                try:
                    sub_dbs.append(key.decode('utf-8'))
                except UnicodeDecodeError:
                    sub_dbs.append('hex:' + key.hex())
            except lmdb.Error:
                # Not a sub-DB — just a data key in the master namespace
                pass
except lmdb.Error as e:
    env.close()
    print(json.dumps({'ok': False, 'error': f'cannot iterate master db: {e}', 'env_path': env_path}))
    sys.exit(0)

env.close()
print(json.dumps({
    'ok': True,
    'exists': True,
    'env_path': env_path,
    'sub_dbs': sub_dbs,
}))
