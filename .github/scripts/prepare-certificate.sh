#!/usr/bin/env bash
# Materialises the Tizen author certificate from the repository secrets, and
# reports whether this run can sign at all.
#
# Two different situations look alike from inside a workflow and must not be
# treated alike:
#
#   NOT CONFIGURED -- neither secret exists. Publishing a .wgt is opt-in: the
#       TizenBrew module route needs no certificate, and a repository that only
#       ships that way should not get a red main every time the widget version
#       moves. Emits signed=false and exits 0; the packaging and release steps
#       are skipped and the run stays green.
#
#   MISCONFIGURED -- something is set but unusable: only one of the pair, not
#       valid base64, or a decode far too small to be a certificate. Somebody
#       meant to sign here, so this fails loudly at the step that is supposed to
#       produce the certificate.
#
# The second case exists because of how the first release actually failed. Both
# secrets were unset, `echo "" | base64 -d` produced a ZERO-BYTE .p12, the step
# exited 0, and the packager reported thirty seconds later:
#
#     Error: Too few bytes to parse DER.
#       available: 0, remaining: 0, requested: 2
#
# which is a true statement about an empty file and tells you nothing about the
# cause.
#
# Reads:  TIZEN_AUTHOR_KEY (base64 of a .p12), TIZEN_AUTHOR_KEY_PW
# Writes: the decoded certificate to $CERT_PATH, and signed=true|false to
#         $GITHUB_OUTPUT
set -euo pipefail

CERT_PATH="${CERT_PATH:?CERT_PATH must be set}"
OUT="${GITHUB_OUTPUT:-/dev/stdout}"
emit() { echo "$1" >> "$OUT"; }

KEY="${TIZEN_AUTHOR_KEY:-}"
PW="${TIZEN_AUTHOR_KEY_PW:-}"

# Neither one set: signing was never configured on this repository.
if [ -z "$KEY" ] && [ -z "$PW" ]; then
    echo "::warning::No Tizen signing secrets are set, so no .wgt is built and no release is published. This run builds and verifies only."
    echo "The standalone app is a signed Tizen widget and there is no unsigned form of one."
    echo "To publish, set these under Settings > Secrets and variables > Actions:"
    echo "  TIZEN_AUTHOR_KEY     base64 -w0 author.p12"
    echo "  TIZEN_AUTHOR_KEY_PW  the password for that .p12"
    echo "Installing as a TizenBrew module needs neither."
    emit 'signed=false'
    exit 0
fi

# One of the pair set, but not the other. That is half-finished setup rather
# than a decision not to publish, so it fails instead of quietly skipping.
if [ -z "$KEY" ]; then
    echo "::error::TIZEN_AUTHOR_KEY_PW is set but TIZEN_AUTHOR_KEY is not, so there is no certificate to sign with."
    echo "Set it to the base64 of your Tizen author certificate: base64 -w0 author.p12"
    echo "To turn publishing off entirely instead, remove both secrets."
    exit 1
fi

if [ -z "$PW" ]; then
    echo "::error::TIZEN_AUTHOR_KEY is set but TIZEN_AUTHOR_KEY_PW is not. It is the password for that .p12."
    echo "To turn publishing off entirely instead, remove both secrets."
    exit 1
fi

printf '%s' "$KEY" | base64 -d > "${CERT_PATH}" 2>/dev/null || {
    echo "::error::TIZEN_AUTHOR_KEY is not valid base64, so no certificate could be written."
    echo "Produce it with: base64 -w0 author.p12"
    exit 1
}

SIZE=$(wc -c < "${CERT_PATH}" | tr -d ' ')
# A real author .p12 is a couple of kilobytes. Anything this small is a decoding
# accident, not a certificate, and is worth catching here rather than inside the
# packager's ASN.1 reader.
if [ "${SIZE}" -lt 100 ]; then
    echo "::error::The decoded certificate is ${SIZE} bytes, which is not a .p12."
    echo "TIZEN_AUTHOR_KEY is probably truncated. Re-run: base64 -w0 author.p12"
    exit 1
fi

echo "certificate written: ${SIZE} bytes"

# Confirms both that the file really is PKCS#12 and that the password opens it,
# before the packager gets it. A warning rather than a failure: OpenSSL 3 rejects
# some older ciphers that the packager's own reader still accepts, so a
# disagreement here is worth surfacing but is not proof the release would fail.
if command -v openssl >/dev/null 2>&1; then
    if openssl pkcs12 -in "${CERT_PATH}" -noout -passin env:TIZEN_AUTHOR_KEY_PW >/dev/null 2>&1 \
    || openssl pkcs12 -in "${CERT_PATH}" -noout -legacy -passin env:TIZEN_AUTHOR_KEY_PW >/dev/null 2>&1; then
        echo "certificate parses and the password opens it"
    else
        echo "::warning::OpenSSL could not open this .p12 with the supplied password. If the"
        echo "build fails at signing, the password is the first thing to check."
    fi
fi

emit 'signed=true'
