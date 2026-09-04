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
readonly PROFILES="$SCRATCH/profiles.xml"

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
if end="$(openssl pkcs12 -in "$CERT" -clcerts -nokeys -passin env:PW 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null)"; then
    echo "author certificate ${end}"
    openssl pkcs12 -in "$CERT" -clcerts -nokeys -passin env:PW 2>/dev/null |
        openssl x509 -noout -checkend 0 >/dev/null 2>&1 ||
        echo "::warning::the author certificate has EXPIRED; the SDK will sign with it anyway but a television may refuse the result"
fi

# ---- the signing profile ---------------------------------------------------

step "Registering the signing profile"
# Let the SDK write profiles.xml rather than hand-authoring its schema: it fills
# in the distributor half by itself (the public tizen-distributor-signer.p12,
# which is the same certificate the current tizen.js releases are signed with)
# and it gets the element shape right for whatever version of the format this
# SDK speaks.
tizen cli-config -g "default.profiles.path=$PROFILES" >/dev/null
tizen security-profiles add -n "$PROFILE" -a "$CERT" -p "$PW" -A -f >/dev/null ||
    die "tizen security-profiles add failed."
[ -s "$PROFILES" ] || die "tizen security-profiles add reported success but wrote no $PROFILES."

# ...and then fix the one thing it gets wrong headlessly. On Linux the CLI does
# not store the password in this file; it hands it to a bundled 32-bit secret-tool
# which puts it in the freedesktop Secret Service over D-Bus. With no session bus
# the profile is written, the command exits 0, and the password is nowhere -- so
# packaging fails later with "CertificationException: Invaild password" (sic).
#
# The file's password attribute accepts either form, chosen by whether the value
# ends in ".pwd", so writing the DESede ciphertext inline skips D-Bus, the
# keyring and the 32-bit binary at once. See obfuscate-password.sh.
#
# python3 rather than sed because this is XML: attribute order is not guaranteed
# and a regex over it is how you end up rewriting the distributor's password
# with the author's.
"$LIB/obfuscate-password.sh" --self-test >/dev/null ||
    die "The password encoder does not agree with the SDK's own stored value; refusing to write a profile the CLI cannot read."
CIPHER="$(printf '%s' "$PW" | "$LIB/obfuscate-password.sh")"

CIPHER="$CIPHER" python3 - "$PROFILES" <<'PY'
import os, sys, xml.etree.ElementTree as ET

path = sys.argv[1]
cipher = os.environ["CIPHER"]
tree = ET.parse(path)
root = tree.getroot()

# distributor="0" is the author entry; 1 and above are distributors, whose
# passwords the SDK already stores inline and correctly.
patched = 0
for item in root.iter("profileitem"):
    if item.get("distributor") == "0":
        item.set("password", cipher)
        patched += 1

if patched != 1:
    sys.exit(f"expected exactly one author profileitem in {path}, found {patched}")
tree.write(path, encoding="UTF-8", xml_declaration=True)
PY
chmod 600 "$PROFILES"
echo "profile '$PROFILE' registered with the password stored inline"

# ---- stage ------------------------------------------------------------------

step "Staging the widget source"
# Copied, never packaged in place. Two reasons, both about the mounted tree:
# `tizen package` writes .manifest.tmp, author-signature.xml and signature1.xml
# into whatever directory it packages, and CI's `rm -rf service/node_modules`
# would delete a developer's actual dependency tree on the host.
tar -C "$SRC" \
    --exclude=node_modules \
    --exclude=release \
    --exclude=userwidget \
    --exclude='*.wgt' \
    --exclude='.buildResult' \
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
