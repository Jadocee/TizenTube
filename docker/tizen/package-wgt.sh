#!/usr/bin/env bash
# Builds and signs /work/standalone into a .wgt with the real Tizen SDK.
#
# Reads (either form of the certificate, file preferred):
#   /run/secrets/author.p12   the author certificate, bind-mounted
#   TIZEN_AUTHOR_KEY          or the same thing base64-encoded, as CI stores it
#   TIZEN_AUTHOR_KEY_PW       its password
# Writes:
#   /work/standalone/release/TizenTube.wgt
set -euo pipefail

readonly LIB=/opt/tizen
readonly WORK=${TT_WORKSPACE:-/work}
readonly SRC="$WORK/standalone"
readonly OUT=${TT_OUTPUT:-$SRC/release}
readonly PROFILE=TizenTube
# Everything the run needs to write, other than the finished widget, lives here
# -- inside the container, never in the mounted tree and never in a layer.
readonly SCRATCH=/tmp/tizen-build
readonly STAGE="$SCRATCH/stage"
readonly CERT="$SCRATCH/author.p12"

die() { echo "::error::$*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

# The CLI writes the real reason for most failures to its log and prints only
# "An error has occurred. See the log file" to stdout, so a failure that does not
# show the log is a failure nobody can act on.
dump_log() {
    local log="$TIZEN_STUDIO_DATA/cli/logs/cli.log"
    [ -f "$log" ] || return 0
    echo
    echo "---- last 40 lines of $log ----"
    tail -n 40 "$log"
    echo "---- end of log ----"
}
trap 'rc=$?; [ $rc -eq 0 ] || dump_log; exit $rc' EXIT

# ---- inputs ----------------------------------------------------------------

[ -d "$SRC" ] || die "$SRC does not exist. Mount the repository at $WORK -- see compose.yaml."
[ -s "$SRC/config.xml" ] || die "$SRC/config.xml is missing or empty."

# The widget is the BUILD, not the sources. config.xml points <tizen:service> at
# service/dist/index.js, so packaging without it produces a widget that installs
# and then does nothing -- the worst kind of success. Checked here rather than
# trusted, because this container deliberately does not carry the JS toolchain.
[ -s "$SRC/service/dist/index.js" ] || die "$SRC/service/dist/index.js is missing or empty. This image packages a build, it does not produce one -- run the three JS builds on the host first: (cd service && pnpm build) && (cd mods && pnpm build) && (cd standalone/service && pnpm build)"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH" "$STAGE"
chmod 700 "$SCRATCH"

step "Reading the author certificate"
if [ -s /run/secrets/author.p12 ]; then
    cp /run/secrets/author.p12 "$CERT"
    echo "using the certificate mounted at /run/secrets/author.p12"
elif [ -n "${TIZEN_AUTHOR_KEY:-}" ]; then
    printf '%s' "$TIZEN_AUTHOR_KEY" | base64 -d > "$CERT" 2>/dev/null ||
        die "TIZEN_AUTHOR_KEY is set but is not valid base64."
    echo "using the certificate decoded from TIZEN_AUTHOR_KEY"
else
    die "No author certificate. A Tizen widget has no unsigned form. Either mount one at /run/secrets/author.p12 (set TIZEN_AUTHOR_P12 before compose) or set TIZEN_AUTHOR_KEY to its base64. Installing as a TizenBrew module needs no certificate at all."
fi
[ -s "$CERT" ] || die "The author certificate is empty."
chmod 600 "$CERT"

PW="${TIZEN_AUTHOR_KEY_PW:-}"
[ -n "$PW" ] || die "TIZEN_AUTHOR_KEY_PW is not set. The .p12 cannot be opened without it."

# Fail here, with a sentence, rather than sixty seconds later inside a Java
# ASN.1 reader saying "Too few bytes to parse DER". The -legacy retry is not
# optional: OpenSSL 3 refuses ciphers that older .p12 files use and that the
# SDK's Java signer still accepts perfectly well.
export PW
openssl pkcs12 -in "$CERT" -noout -passin env:PW >/dev/null 2>&1 ||
    openssl pkcs12 -in "$CERT" -noout -legacy -passin env:PW >/dev/null 2>&1 ||
    die "The certificate is not a PKCS#12 file, or TIZEN_AUTHOR_KEY_PW does not open it."
echo "certificate opens with the supplied password"

# An author certificate cannot outlive the CA that issued it, and the Tizen
# Developers CA expires 2027-01-01. Worth a warning now rather than a mystery
# release failure later.
author_cert() {
    openssl pkcs12 -in "$CERT" -clcerts -nokeys -passin env:PW 2>/dev/null ||
        openssl pkcs12 -in "$CERT" -clcerts -nokeys -legacy -passin env:PW 2>/dev/null
}
if end="$(author_cert | openssl x509 -noout -enddate 2>/dev/null)" && [ -n "$end" ]; then
    echo "author certificate ${end}"
    author_cert | openssl x509 -noout -checkend 0 >/dev/null 2>&1 ||
        echo "::warning::the author certificate has EXPIRED; the SDK will sign with it anyway but a television may refuse the result"
fi

# ---- the signing profile ---------------------------------------------------

step "Registering the signing profile"
# The password reaches the CLI as an argv element and its launcher re-evaluates
# its own arguments, so a quote, a backslash or a tab in the password breaks the
# command rather than being passed through. Rejected here, with a sentence,
# rather than failing later inside a Java stack trace.
case "$PW" in
    *[\'\"\\]*|*"	"*)
        die "TIZEN_AUTHOR_KEY_PW contains a quote, a backslash or a tab. The Tizen CLI's launcher re-evaluates its own arguments, so a password containing one of those cannot be passed through it. Re-export the certificate with a password of ordinary printable characters."
        ;;
esac

# NOT relocated with `tizen cli-config`. That was the first thing tried and it
# silently does nothing: the CLI refuses to set any key in the `default.*`
# namespace as a global, prints the refusal to STDOUT and then exits 0 -- so with
# the output discarded it looks like it worked, the profile goes to the SDK's own
# data directory, and the run dies looking for a file that was never going to be
# there. Letting the SDK write where it likes and asking it where that was is
# simpler and cannot rot when a config key is renamed.
#
# Output captured rather than discarded for the same reason: this command prints
# the path it wrote, and the one time that matters is when something went wrong.
profile_out="$(tizen security-profiles add -n "$PROFILE" -a "$CERT" -p "$PW" -A -f 2>&1)" || {
    echo "$profile_out"
    die "tizen security-profiles add failed."
}

# "Wrote to '/path/profiles.xml'." is the CLI's own report; the documented
# default is the fallback if that wording ever changes.
PROFILES="$(sed -n "s/.*Wrote to '\\([^']*\\)'.*/\\1/p" <<<"$profile_out" | head -n1)"
[ -n "$PROFILES" ] && [ -f "$PROFILES" ] || PROFILES="$TIZEN_STUDIO_DATA/profile/profiles.xml"
[ -s "$PROFILES" ] || {
    echo "$profile_out"
    die "tizen security-profiles add reported success but wrote no profiles.xml; its full output is above."
}
echo "profile written to $PROFILES"

