#!/bin/sh
# Create the sandbox slots as ZFS datasets: one dataset per slot, each with a hard
# size limit (quota) and lz4 compression. The server refuses to start without them.
#
# Usage (as root):
#   sudo scripts/create-slots.sh <parent-dataset> [count] [quota] [owner]
#
#   parent-dataset  e.g. tank/sandboxes (created if missing, in an existing pool)
#   count           number of slots, default 500
#   quota           size limit per slot, default 2G
#   owner           user the server runs as, default the user who ran sudo
#
# Example:
#   sudo scripts/create-slots.sh tank/sandboxes 500 2G mcp
#
# Safe to run again: existing slots keep their files; quota, compression and
# ownership are (re)applied. Then start the server with the SANDBOX_ROOT and
# SANDBOX_TOTAL_SLOTS printed at the end.
set -eu

PARENT=${1:?usage: create-slots.sh <parent-dataset> [count] [quota] [owner]}
COUNT=${2:-500}
QUOTA=${3:-2G}
OWNER=${4:-${SUDO_USER:-$(id -un)}}

command -v zfs >/dev/null 2>&1 || {
  echo "zfs not found. Install ZFS first (Debian/Ubuntu: apt install zfsutils-linux) and create a pool." >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo): creating datasets needs it." >&2; exit 1; }
id "$OWNER" >/dev/null 2>&1 || { echo "User '$OWNER' does not exist." >&2; exit 1; }

if ! zfs list -H -o name "$PARENT" >/dev/null 2>&1; then
  zfs create -o compression=lz4 "$PARENT"
fi
zfs set compression=lz4 "$PARENT"
ROOT=$(zfs get -H -o value mountpoint "$PARENT")

i=1
while [ "$i" -le "$COUNT" ]; do
  name=$(printf 'slot_%03d' "$i")
  ds="$PARENT/$name"
  zfs list -H -o name "$ds" >/dev/null 2>&1 || zfs create "$ds"
  zfs set quota="$QUOTA" "$ds"
  chown "$OWNER": "$ROOT/$name"
  chmod 755 "$ROOT/$name"
  i=$((i + 1))
done

echo "Ready: $COUNT slots under $ROOT (quota $QUOTA each, lz4 compression, owner $OWNER)."
echo "Start the server with: SANDBOX_ROOT=$ROOT SANDBOX_TOTAL_SLOTS=$COUNT npm start"
