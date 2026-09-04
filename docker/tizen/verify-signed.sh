#!/usr/bin/env bash
# Fails unless a .wgt actually carries both signatures.
#
# NOT DECORATION. `tizen package` exits 0 and writes an UNSIGNED archive when the
# security profile it was told to use does not exist -- the only sign is a
# "Warning: Not found tizen signature file" line on stdout, among many other
# lines. A pipeline that trusts the exit code therefore publishes an unsigned
# widget, which a television refuses to install, and the failure surfaces on the
# TV rather than in the build.
#
# A Tizen widget carries two signatures with different jobs:
#   author-signature.xml  the developer's own certificate, over the payload
#   signature1.xml        the distributor certificate, which grants privilege
# The CLI refuses to produce one without the other ("Both an author and a first
# distributor must be required"), so either alone means something went wrong.
#
#   verify-signed.sh <file.wgt>
set -euo pipefail

WGT="${1:?usage: verify-signed.sh <file.wgt>}"

[ -f "$WGT" ] || { echo "::error::$WGT does not exist"; exit 1; }
[ -s "$WGT" ] || { echo "::error::$WGT is empty"; exit 1; }

# -l rather than -t: we are asking what is in the archive, not whether the CRCs
# are good, and a listing works on a truncated file where a test would not.
listing="$(unzip -l "$WGT" 2>/dev/null)" || {
    echo "::error::$WGT is not a readable zip archive; tizen package did not produce a widget"
    exit 1
}

missing=()
grep -q '[[:space:]]author-signature\.xml$' <<<"$listing" || missing+=("author-signature.xml")
grep -q '[[:space:]]signature1\.xml$' <<<"$listing" || missing+=("signature1.xml")

if [ ${#missing[@]} -ne 0 ]; then
    echo "::error::$WGT is NOT SIGNED -- missing ${missing[*]}. tizen package exits 0 while producing an unsigned archive when its security profile is missing or its certificate password is wrong, so this is the only reliable check. A television will refuse to install this file."
    exit 1
fi

# config.xml is what makes it a widget rather than a zip of files.
grep -q '[[:space:]]config\.xml$' <<<"$listing" || {
    echo "::error::$WGT has signatures but no config.xml, so it is not a usable widget"
    exit 1
}

echo "$WGT is signed (author-signature.xml and signature1.xml present)"