# Now replace every password the SDK stored as a keyring reference.
#
# It stores BOTH halves that way on Linux, not just the author's: the generated
# file gives the distributor a value ending in .pwd as well, pointing at a path
# that does not even exist, because it is a Secret Service lookup key rather than
# a file. Patching only the author entry leaves the distributor password
# unresolvable and packaging still dies with the same "Invaild password" this
# whole approach exists to avoid.
#
# The distributor is the SDK's own public signer, whose password is a documented
# constant. It is encoded with the same encoder rather than pasted as a literal,
# so the two can never disagree.
"$LIB/obfuscate-password.sh" --self-test >/dev/null ||
    die "The password encoder does not agree with the SDK's own stored value; refusing to write a profile the CLI cannot read."
AUTHOR_CIPHER="$(printf '%s' "$PW" | "$LIB/obfuscate-password.sh")"
DIST_CIPHER="$(printf '%s' 'tizenpkcs12passfordsigner' | "$LIB/obfuscate-password.sh")"

# python3 rather than sed because this is XML: attribute order is not guaranteed,
# and a regex over it is how you rewrite the wrong entry's password.
AUTHOR_CIPHER="$AUTHOR_CIPHER" DIST_CIPHER="$DIST_CIPHER" python3 - "$PROFILES" <<'PY'
import os, sys, xml.etree.ElementTree as ET

