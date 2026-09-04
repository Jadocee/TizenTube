# Tizen Studio's Web CLI, headless, for building and signing standalone/ into a
# signed .wgt.
#
# THE SDK IS DOWNLOADED AT BUILD TIME AND THIS IMAGE MUST NOT BE PUSHED ANYWHERE
# PUBLIC. The Tizen Studio License Agreement, which ships inside the installer
# itself as res/COPYING in installer.jar, says in section 3.1: "You shall not
# ... (ii) lease, rent, copy, redistribute or sublicense the TIZEN STUDIO to
# third party", and section 8.1 adds a confidentiality obligation. An image with
# the SDK baked in, pushed to Docker Hub or a public GHCR, is redistribution.
# Build it locally or ephemerally in CI; keep it out of public registries. This
# is also why the Dockerfile fetches the installer rather than vendoring it.
#
# amd64 only, and that is not a preference. Samsung publishes host builds for
# ubuntu-32, ubuntu-64, windows-32, windows-64 and macos-64 and nothing else --
# there is no arm64 installer at any layer. On Apple Silicon this runs under
# emulation, which is slow but works, because the signing path here does not
# touch the SDK's 32-bit i386 secret-tool (see obfuscate-password.sh).
FROM --platform=linux/amd64 ubuntu:24.04

# 10.0 is the current generation. Note the path and filename scheme changed:
# tizen-sdk_X / web-cli_Tizen_SDK_X, where older public Dockerfiles all hardcode
# tizen-studio_X / web-cli_Tizen_Studio_X, which is why they are all stuck on
# Tizen 5.x/6.x. Pinned by digest as well as version so an upstream replacement
# cannot silently change what gets installed.
ARG TIZEN_SDK_VERSION=10.0
ARG TIZEN_SDK_BIN=web-cli_Tizen_SDK_10.0_ubuntu-64.bin
ARG TIZEN_SDK_SHA256=65d2a569cbf0351dca4b94254f2c642d49195ac4964e08a76b4eaabc9ce4bed0
ARG TIZEN_SDK_URL=https://download.tizen.org/sdk/Installer/tizen-sdk_${TIZEN_SDK_VERSION}/${TIZEN_SDK_BIN}

ENV TIZEN_STUDIO=/opt/tizen-studio \
    TIZEN_STUDIO_DATA=/opt/tizen-studio-data \
    DEBIAN_FRONTEND=noninteractive

# zip is not optional: the installer's own precheck is INSTALLATION_CHECK="grep
# zip" and it exits 1 without it. unzip is for verify-signed.sh, which reads the
# archive it just produced. python3 rewrites one attribute in the SDK's
# generated profiles.xml -- see package-wgt.sh for why that is necessary and why
# sed would be the wrong tool for it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        grep \
        openssl \
        python3 \
        unzip \
        zip \
    && rm -rf /var/lib/apt/lists/*

# The installer hard-refuses to run as root -- `if [ \`whoami\` = "root" ]` then
# "Do not install as 'root' user or 'su' commands." and exit 1 -- so there has
# to be a real user with a writable home. It unpacks a bundled JDK and ~400 MB
# of payload under $HOME/.package-manager before it writes anything to the
# install prefix, so $HOME needs the space too.
RUN useradd --create-home --shell /bin/bash tizen \
    && mkdir -p ${TIZEN_STUDIO} ${TIZEN_STUDIO_DATA} \
    && chown -R tizen:tizen ${TIZEN_STUDIO} ${TIZEN_STUDIO_DATA} \
    && touch /home/tizen/.bashrc \
    && chown tizen:tizen /home/tizen/.bashrc

USER tizen
WORKDIR /home/tizen

# --accept-license answers the EULA prompt; the trailing path answers "Please
# type destination directory". --no-java-check skips a probe for a system JDK
# the SDK does not need, because it bundles its own.
#
# The `test -x` afterwards is MANDATORY, not belt and braces. The .bin is a
# self-extracting wrapper whose last two lines are `source ~/.bashrc` and
# `exit 0` -- it discards the real installer's status, so a completely failed
# install still produces a green RUN layer and the image fails much later, at
# package time, with something unrelated-looking.
RUN curl -fsSL -o /tmp/${TIZEN_SDK_BIN} "${TIZEN_SDK_URL}" \
    && echo "${TIZEN_SDK_SHA256}  /tmp/${TIZEN_SDK_BIN}" | sha256sum -c - \
    && chmod +x /tmp/${TIZEN_SDK_BIN} \
    && /tmp/${TIZEN_SDK_BIN} --accept-license --no-java-check ${TIZEN_STUDIO} \
    && rm -f /tmp/${TIZEN_SDK_BIN} \
    && rm -rf /home/tizen/.package-manager/run \
    && test -x ${TIZEN_STUDIO}/tools/ide/bin/tizen \
    && test -d ${TIZEN_STUDIO}/platforms/tizen-9.0

ENV PATH=${TIZEN_STUDIO}/tools/ide/bin:${TIZEN_STUDIO}/tools:${PATH}

USER root

# The container may run as any uid, because the .wgt has to come back owned by
# the developer and their uid is not known when the image is built. Two things
# have to be true for that to work, and neither is by default.
#
# The installer writes every executable 0764 -- owner-execute only, no x for
# group or other, 632 files including tools/ide/bin/tizen and the bundled
# jdk/bin/java. `a+rX` adds execute for everyone exactly where the owner already
# has it, and read everywhere, without making data files executable. Note also
# that ubuntu:24.04 already ships a user at uid 1000, so the `tizen` account
# created above is 1001 -- there is no uid this image could pick that a host
# user would reliably share, which is why the fix is permissions rather than a
# matching uid.
RUN chmod -R a+rX ${TIZEN_STUDIO}

# The data directory is where the CLI writes its log and its security profiles,
# and it is written by whichever uid the container runs as.
RUN chmod -R 0777 ${TIZEN_STUDIO_DATA}

# Samsung's CLI POSTs usage analytics on every invocation unless this file says
# otherwise, and it creates the file with logging enabled on first run -- which,
# without this, happens during `docker build` and bakes an analytics id into the
# image. The build service runs with no network at all, but the debug shell does
# not, so turn it off in the image rather than relying on that.
RUN mkdir -p ${TIZEN_STUDIO_DATA}/ide \
    && printf '{"id":"","logging":false}' > ${TIZEN_STUDIO_DATA}/ide/analytics.conf \
    && chmod 0666 ${TIZEN_STUDIO_DATA}/ide/analytics.conf

COPY --chmod=0755 package-wgt.sh obfuscate-password.sh verify-signed.sh /opt/tizen/

USER tizen
WORKDIR /work
ENTRYPOINT ["/opt/tizen/package-wgt.sh"]
