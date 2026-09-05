// The Docker stack that builds and signs the standalone widget with the real
// Tizen Studio Web CLI: docker/tizen/ and compose.yaml.
//
// WHAT THIS CAN AND CANNOT CHECK, STATED UP FRONT. Nothing here builds an image
// or runs the SDK — that needs a Docker daemon, a 401 MB download from Samsung
// and an amd64 host, none of which belong in a unit suite. What it does check is
// everything that does not need one, and those turn out to be the parts most
// likely to be wrong:
//
//   - the two shell helpers, run for real against synthetic inputs. The signature
//     gate is the one that matters: `tizen package` EXITS 0 while writing an
//     unsigned archive when its profile is missing, so that gate is the only
//     thing standing between a wrong password and a widget no television will
//     install.
//   - the password encoder, checked against Samsung's OWN stored value. The SDK
//     ships a profiles.xml containing the public distributor password as DESede
//     ciphertext, so encoding that known plaintext must reproduce that exact
//     string. If it does not, the profile we write is one the CLI cannot read.
//   - properties of the Dockerfile and compose file that are security or
//     correctness invariants rather than style: no certificate baked into a
//     layer, no debug bridge published, and the post-install assertion that
//     exists because the SDK installer always exits 0.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checker, repoPath } from '../lib/repo.mjs';

const { check, done } = checker();

// Comments stripped before any of these are matched. Every one of these files
// EXPLAINS what it does immediately above doing it -- so matching the raw text
// finds the explanation and reports the behaviour as present after it has been
// deleted. What is asserted is what runs.
const decomment = (text) =>
    text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');

const DOCKERFILE = decomment(readFileSync(repoPath('docker', 'tizen', 'Dockerfile'), 'utf8'));
const ENTRYPOINT = decomment(readFileSync(repoPath('docker', 'tizen', 'package-wgt.sh'), 'utf8'));
const OBFUSCATE = repoPath('docker', 'tizen', 'obfuscate-password.sh');
const VERIFY = repoPath('docker', 'tizen', 'verify-signed.sh');

