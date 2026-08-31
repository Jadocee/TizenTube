#!/usr/bin/env bash
# Decides whether this CI run publishes a release, and under which tag.
#
# A tag push always publishes. A push to main publishes only when the widget
# version in standalone/config.xml changed in that push -- that is the version
# the television uses for install and upgrade semantics, so shipping two
# packages carrying the same one gives people a .wgt they cannot cleanly install
# over what they already have. Everything else builds and verifies only.
#
# Deliberately NOT `git describe --tags`: that returns the latest EXISTING tag,
# which on a push to main is the PREVIOUS release. Using it here would re-publish
# over that tag and move it onto a new commit.
#
# Reads:  GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME, EVENT_BEFORE
# Writes: release=true|false and tag=<name> to $GITHUB_OUTPUT
set -euo pipefail

CONFIG="${CONFIG_XML:-standalone/config.xml}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"

emit() { echo "$1" >> "$OUT"; }
no_release() { echo "$1"; emit 'release=false'; exit 0; }

# Anchored on the <widget> element on purpose. An unanchored version="..." match
# takes the XML declaration on line 1 and yields "1.0" -- which is what the
# previous inline version of this logic did, and since the repository had no
# tags, that fallback was exactly the path a first release would have taken.
widget_version() { sed -n 's/.*<widget[^>]*version="\([^"]*\)".*/\1/p' | head -n1; }

VERSION="$(widget_version < "$CONFIG")"
if [ -z "$VERSION" ]; then
    echo "::error::could not read the widget version from $CONFIG"
    exit 1
fi

if [ "${GITHUB_EVENT_NAME:-}" != "push" ]; then
    no_release "not a push (${GITHUB_EVENT_NAME:-unknown}); build and verify only"
fi

if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    TAG="${GITHUB_REF_NAME:-}"
    if [ "$TAG" != "v$VERSION" ]; then
        echo "::warning::tag $TAG does not match the widget version $VERSION in $CONFIG"
    fi
    echo "tag push: publishing $TAG"
    emit 'release=true'
    emit "tag=$TAG"
    exit 0
fi

BEFORE="${EVENT_BEFORE:-}"
# A branch that did not exist before this push has no previous state to compare
# against. Publishing on that is a surprise, so it does not.
if [ -z "$BEFORE" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ]; then
    no_release "no previous commit to compare against; build and verify only"
fi
if ! git cat-file -e "${BEFORE}^{commit}" 2>/dev/null; then
    no_release "previous commit $BEFORE is not in this checkout; build and verify only"
fi

PREVIOUS="$(git show "${BEFORE}:${CONFIG}" 2>/dev/null | widget_version || true)"
echo "widget version: ${PREVIOUS:-<absent>} -> ${VERSION}"

if [ "$PREVIOUS" = "$VERSION" ]; then
    no_release "unchanged; build and verify only"
fi

# Never move an existing tag onto a new commit: someone may already have that
# .wgt installed, and a moved tag makes the release they downloaded
# unreproducible.
if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null 2>&1; then
    echo "::warning::v${VERSION} already exists as a tag; not re-publishing it"
    no_release "tag exists; build and verify only"
fi

echo "widget version changed: publishing v${VERSION}"
emit 'release=true'
emit "tag=v${VERSION}"
