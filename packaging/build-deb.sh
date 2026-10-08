#!/bin/sh
# Build the slim .deb from the last commit (git archive, so only committed,
# tracked files go in). Output: dist/itamos-mcp-tools_<version>_all.deb
# Usage: packaging/build-deb.sh
set -eu

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
NAME="itamos-mcp-tools_${VERSION}_all"
WORK=$(mktemp -d)
STAGE="$WORK/$NAME"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$STAGE/DEBIAN" "$STAGE/opt/itamos-mcp-tools" "$STAGE/etc/itamos-mcp-tools" \
         "$STAGE/lib/systemd/system" "$STAGE/usr/sbin"

# The code: committed files only, without the docs generator and packaging sources.
git archive --format=tar HEAD | tar -x -C "$STAGE/opt/itamos-mcp-tools" \
  --exclude='docs' --exclude='packaging' --exclude='.gitignore'

sed "s/@VERSION@/$VERSION/" packaging/deb/control > "$STAGE/DEBIAN/control"
for f in postinst prerm postrm; do
  install -m 0755 "packaging/deb/$f" "$STAGE/DEBIAN/$f"
done
echo /etc/itamos-mcp-tools/env > "$STAGE/DEBIAN/conffiles"
install -m 0644 packaging/deb/env "$STAGE/etc/itamos-mcp-tools/env"
install -m 0644 packaging/deb/itamos-mcp-tools.service "$STAGE/lib/systemd/system/itamos-mcp-tools.service"
install -m 0755 packaging/deb/itamos-mcp-create-slots "$STAGE/usr/sbin/itamos-mcp-create-slots"

SIZE=$(du -sk "$STAGE" | cut -f1)
echo "Installed-Size: $SIZE" >> "$STAGE/DEBIAN/control"

mkdir -p dist
dpkg-deb --root-owner-group --build "$STAGE" "dist/$NAME.deb" >/dev/null
echo "Built dist/$NAME.deb ($(du -h "dist/$NAME.deb" | cut -f1))"