const sh = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// --- the password encoder ----------------------------------------------------
// Signing headlessly turns on writing the certificate password into profiles.xml
// as DESede ciphertext, because the alternative is a D-Bus session and a GNOME
// keyring holding a password for a 32-bit binary. The encoder is checkable
// without any of that: the SDK's own shipped profiles.xml stores the public
// distributor password this way, so the known plaintext must produce the known
// ciphertext. That pair is the whole proof the mechanism is understood.
const selfTest = sh('bash', [OBFUSCATE, '--self-test']);
check("the password encoder matches the SDK's own stored value", selfTest.status, 0);
check('  ...and says so', /matches the SDK's own stored/.test(selfTest.out), true);

const encoded = sh('bash', [OBFUSCATE], { input: 'hunter2' });
check('it encodes a password', encoded.status, 0);
check('  ...to base64, on one line', /^[A-Za-z0-9+/]+=*\n?$/.test(encoded.out), true);
// Not ".pwd": that suffix is exactly what makes the CLI treat the value as a
// keyring lookup key instead of decrypting it inline, which is the failure this
// whole approach exists to avoid.
check('  ...and never to a .pwd path', /\.pwd/.test(encoded.out), false);
// Distinct inputs must not collide into one ciphertext, or every certificate
// would appear to share a password.
const other = sh('bash', [OBFUSCATE], { input: 'different' });
check('  ...distinctly per password', encoded.out.trim() === other.out.trim(), false);

// --- the signature gate ------------------------------------------------------
// Driven against real archives, because the thing being asserted is what it does
// with a file, not what its source says.
function wgt(entries) {
    const dir = mkdtempSync(join(tmpdir(), 'tt-wgt-'));
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    const names = [];
    for (const [name, body] of Object.entries(entries)) {
        writeFileSync(join(src, name), body);
        names.push(name);
    }
    const out = join(dir, 'app.wgt');
    if (names.length) execFileSync('zip', ['-q', out, ...names], { cwd: src });
    return { dir, path: out };
}
// Realistic fixtures: the gate reads signature CONTENT, not just entry names,
// because two files merely NAMED author-signature.xml and signature1.xml travel
// into the archive verbatim if they were lying in the source tree, and an
// archive like that is unsigned.
const sig = (role) =>
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignatureValue>QUJD</SignatureValue>` +
    `<Object><SignatureProperties><SignatureProperty><dsp:Role xmlns:dsp="http://www.w3.org/ns/widgets-digsig#" ` +
    `URI="http://www.w3.org/ns/widgets-digsig#${role}"/></SignatureProperty></SignatureProperties></Object></Signature>`;
const AUTHOR_SIG = sig('role-author');
const DIST_SIG = sig('role-distributor');
const SIGNED = {
    'config.xml': '<widget/>',
    'index.html': '<html></html>',
    'author-signature.xml': AUTHOR_SIG,
    'signature1.xml': DIST_SIG,
};
const cases = [
    ['a fully signed widget passes', SIGNED, 0],
    ['an unsigned widget fails', { 'config.xml': '<widget/>', 'index.html': 'x' }, 1],
    [
        'an author signature alone fails',
        { 'config.xml': '<widget/>', 'author-signature.xml': AUTHOR_SIG },
        1,
    ],
    [
        'a distributor signature alone fails',
        { 'config.xml': '<widget/>', 'signature1.xml': DIST_SIG },
        1,
    ],
    [
        'signatures without config.xml fail',
        { 'author-signature.xml': AUTHOR_SIG, 'signature1.xml': DIST_SIG },
        1,
    ],
    // The one that made content-checking necessary: a source tree that still
    // holds last run's signature files packages them verbatim, and a check that
    // only reads the file list calls the result signed.
    [
        'stale leftovers named like signatures fail',
        {
            'config.xml': '<widget/>',
            'author-signature.xml': '<stale/>',
            'signature1.xml': '<stale/>',
        },
        1,
    ],
    // Roles are checked, so one signature copied under the other's name is not
    // two signatures.
    [
        'the author signature copied as the distributor fails',
        {
            'config.xml': '<widget/>',
            'author-signature.xml': AUTHOR_SIG,
            'signature1.xml': AUTHOR_SIG,
        },
        1,
    ],
    // The entry name is matched whole; a file whose name merely ends with the
    // signature's name is not the signature.
    [
        'a name that only ends in the signature name fails',
        { 'config.xml': '<widget/>', 'not-really author-signature.xml': AUTHOR_SIG },
        1,
    ],
];
for (const [name, entries, want] of cases) {
    const built = wgt(entries);
    try {
        check(name, sh('bash', [VERIFY, built.path]).status, want);
    } finally {
        rmSync(built.dir, { recursive: true, force: true });
    }
}

// A file that is not a zip at all, and one that is not there. Both are things
// `tizen package` can leave behind, and neither must read as signed.
const notZip = mkdtempSync(join(tmpdir(), 'tt-wgt-'));
writeFileSync(join(notZip, 'app.wgt'), 'this is not a zip');
check('a non-archive fails', sh('bash', [VERIFY, join(notZip, 'app.wgt')]).status, 1);
writeFileSync(join(notZip, 'empty.wgt'), '');
check('an empty file fails', sh('bash', [VERIFY, join(notZip, 'empty.wgt')]).status, 1);
check('a missing file fails', sh('bash', [VERIFY, join(notZip, 'nope.wgt')]).status, 1);
rmSync(notZip, { recursive: true, force: true });

// The message has to name the problem. "exit 1" in a CI log with no explanation
// sends someone looking at the certificate when the profile was the problem.
const unsigned = wgt({ 'config.xml': '<widget/>' });
const unsignedOut = sh('bash', [VERIFY, unsigned.path]).out;
check('an unsigned widget says it is unsigned', /NOT SIGNED/.test(unsignedOut), true);
check('  ...and names what is missing', /author-signature\.xml/.test(unsignedOut), true);
rmSync(unsigned.dir, { recursive: true, force: true });

// --- the entrypoint's own preconditions --------------------------------------
// A widget whose <tizen:service> points at a bundle that was never built
// installs and then does nothing, which is the worst kind of success. The
// entrypoint refuses rather than packaging it.
// Matched on the test, not on the path: the path also appears in the die()
// message on the same line, so a guard downgraded to a warning still contains it.
check(
    'the entrypoint requires the service bundle to exist',
    /\[ -s "\$SRC\/service\/dist\/index\.js" \] \|\| die/.test(ENTRYPOINT),
    true,
);
// The repository is bind-mounted. CI deletes service/node_modules before
// packaging; doing that here would delete a developer's actual dependency tree.
check('it never deletes from the mounted tree', /rm -rf "?\$\{?(SRC|WORK)/.test(ENTRYPOINT), false);
check('  ...it stages a copy instead', /tar -C "\$SRC"/.test(ENTRYPOINT), true);
// Both halves asserted separately, and existence FIRST. `indexOf` returns -1
// for something absent, and -1 is less than every real index -- so an ordering
// check on its own passes loudest exactly when the earlier step has been deleted.
// Regexes rather than strings throughout: the shell being matched is full of
// ${...}, which reads as an unfinished template literal when quoted in JS.
const runsBefore = (first, second) => {
    const a = ENTRYPOINT.search(first);
    const b = ENTRYPOINT.search(second);
    return a >= 0 && b >= 0 && a < b;
};
check('it runs the signature gate', /verify-signed\.sh" "\$\{built\[0\]\}"/.test(ENTRYPOINT), true);
check(
    '  ...before the widget reaches the output directory',
    runsBefore(/verify-signed\.sh/, /cp "\$\{built\[0\]\}"/),
    true,
);
// Matched on the exact probe, not on "openssl pkcs12": the expiry warning below
// it runs openssl pkcs12 too, so a looser match reports the password check as
// present when only the expiry check remains.
check(
    'it checks the password opens the certificate',
    ENTRYPOINT.includes('-noout -passin env:PW'),
    true,
);
check(
    '  ...before spending a build on it',
    runsBefore(/-noout -passin env:PW/, /tizen build-web/),
    true,
);
// OpenSSL 3 rejects ciphers older .p12 files use that the SDK's Java signer
// accepts, so a single strict check would reject working certificates.
check(
    '  ...retrying with legacy ciphers before giving up',
    ENTRYPOINT.includes('-legacy -passin env:PW'),
    true,
);
// The CLI prints "See the log file" and nothing else on most failures.
// The CLI prints "See the log file" and nothing else on most failures, so the
// log has to be shown. Both halves: the function, and the trap that calls it.
check('it can dump the CLI log', /cli\.log/.test(ENTRYPOINT), true);
check('  ...and a trap actually calls it', /trap [^\n]*dump_log[^\n]*EXIT/.test(ENTRYPOINT), true);

// --- the signing pipeline is actually wired up ---------------------------------
// Nothing above asserted that the entrypoint ever USES any of this. Every piece
// could have been deleted -- the encoder never called, no profile registered, no
// -s passed to `tizen package` -- and the suite stayed green while the container
// produced a cheerfully unsigned widget.
check('it registers a signing profile', /tizen security-profiles add/.test(ENTRYPOINT), true);
check('  ...from the certificate it validated', /-a "\$CERT"/.test(ENTRYPOINT), true);
check(
    '  ...and signs with that profile',
    /tizen package[^\n]*-s "\$PROFILE"/.test(ENTRYPOINT),
    true,
);
check('it encodes the password for profiles.xml', /obfuscate-password\.sh/.test(ENTRYPOINT), true);
check(
    '  ...checking the encoder against the SDK first',
    /obfuscate-password\.sh" --self-test/.test(ENTRYPOINT),
    true,
);

// Both halves of profiles.xml, not just the author's. The SDK writes a keyring
// reference for the DISTRIBUTOR too, and patching only the author leaves signing
// dependent on the D-Bus Secret Service this whole approach exists to avoid --
// a failure that only appears once the profile is being found at all.
// Asserted on the embedded patcher itself, not on a variable name: a rename
// leaves any substring check happily matching while the distributor half stops
// being patched.
const PATCHER = (ENTRYPOINT.match(/<<'PY'\n([\s\S]*?)\nPY\n/) || [])[1] ?? '';
check('the profiles.xml patcher was found', PATCHER.includes('profileitem'), true);
check(
    '  ...it patches the author entry',
    /distributor"\)\s*==\s*"0"/.test(PATCHER) && /set\("password", author_cipher\)/.test(PATCHER),
    true,
);
check(
    '  ...and the distributor entry',
    /else:\s*\n\s*item\.set\("password", dist_cipher\)/.test(PATCHER),
    true,
);
check(
    '  ...requiring at least one of each',
    /authors != 1/.test(PATCHER) && /distributors < 1/.test(PATCHER),
    true,
);
check(
    '  ...and refusing to proceed with any keyring reference left',
    /endswith\("\.pwd"\)/.test(PATCHER),
    true,
);

// Stale signature files in the source tree would otherwise be packaged verbatim
// and satisfy a name-only signature check.
for (const excluded of ['author-signature.xml', 'signature1.xml']) {
    check(
        `staging excludes ${excluded}`,
        new RegExp(`--exclude='${excluded.replace('.', '\\.')}'`).test(ENTRYPOINT),
        true,
    );
}

// A password the CLI's own launcher would re-evaluate rather than pass through.
check('it rejects a password the CLI cannot carry', /backslash or a tab/.test(ENTRYPOINT), true);

// --- the image ---------------------------------------------------------------
// The installer is a self-extracting wrapper whose last lines are `source
// ~/.bashrc` and `exit 0`: it discards the real installer's status, so a totally
// failed install still produces a green layer. The only way to know is to look.
check(
    'the Dockerfile asserts the SDK actually installed',
    /test -x \$\{TIZEN_STUDIO\}\/tools\/ide\/bin\/tizen/.test(DOCKERFILE),
    true,
);
check(
    '  ...and that the platform this repo targets is present',
    /test -d \$\{TIZEN_STUDIO\}\/platforms\/tizen-9\.0/.test(DOCKERFILE),
    true,
);
// The installer refuses to run as uid 0.
// Three USER lines exist; what matters is that the one before the installer is
// not root, because the installer hard-refuses uid 0.
const installAt = DOCKERFILE.indexOf('--accept-license --no-java-check');
const userBeforeInstall = [...DOCKERFILE.slice(0, installAt).matchAll(/^USER (\S+)$/gm)].pop();
check('the SDK is installed as a non-root user', userBeforeInstall?.[1], 'tizen');
// A pinned digest is what stops an upstream replacement changing what is
// installed without anyone noticing.
check('the installer download is pinned by hash', /sha256sum -c/.test(DOCKERFILE), true);
check('  ...to a specific version', /TIZEN_SDK_VERSION=\d+\.\d+/.test(DOCKERFILE), true);
// Samsung publishes no arm64 host build at any layer.
check('the image is pinned to amd64', /FROM --platform=linux\/amd64/.test(DOCKERFILE), true);

// The installer writes every executable 0764 -- no execute bit for group or
// other -- and ubuntu:24.04 already owns uid 1000, so the container's uid is
// never the SDK's owner. Without this the CLI cannot be run at all.
check(
    'the SDK tree is executable by any uid',
    /chmod -R a\+rX \$\{TIZEN_STUDIO\}/.test(DOCKERFILE),
    true,
);
// The CLI POSTs usage analytics unless told not to, and creates the opt-out file
// with logging ENABLED on first run -- which would otherwise happen during the
// build and bake an analytics id into the image.
check('telemetry is turned off in the image', /"logging":false/.test(DOCKERFILE), true);
check(
    '  ...before anything runs the CLI',
    !/tools\/ide\/bin\/tizen version/.test(DOCKERFILE) ||
        DOCKERFILE.indexOf('"logging":false') < DOCKERFILE.indexOf('tools/ide/bin/tizen version'),
    true,
);

// Nothing secret may enter a layer: a COPY survives even if a later RUN deletes
// it, and a build ARG is recoverable from `docker history`.
check(
    'no certificate is baked into the image',
    /^(COPY|ADD)[^\n]*\.(p12|pfx)/im.test(DOCKERFILE),
    false,
);
// A build ARG is recoverable from `docker history` long after the build.
check(
    'no secret is a build argument',
    /^ARG[^\n]*(PASSWORD|_PW\b|PASSWD|AUTHOR_KEY|TOKEN|SECRET)/im.test(DOCKERFILE),
    false,
);
// `tizen cli-config -g` refuses every key in the `default.*` namespace, prints
// the refusal to stdout and exits 0 -- so relocating profiles.xml that way looks
// like it worked and silently is not. The entrypoint asks the SDK where it wrote
// instead; this is the regression guard for going back.
check(
    'it does not try to relocate profiles.xml with cli-config',
    /cli-config\s+-g/.test(ENTRYPOINT),
    false,
);
check(
    '  ...it reads the path the CLI reports',
    /Wrote to/.test(ENTRYPOINT) && /security-profiles add/.test(ENTRYPOINT),
    true,
);
check(
    '  ...and does not discard that output',
    /security-profiles add[^\n]*>\s*\/dev\/null/.test(ENTRYPOINT),
    false,
);

// --- what compose.yaml must do is asserted in wgt-compose.test.mjs, which exits
// 2 when Docker is absent so the skip is visible to TT_STRICT_SKIP rather than
// being printed in the middle of a passing run.

done();
