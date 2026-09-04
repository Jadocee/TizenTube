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
const COMPOSE = readFileSync(repoPath('compose.yaml'), 'utf8');
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
const SIGNED = {
    'config.xml': '<widget/>',
    'index.html': '<html></html>',
    'author-signature.xml': '<Signature/>',
    'signature1.xml': '<Signature/>',
};
const cases = [
    ['a fully signed widget passes', SIGNED, 0],
    ['an unsigned widget fails', { 'config.xml': '<widget/>', 'index.html': 'x' }, 1],
    [
        'an author signature alone fails',
        { 'config.xml': '<widget/>', 'author-signature.xml': '<S/>' },
        1,
    ],
    ['a distributor signature alone fails', { 'config.xml': '<widget/>', signature1: '<S/>' }, 1],
    [
        'signatures without config.xml fail',
        { 'author-signature.xml': '<S/>', 'signature1.xml': '<S/>' },
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
check(
    'the entrypoint requires the service bundle to exist',
    ENTRYPOINT.includes('service/dist/index.js'),
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
check('it dumps the CLI log on failure', /cli\.log/.test(ENTRYPOINT), true);

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
check('it installs as a non-root user', /^USER tizen$/m.test(DOCKERFILE), true);
// A pinned digest is what stops an upstream replacement changing what is
// installed without anyone noticing.
check('the installer download is pinned by hash', /sha256sum -c/.test(DOCKERFILE), true);
check('  ...to a specific version', /TIZEN_SDK_VERSION=\d+\.\d+/.test(DOCKERFILE), true);
// Samsung publishes no arm64 host build at any layer.
check('the image is pinned to amd64', /FROM --platform=linux\/amd64/.test(DOCKERFILE), true);

// Nothing secret may enter a layer: a COPY survives even if a later RUN deletes
// it, and a build ARG is recoverable from `docker history`.
check('no certificate is copied into the image', /COPY[^\n]*\.p12/.test(DOCKERFILE), false);
check('no password is a build argument', /ARG[^\n]*(PASSWORD|_PW|PASSWD)/i.test(DOCKERFILE), false);
check(
    '  ...and the entrypoint keeps the profile out of the work tree',
    /readonly PROFILES="\$SCRATCH/.test(ENTRYPOINT),
    true,
);

// --- the compose file --------------------------------------------------------
// Parsed by compose itself rather than by a regex, so this asserts what compose
// will actually do. Skipped rather than failed where compose is not installed:
// a contributor without Docker is not a defect in the stack.
const composeAvailable = sh('docker', ['compose', 'version']).status === 0;
if (!composeAvailable) {
    console.log('  SKIPPED: docker compose is not installed, so the compose file was not parsed');
} else {
    const cfg = sh(
        'docker',
        ['compose', '-f', repoPath('compose.yaml'), '--profile', 'debug', 'config'],
        { env: { ...process.env, TIZEN_AUTHOR_KEY_PW: 'harness' } },
    );
    check('the compose file parses', cfg.status, 0);
    const text = cfg.out;
    // sdb's local server binds 0.0.0.0:26099. Publishing any port from this
    // stack would put a debug bridge on the network.
    check('  ...publishing no ports at all', /published:/.test(text), false);
    check('  ...building the widget with no network', /network_mode: none/.test(text), true);
    check('  ...on amd64', /platform: linux\/amd64/.test(text), true);
    // Without a password compose must refuse before spending twenty minutes
    // building a 663 MB image.
    const noPassword = sh('docker', ['compose', '-f', repoPath('compose.yaml'), 'config'], {
        env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== 'TIZEN_AUTHOR_KEY_PW'),
        ),
    });
    check('it refuses to run without a certificate password', noPassword.status !== 0, true);
    check('  ...saying which variable', /TIZEN_AUTHOR_KEY_PW/.test(noPassword.out), true);
}

// The default service must be the one that does the job; the shell is opt-in, or
// `docker compose up` would start a bash prompt and call it a build.
check('the debug shell is behind a profile', /profiles: \["debug"\]/.test(COMPOSE), true);

done();
