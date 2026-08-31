#!/usr/bin/env bash
# Materialises the Tizen author certificate from the repository secrets, and
# refuses to continue unless it actually looks like one.
#
# The check exists because of how this failed the first time it ran. Neither
# secret was set, so `echo "" | base64 -d` produced a ZERO-BYTE .p12, the step
# exited 0, and the packager thirty seconds later reported:
#
#     Error: Too few bytes to parse DER.
#       available: 0, remaining: 0, requested: 2
#
# Which is a true statement about an empty file and tells you nothing about the
# cause. A release path that runs with signing material should say plainly when
# that material is missing, at the step that is supposed to produce it.
#
# Reads:  TIZEN_AUTHOR_KEY (base64 of a .p12), TIZEN_AUTHOR_KEY_PW
# Writes: the decoded certificate to $CERT_PATH
set -euo pipefail

CERT_PATH="${CERT_PATH:?CERT_PATH must be set}"

if [ -z "${TIZEN_AUTHOR_KEY:-}" ]; then
    echo "::error::TIZEN_AUTHOR_KEY is not set. The release cannot be signed without it."
    echo "Set it under Settings > Secrets and variables > Actions as the base64 of your"
    echo "Tizen author certificate: base64 -w0 author.p12"
    exit 1
fi

if [ -z "${TIZEN_AUTHOR_KEY_PW:-}" ]; then
    echo "::error::TIZEN_AUTHOR_KEY_PW is not set. It is the password for the .p12 in TIZEN_AUTHOR_KEY."
    exit 1
fi

printf '%s' "${TIZEN_AUTHOR_KEY}" | base64 -d > "${CERT_PATH}" 2>/dev/null || {
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
    echo "TIZEN_AUTHOR_KEY is probably empty or truncated. Re-run: base64 -w0 author.p12"
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
