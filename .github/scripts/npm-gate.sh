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
# THE RULE: a push publishes when the version named in package.json is not yet
# on the registry. A pull request never publishes, because an npm version cannot
# be reused once taken and cannot meaningfully be unpublished after 72 hours.
#
# It used to be "publishes when the version changed in this push", which is a
# proxy for the same thing and wrong in both directions. On a push to main it
# cannot make a FIRST publish -- the commit that adds publishing does not itself
# change the version, so the package never reaches the registry and the next bump
# is the earliest it could -- and it cannot recover from a publish that failed
# after the gate opened, since the version has by then stopped changing. (A tag
# push was the one way out: the old script published on any tag unconditionally,
# without consulting the version at all.) In the other direction the diff opens
# the gate for a version already taken, where the only possible outcome is a 403
# and a red main. Asking the registry answers the question the diff was
# approximating.
#
# The diff rule survives as the fallback for when the registry cannot be
# reached, so a network failure degrades to the old behaviour rather than
# either skipping a release or publishing blind.
#
# Reads:  GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME, EVENT_BEFORE
# Writes: publish=true|false, version=<version> and name=<package> to $GITHUB_OUTPUT
set -euo pipefail

MANIFEST="${NPM_MANIFEST:-package.json}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"

emit() { echo "$1" >> "$OUT"; }
no_publish() { echo "$1"; emit 'publish=false'; exit 0; }
publish() { echo "$1"; emit 'publish=true'; exit 0; }

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

# A tag that disagrees with the manifest is worth saying out loud wherever the
# decision lands: the tag is what a human reads off the releases page, and the
# manifest is what actually gets published.
if [ "${GITHUB_REF_TYPE:-}" = "tag" ] && [ "${GITHUB_REF_NAME:-}" != "v$VERSION" ]; then
    echo "::warning::tag ${GITHUB_REF_NAME:-<unset>} does not match the package version $VERSION in $MANIFEST"
fi

# Four answers, not two. One `npm view <package> --json` answers both questions
# this gate has -- is this exact version taken, and would publishing it move the
# registry's `latest` backwards -- and .github/scripts/registry-state.mjs reads
# the packument, because both are semver questions and semver is not string
# comparison. The registry stores 1.2.3+ci as 1.2.3, and 1.9.0 sorts after
# 1.10.0 as text; a shell string match gets both wrong in the direction that
# publishes.
#
# npm exits non-zero with code E404 when the package is unknown, which is a real
# answer: nothing is published, so this would be the first. Any other failure (a
# network drop, a proxy 502, npm missing from PATH) is NOT an answer, and
# treating it as one would publish blind or silently skip a release.
#
# Sets globals rather than echoing its answer, because $(...) would run it in a
# subshell and the error text would not survive to be logged.
#
# Here-strings, not pipes: `grep -q` exits the moment it matches, and under
# `set -o pipefail` the SIGPIPE that gives the writer would make a successful
# match read as a failed pipeline.
HERE="$(cd "$(dirname "$0")" && pwd)"
REGISTRY_STATE=''
REGISTRY_LATEST=''
REGISTRY_ERROR=''
probe_registry() {
    local out status err_file verdict
    err_file="$(mktemp)"
    out="$(npm view "$NAME" --json 2>"$err_file")" && status=0 || status=$?
    REGISTRY_ERROR="$(cat "$err_file")"
    rm -f "$err_file"

    if [ "$status" -ne 0 ]; then
        if grep -q 'code E404' <<<"$REGISTRY_ERROR"; then
            REGISTRY_STATE=absent
        else
            REGISTRY_STATE=unknown
        fi
        return
    fi

    verdict="$(node "$HERE/registry-state.mjs" "$VERSION" <<<"$out")" || verdict=unknown
    case "$verdict" in
        present) REGISTRY_STATE=present ;;
        absent) REGISTRY_STATE=absent ;;
        older\ *)
            REGISTRY_STATE=older
            REGISTRY_LATEST="${verdict#older }"
            ;;
        *) REGISTRY_STATE=unknown ;;
    esac
}

probe_registry
case "$REGISTRY_STATE" in
    present)
        no_publish "${NAME}@${VERSION} is already on the registry; build and verify only"
        ;;
    absent)
        publish "${NAME}@${VERSION} is not on the registry yet: publishing"
        ;;
    older)
        # Publishing this would move the `latest` dist-tag backwards, and
        # TizenBrew resolves the module through that tag with no version pin --
        # so every television would install the older build on its next check.
        # The likeliest way to get here is re-running an old workflow run from a
        # commit whose version has since been superseded.
        echo "::warning::${NAME}@${VERSION} is behind the published latest (${REGISTRY_LATEST}), so publishing it would move the npm latest tag backwards. Not publishing. Publish a back-version by hand with an explicit --tag if that is really what you want."
        no_publish "behind ${REGISTRY_LATEST}; build and verify only"
        ;;
    *)
        # Deliberately not fatal. A registry that cannot be reached is a reason
        # to fall back to what we can work out locally, not a reason to fail a
        # run whose build and tests have already passed. Note the fallback is
        # the old rule in full, tag branch included -- see docs/BUILDING.md.
        echo "::warning::could not ask the registry whether ${NAME}@${VERSION} exists; falling back to the version-changed rule"
        head -n 5 <<<"$REGISTRY_ERROR"
        ;;
esac

# ---- fallback: did the version change in this push? -------------------------

if [ "${GITHUB_REF_TYPE:-}" = "tag" ]; then
    publish "tag push: publishing ${NAME}@${VERSION}"
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

publish "package version changed: publishing ${NAME}@${VERSION}"