path = sys.argv[1]
author_cipher = os.environ["AUTHOR_CIPHER"]
dist_cipher = os.environ["DIST_CIPHER"]

tree = ET.parse(path)
root = tree.getroot()

authors = distributors = 0
for item in root.iter("profileitem"):
    # distributor="0" is the author entry; 1 and above are distributors.
    if item.get("distributor") == "0":
        item.set("password", author_cipher)
        authors += 1
    else:
        item.set("password", dist_cipher)
        distributors += 1

if authors != 1:
    sys.exit(f"expected exactly one author profileitem in {path}, found {authors}")
if distributors < 1:
    sys.exit(f"expected at least one distributor profileitem in {path}, found none")

tree.write(path, encoding="UTF-8", xml_declaration=True)

# Nothing may still point at the keyring, or signing fails headlessly with no
# useful message. Re-read from disk so this checks what was written.
stale = [
    v
    for v in (i.get("password") for i in ET.parse(path).getroot().iter("profileitem"))
    if v is None or v.endswith(".pwd")
]
if stale:
    sys.exit(f"{len(stale)} password(s) in {path} still reference the keyring: {stale}")
print(f"patched {authors} author and {distributors} distributor password(s)")
PY
chmod 600 "$PROFILES"

# ---- stage ------------------------------------------------------------------

step "Staging the widget source"
# Copied, never packaged in place. Two reasons, both about the mounted tree:
# `tizen package` writes .manifest.tmp, author-signature.xml and signature1.xml
# into whatever directory it packages, and CI's `rm -rf service/node_modules`
# would delete a developer's actual dependency tree on the host.
#
# Those same three names are also EXCLUDED, which is not redundant. A developer
# who has ever run `tizen package` against standalone/ directly -- which
# docs/BUILDING.md documents -- has left them lying in the tree. Staged, they
# would be packaged verbatim into the new .wgt, and a signature check that only
# asks whether those entries exist would then pass an unsigned archive carrying
# last month's signatures.
tar -C "$SRC" \
    --exclude=node_modules \
    --exclude=release \
    --exclude=userwidget \
    --exclude='*.wgt' \
    --exclude='.buildResult' \
    --exclude='author-signature.xml' \
    --exclude='signature1.xml' \
    --exclude='signature*.xml' \
    --exclude='.manifest.tmp' \
    -cf - . | tar -C "$STAGE" -xf -
echo "staged $(find "$STAGE" -type f | wc -l) files"

step "Building"
# -out is relative to the project directory. The default excludes already drop
# *.wgt, .build, .sign and .buildResult; the ones above cover the rest of what
# the tizen.js --ignore list dropped. Deliberately no -opt: it would re-minify a
# bundle rolldown has already minified.
tizen build-web -out .buildResult -- "$STAGE"

step "Packaging and signing"
mkdir -p "$SCRATCH/out"
tizen package -t wgt -s "$PROFILE" -o "$SCRATCH/out" -- "$STAGE/.buildResult"

# -o is a directory and the filename comes from <name> in config.xml, so this
# produces "TizenTube 9.wgt" -- with a space. Globbed rather than hardcoded so a
# rename in config.xml does not silently break the build.
shopt -s nullglob
built=("$SCRATCH"/out/*.wgt)
shopt -u nullglob
[ ${#built[@]} -eq 1 ] || die "expected exactly one .wgt in $SCRATCH/out, found ${#built[@]}."

step "Verifying the signatures"
# Before it is copied anywhere. tizen package exits 0 while writing an UNSIGNED
# archive if the profile is missing or its password is wrong, so this is the
# only reliable signal that signing happened.
"$LIB/verify-signed.sh" "${built[0]}"

mkdir -p "$OUT"
cp "${built[0]}" "$OUT/TizenTube.wgt"
echo
echo "==> ${OUT#"$WORK"/}/TizenTube.wgt  ($(du -h "$OUT/TizenTube.wgt" | cut -f1))"
unzip -l "$OUT/TizenTube.wgt"
