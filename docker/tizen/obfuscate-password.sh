#!/usr/bin/env bash
# Encodes a certificate password the way Tizen Studio's profiles.xml stores it.
#
# WHY THIS EXISTS, AND WHY IT IS NOT A KEYRING.
#
# `tizen security-profiles add` appears to work headlessly and then packaging
# fails with "CertificationException: Invaild password" (Samsung's spelling).
# The reason is that on Linux the CLI hands the password to a bundled
# `secret-tool` binary, which stores it in the freedesktop Secret Service over
# D-Bus -- so the profile is written, the command prints "Succeed" and exits 0,
# and the password is nowhere.
#
# The usual workaround is to run a GNOME keyring daemon inside the container.
# That is not necessary, and here it is actively wrong: the bundled secret-tool
# is a 32-bit i386 binary, so the keyring route cannot work under x86-64
# emulation on an arm64 host at all.
#
# profiles.xml's password= attribute accepts EITHER form. The CLI decides with
# `!value.endsWith(".pwd")`: a value ending in .pwd is a keyring lookup key,
# anything else is a base64 DESede/ECB/PKCS5 ciphertext it decrypts inline. So
# writing the ciphertext directly skips D-Bus, the keyring and the 32-bit binary
# together.
#
# THIS IS OBFUSCATION, NOT ENCRYPTION. The key below is a constant compiled into
# the SDK's own CipherUtil, so anyone holding profiles.xml can recover the
# password. It is exactly as secret as the file it sits in -- which is why
# package-wgt.sh writes that file inside the container, under /tmp, and never
# into an image layer or the mounted work tree.
#
# Verifiable without the SDK, which is the point of the self-test below: the
# stock profiles.xml Samsung ships stores the public distributor password as
# "Vy63flx5JBMc5GA4iEf8oFy+8aKE7FX/+arrDcO4I5k=", and that string decrypts to
# the documented "tizenpkcs12passfordsigner".
#
#   obfuscate-password.sh              reads the password on stdin, prints base64
#   obfuscate-password.sh --self-test  checks against Samsung's own known pair
set -euo pipefail

# ASCII "KYANINYLhijklmnopqrstuvwx", truncated to the 24 bytes DESede takes.
readonly TIZEN_CIPHER_KEY=4b59414e494e594c68696a6b6c6d6e6f7071727374757677

# Samsung's shipped ciphertext for the public distributor signer, and its
# plaintext. Used only by --self-test.
readonly KNOWN_CIPHERTEXT='Vy63flx5JBMc5GA4iEf8oFy+8aKE7FX/+arrDcO4I5k='
readonly KNOWN_PLAINTEXT='tizenpkcs12passfordsigner'

encrypt() { openssl enc -e -des-ede3 -K "$TIZEN_CIPHER_KEY" | base64 -w0; }
decrypt() { base64 -d | openssl enc -d -des-ede3 -K "$TIZEN_CIPHER_KEY"; }

if [ "${1:-}" = "--self-test" ]; then
    # Both directions, because a broken encryptor that is its own inverse would
    # pass a round-trip test against itself and still write a profiles.xml the
    # SDK cannot read.
    got_plain="$(printf '%s' "$KNOWN_CIPHERTEXT" | decrypt)"
    [ "$got_plain" = "$KNOWN_PLAINTEXT" ] ||
        { echo "self-test: decrypt gave '$got_plain', expected '$KNOWN_PLAINTEXT'" >&2; exit 1; }
    got_cipher="$(printf '%s' "$KNOWN_PLAINTEXT" | encrypt)"
    [ "$got_cipher" = "$KNOWN_CIPHERTEXT" ] ||
        { echo "self-test: encrypt gave '$got_cipher', expected '$KNOWN_CIPHERTEXT'" >&2; exit 1; }
    echo "self-test: ok (matches the SDK's own stored distributor password)"
    exit 0
fi

encrypt
