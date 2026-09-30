# MariaDB datadir migration — DEFERRED

## Status

MariaDB 11.8 is installed and running on Monster, but its datadir is at `/var/lib/mariadb` instead of on the `/tank` ZFS pool. This violates the rule "no datasets, databases, or scripts outside /tank".

## Why deferred

The default install was working when discovered during MariaDB adapter setup (2026-05-08). Stopping the service, moving data, and updating config is ~15 minutes of work that interrupts adapter development. The data at the default location is currently empty (no real schemas yet, only adapter-test tables we'll create).

## When to do it

Before any production data lands in MariaDB. Currently safe because nothing valuable is there, but the moment we start using MariaDB for anything that matters, this needs to happen first.

## Steps to migrate

```bash
sudo systemctl stop mariadb
sudo mkdir -p /tank/db/mariadb
sudo rsync -av /var/lib/mariadb/ /tank/db/mariadb/
sudo chown -R mysql:mysql /tank/db/mariadb
# Edit /etc/mysql/mariadb.conf.d/50-server.cnf (or appropriate file) and set:
#   datadir = /tank/db/mariadb
sudo systemctl start mariadb
# Verify with: sudo mariadb -e "SHOW VARIABLES LIKE 'datadir';"
```

If migration fails, the original /var/lib/mariadb data is still there (rsync didn't delete) — just revert the config and restart.
