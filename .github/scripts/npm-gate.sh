#!/usr/bin/env bash
# Decides whether this CI run publishes the npm package TizenBrew installs.
#
# SEPARATE FROM release-gate.sh ON PURPOSE. The two delivery routes are
# independent: the TizenBrew module is an npm package and needs no certificate
# and no widget version, while the .wgt is a signed Tizen package and needs both.
# Keying both off one version would mean a fix that only matters to one route
# either shipping a package nobody needed or not shipping at all. So this reads
# the npm version out of package.json and release-gate.sh reads the widget
# version out of standalone/config.xml, and each publishes on its own terms.
#
# A tag push always publishes. A push to main publishes only when the version in
# package.json changed in that push. Everything else builds and verifies only --
# a pull request must never publish, because an npm version cannot be reused
# once taken.
#
# Reads:  GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME, EVENT_BEFORE
# Writes: publish=true|false, version=<version> and name=<package> to $GITHUB_OUTPUT
set -euo pipefail

MANIFEST="${NPM_MANIFEST:-package.json}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"

emit() { echo "$1" >> "$OUT"; }
no_publish() { echo "$1"; emit 'publish=false'; exit 0; }

# node, not sed: package.json is JSON and a regex over it is how you end up
# reading the version of something else. node is guaranteed present here -- the
# workflow has already installed it, and every other script in this directory
# assumes the same toolchain.
field() { node -e 'const p=require(process.argv[1]);process.stdout.write(String(p[process.argv[2]]??""))' "$PWD/$MANIFEST" "$1"; }

NAME="$(field name)"
VERSION="$(field version)"
if [ -z "$NAME" ] || [ -z "$VERSION" ]; then
    echo "::error::could not read name and version from $MANIFEST"
    exit 1
fi
emit "name=$NAME"
emit "version=$VERSION"

# The package is the BUILD, not the sources: main and serviceFile both point
# into dist/, which is gitignored. Publishing without them would put a manifest
# on the registry pointing at two files that are not in the tarball, and
# TizenBrew would install a module with no userscript and no service. Checked
# here rather than trusted, because the build steps are above this one and a
# reordering would not otherwise announce itself.
for required in $(node -e 'const p=require(process.argv[1]);process.stdout.write([p.main,p.serviceFile].filter(Boolean).join(" "))' "$PWD/$MANIFEST"); do
    if [ ! -s "$required" ]; then
        echo "::error::$MANIFEST points at $required, which is missing or empty; build before publishing"
        exit 1
    fi
done

if [ "${GITHUB_EVENT_NAME:-}" != "push" ]; then
    no_publish "not a push (${GITHUB_EVENT_NAME:-unknown}); build and verify only"
fi

if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    TAG="${GITHUB_REF_NAME:-}"
    if [ "$TAG" != "v$VERSION" ]; then
        echo "::warning::tag $TAG does not match the package version $VERSION in $MANIFEST"
    fi
    echo "tag push: publishing ${NAME}@${VERSION}"
    emit 'publish=true'
    exit 0
fi

BEFORE="${EVENT_BEFORE:-}"
if [ -z "$BEFORE" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ]; then
    no_publish "no previous commit to compare against; build and verify only"
fi
if ! git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
    no_publish "previous commit $BEFORE is not in this checkout; build and verify only"
fi

PREVIOUS="$(git show "${BEFORE}:${MANIFEST}" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version??""))}catch(e){}})' || true)"
echo "package version: ${PREVIOUS:-<absent>} -> ${VERSION}"

if [ "$PREVIOUS" = "$VERSION" ]; then
    no_publish "unchanged; build and verify only"
fi

echo "package version changed: publishing ${NAME}@${VERSION}"
emit 'publish=true'
