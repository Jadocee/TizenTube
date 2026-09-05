#!/usr/bin/env bash
# Fails unless a .wgt actually carries both signatures, and unless they are real.
#
# NOT DECORATION. `tizen package` exits 0 and writes an UNSIGNED archive when the
# security profile it was told to use does not exist or its password cannot be
# resolved -- the only sign is a "Warning: Not found tizen signature file" line
# among many others. A pipeline that trusts the exit code publishes an unsigned
# widget, a television refuses to install it, and the failure surfaces on the TV
# rather than in the build.
#
# A Tizen widget carries two signatures with different jobs:
#   author-signature.xml  the developer's certificate, over the payload
#   signature1.xml        the distributor certificate, which grants privilege
# The CLI refuses to produce one without the other ("Both an author and a first
# distributor must be required"), so either alone means something went wrong.
#
# PRESENCE IS NOT ENOUGH, and this is the interesting part. `tizen package`
# copies the packaged directory verbatim, so two files merely NAMED
# author-signature.xml and signature1.xml -- left in a source tree by an earlier
# packaging run, say -- travel into the archive and satisfy any check that only
# reads the file list. That archive is unsigned and would pass. So the contents
# are checked too: a real signature is an XML-DSig carrying a SignatureValue and
# the role URI that says which half it is.
#
#   verify-signed.sh <file.wgt>
set -euo pipefail

WGT="${1:?usage: verify-signed.sh <file.wgt>}"

[ -f "$WGT" ] || { echo "::error::$WGT does not exist"; exit 1; }
[ -s "$WGT" ] || { echo "::error::$WGT is empty"; exit 1; }

# -Z1 lists one bare pathname per line, so a name can be matched exactly. `-l`
# would embed each name in a column layout, where an entry called
# "not-really author-signature.xml" matches a pattern anchored on whitespace.
names="$(unzip -Z1 "$WGT" 2>/dev/null)" || {
    echo "::error::$WGT is not a readable zip archive; tizen package did not produce a widget"
    exit 1
}

missing=()
for entry in author-signature.xml signature1.xml config.xml; do
    grep -qxF "$entry" <<<"$names" || missing+=("$entry")
done
if [ ${#missing[@]} -ne 0 ]; then
    echo "::error::$WGT is NOT SIGNED -- missing ${missing[*]}. tizen package exits 0 while producing an unsigned archive when its security profile is missing or its certificate password cannot be resolved, so this is the only reliable check. A television will refuse to install this file."
    exit 1
fi

# role-author on one, role-distributor on the other. Checked by role rather than
# by filename so a copy of one signature under the other's name does not pass.
check_signature() {
    local entry="$1" role="$2" body
    body="$(unzip -p "$WGT" "$entry" 2>/dev/null)" || {
        echo "::error::$WGT lists $entry but it cannot be extracted"
        exit 1
    }
    grep -q 'SignatureValue' <<<"$body" || {
        echo "::error::$entry in $WGT is not an XML signature -- it carries no SignatureValue. It is almost certainly a leftover file that was packaged verbatim, which means this archive is UNSIGNED."
        exit 1
    }
    grep -q "$role" <<<"$body" || {
        echo "::error::$entry in $WGT does not declare $role, so it is not the signature it claims to be."
        exit 1
    }
}
check_signature author-signature.xml 'role-author'
check_signature signature1.xml 'role-distributor'

echo "$WGT is signed (author and distributor signatures present and well-formed)"
