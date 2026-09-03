// .github/scripts/npm-gate.sh, driven through every case that decides whether
// CI publishes the npm package TizenBrew installs.
//
// An npm version cannot be reused once taken and cannot meaningfully be
// unpublished after 72 hours, so a gate that publishes when it should not is
// unrecoverable in a way the .wgt gate beside it is not -- a bad GitHub release
// can simply be deleted. That asymmetry is why every branch here is exercised
// against a real git repo rather than a stub of one.
//
// THE REGISTRY IS STUBBED, NOT REACHED. The gate asks npm whether the version
// already exists, and a suite that made that call for real would be slow, would
// fail on a developer's train, and would change its answer the day the package
// is published. So each case installs a fake `npm` on PATH that answers a fixed
// way, and the fake records its argv so the gate cannot quietly ask about the
// wrong coordinate and still be believed.
//
// The two gates are deliberately separate and read different versions: this one
// reads package.json, release-gate.sh reads standalone/config.xml. The last case
// below asserts that independence directly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checker, repoPath } from '../lib/repo.mjs';

const { check, done } = checker();
const SCRIPT = repoPath('.github', 'scripts', 'npm-gate.sh');

const manifest = (version, extra = {}) =>
    JSON.stringify(
        {
            name: '@jadocee/tizentube',
            version,
            main: 'dist/userScript.js',
            serviceFile: 'dist/service.js',
            ...extra,
        },
        null,
        2,
    ) + '\n';

// Every stub logs its arguments first, so "which coordinate did the gate ask
// about" is answerable, then behaves like one of the four things npm really
// does. The bodies are copied from real npm output -- see the header comment in
// npm-gate.sh for the observed exit codes.
const NPM_STUBS = {
    // The version is on the registry. Echoes back whatever was asked for rather
    // than a baked-in string, so the argv assertion is the thing pinning the
    // coordinate, not a coincidence of both sides hard-coding the same number.
    present: `spec="$2"
echo "\${spec##*@}"
exit 0`,
    // Nothing at that coordinate: either the version or the whole package is
    // unknown. npm does not distinguish, and neither do we.
    absent: `echo "npm error code E404" >&2
echo "npm error 404 Not Found - GET https://registry.npmjs.org/@jadocee%2ftizentube" >&2
exit 1`,
    // A failure that is not an answer. E502 is what this repository's proxy
    // returns for an unreachable registry.
    unreachable: `echo "npm error code E502" >&2
echo "npm error 502 Bad Gateway - GET https://registry.npmjs.org/@jadocee%2ftizentube" >&2
exit 1`,
    // Exits 0 but does not name the version asked for. Not an answer either.
    odd: `echo "0.0.1-something-else"
exit 0`,
};

// Binaries the gate genuinely uses. PATH is narrowed to symlinks of exactly
// these, which is how the "npm is not installed" case removes npm for real
// rather than faking a 127.
const REAL_BINS = ['bash', 'node', 'git', 'mktemp', 'cat', 'rm', 'grep', 'head'];

/**
 * Builds a repo whose history moves package.json through `versions`, then runs
 * the gate as the given event. Returns the parsed GITHUB_OUTPUT, stdout, the
 * exit status, and the argv the stubbed npm was called with.
 */
function run({
    versions,
    event = 'push',
    refType = 'branch',
    refName = 'main',
    before = 'HEAD~1',
    // How the stubbed registry answers. `null` installs no npm at all.
    registry = 'absent',
    // The build output the manifest points at. Absent or empty means the gate
    // should refuse rather than publish a manifest referring to nothing.
    dist = { 'userScript.js': 'script', 'service.js': 'service' },
    extra = {},
} = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'tt-npm-gate-'));
    const git = (...args) =>
        execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
            .toString()
            .trim();
    try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@t');
        git('config', 'user.name', 't');
        const shas = [];
        versions.forEach((v, i) => {
            writeFileSync(join(dir, 'package.json'), manifest(v, extra));
            // Something unrelated moves in every commit, so a commit that leaves
            // the version alone is still a commit -- the point of the
            // unchanged-version case.
            writeFileSync(join(dir, 'src.txt'), `change ${i}\n`);
            git('add', '-A');
            git('commit', '-qm', `commit ${i} (version ${v})`);
            shas.push(git('rev-parse', 'HEAD'));
        });

        // dist/ is gitignored in the real repository, so it is written after the
        // commits here too -- present in the tree, absent from history.
        if (dist) {
            mkdirSync(join(dir, 'dist'), { recursive: true });
            for (const [file, body] of Object.entries(dist)) {
                writeFileSync(join(dir, 'dist', file), body);
            }
        }

        // A PATH with nothing on it but the binaries the gate needs, so the one
        // case that omits the npm stub is genuinely running without npm.
        const bin = join(dir, 'bin');
        mkdirSync(bin, { recursive: true });
        for (const name of REAL_BINS) {
            const found = execFileSync('sh', ['-c', `command -v ${name}`])
                .toString()
                .trim();
            execFileSync('ln', ['-s', found, join(bin, name)]);
        }
        const argvLog = join(dir, 'npm-argv');
        if (registry) {
            const stub = `#!/bin/sh\nprintf '%s\\n' "$*" >> ${argvLog}\n${NPM_STUBS[registry]}\n`;
            writeFileSync(join(bin, 'npm'), stub, { mode: 0o755 });
        }

        let beforeSha = before;
        if (before === 'HEAD~1') beforeSha = shas.length > 1 ? shas[shas.length - 2] : '';
        else if (before === 'ZERO') beforeSha = '0'.repeat(40);
        else if (before === 'ABSENT') beforeSha = 'b'.repeat(40);

        const outFile = join(dir, 'gh-output');
        writeFileSync(outFile, '');
        let stdout = '';
        let status = 0;
        try {
            stdout = execFileSync('bash', [SCRIPT], {
                cwd: dir,
                env: {
                    HOME: dir,
                    PATH: bin,
                    GITHUB_EVENT_NAME: event,
                    GITHUB_REF_TYPE: refType,
                    GITHUB_REF_NAME: refName,
                    EVENT_BEFORE: beforeSha,
                    GITHUB_OUTPUT: outFile,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            }).toString();
        } catch (e) {
            status = e.status ?? 1;
            stdout = `${e.stdout || ''}${e.stderr || ''}`;
        }
        const out = {};
        for (const line of readFileSync(outFile, 'utf8').split('\n')) {
            const at = line.indexOf('=');
            if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
        }
        const argv = existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim().split('\n') : [];
        return { out, stdout, status, argv };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- the rule: a push publishes what the registry does not have --------------
// The first of these is the regression test for the bug that made this rule
// necessary. The commit that added publishing did not change the version -- it
// could not, it was adding the machinery -- so the old "publish when the version
// changed in this push" rule declined, and the package never reached the
// registry at all. An unchanged version whose release was never made is exactly
// the case that has to publish.
const firstPublish = run({ versions: ['1.0.0', '1.0.0'], registry: 'absent' });
check('an unpublished version publishes even unchanged', firstPublish.out.publish, 'true');
check('  ...at that version', firstPublish.out.version, '1.0.0');
check('  ...under the package name', firstPublish.out.name, '@jadocee/tizentube');
check('  ...having asked the registry about that exact coordinate', firstPublish.argv, [
    'view @jadocee/tizentube@1.0.0 version',
]);

const bumped = run({ versions: ['1.0.0', '1.1.0'], registry: 'absent' });
check('a version bump on main publishes', bumped.out.publish, 'true');
check('  ...at the new version', bumped.out.version, '1.1.0');
check('  ...and asks about the new one, not the old', bumped.argv, [
    'view @jadocee/tizentube@1.1.0 version',
]);

// The other direction, and the reason asking beats diffing: a version already
// taken cannot be published over. The old rule opened the gate here on the
// strength of the diff alone and the only possible outcome was a 403 on main.
const taken = run({ versions: ['1.0.0', '1.1.0'], registry: 'present' });
check('a version already on the registry does not publish', taken.out.publish, 'false');
check('  ...and says why', /already on the registry/.test(taken.stdout), true);

// --- everything that must NOT publish ---------------------------------------
// The one that matters most: a version cannot be un-taken, and a pull request is
// untrusted code. Asserted against the registry state that would otherwise
// publish, so this is the event check refusing and not the registry doing it.
check(
    'a pull request does not',
    run({ versions: ['1.0.0', '1.1.0'], event: 'pull_request', registry: 'absent' }).out.publish,
    'false',
);
check(
    '  ...and does not even ask the registry',
    run({ versions: ['1.0.0', '1.1.0'], event: 'pull_request', registry: 'absent' }).argv,
    [],
);
check(
    'a workflow_dispatch does not',
    run({ versions: ['1.0.0', '1.1.0'], event: 'workflow_dispatch', registry: 'absent' }).out
        .publish,
    'false',
);

// --- an unreachable registry falls back to the old rule ----------------------
// Not fatal and not a free pass. A run whose build and tests have already passed
// should not go red because npm was down, and it should not publish blind
// either; it decides on what it can work out locally, which is what the gate did
// before it could ask.
const offlineBump = run({ versions: ['1.0.0', '1.1.0'], registry: 'unreachable' });
check('an unreachable registry falls back to the diff', offlineBump.out.publish, 'true');
check('  ...saying it could not ask', /could not ask the registry/.test(offlineBump.stdout), true);
check('  ...and quoting what npm said', /npm error code E502/.test(offlineBump.stdout), true);
check(
    'and under that fallback an unchanged version does not publish',
    run({ versions: ['1.0.0', '1.0.0'], registry: 'unreachable' }).out.publish,
    'false',
);
// npm exiting 0 without naming the version asked for is not a "yes" either. If
// this check were loosened to "npm succeeded", a reply about some other version
// would read as present and silently cancel a release.
const oddReply = run({ versions: ['1.0.0', '1.0.0'], registry: 'odd' });
check('a reply that names another version is not an answer', oddReply.out.publish, 'false');
check(
    '  ...it falls back rather than trusting it',
    /could not ask the registry/.test(oddReply.stdout),
    true,
);
// npm missing from PATH entirely -- PATH here holds only the binaries the gate
// uses, so this is npm genuinely absent rather than a stub pretending to be.
const noNpm = run({ versions: ['1.0.0', '1.1.0'], registry: null });
check('no npm on PATH falls back too', noNpm.out.publish, 'true');
check('  ...rather than failing the run', noNpm.status, 0);

// These two OVERLAP, and the harness says so rather than pretending otherwise.
// An all-zero SHA is not a resolvable commit either, so deleting the zero check
// leaves the cat-file check below it producing the same refusal -- mutating that
// line away does NOT fail this file, and a test written to imply otherwise would
// be theatre. What the zero check contributes alone is the MESSAGE: "no previous
// commit" is a useful thing to read in a log, where "not in this checkout" would
// send someone hunting a fetch-depth problem that does not exist. So the outcome
// is asserted for both, and the wording for the one that owns it.
const newBranch = run({ versions: ['1.0.0'], before: 'ZERO', registry: 'unreachable' });
check('a brand-new branch does not', newBranch.out.publish, 'false');
check(
    '  ...and says why, in its own words',
    /no previous commit to compare against/.test(newBranch.stdout),
    true,
);
const shallow = run({ versions: ['1.0.0', '1.1.0'], before: 'ABSENT', registry: 'unreachable' });
check('a shallow checkout does not', shallow.out.publish, 'false');
check(
    '  ...and names the commit it could not find',
    /is not in this checkout/.test(shallow.stdout),
    true,
);
check(
    'a first commit with no history does not',
    run({ versions: ['1.0.0'], before: 'HEAD~1', registry: 'unreachable' }).out.publish,
    'false',
);

// --- tag pushes -------------------------------------------------------------
const tagged = run({ versions: ['1.0.0'], refType: 'tag', refName: 'v1.0.0' });
check('a matching tag push publishes', tagged.out.publish, 'true');
const mismatched = run({ versions: ['1.0.0'], refType: 'tag', refName: 'v9.9.9' });
check('a mismatched tag still publishes', mismatched.out.publish, 'true');
check('  ...but says so', /::warning::tag v9\.9\.9 does not match/.test(mismatched.stdout), true);
// The warning has to survive the registry answering, because that is where the
// decision now gets made -- it used to sit inside the tag branch further down.
const mismatchedTaken = run({
    versions: ['1.0.0'],
    refType: 'tag',
    refName: 'v9.9.9',
    registry: 'present',
});
check(
    'a mismatched tag warns even when nothing is published',
    /::warning::tag v9\.9\.9 does not match/.test(mismatchedTaken.stdout),
    true,
);
check('  ...and publishes nothing', mismatchedTaken.out.publish, 'false');
check(
    'a tag whose version is taken does not republish it',
    run({ versions: ['1.0.0'], refType: 'tag', refName: 'v1.0.0', registry: 'present' }).out
        .publish,
    'false',
);
check(
    'a tag push with no registry falls back to always publishing',
    run({ versions: ['1.0.0'], refType: 'tag', refName: 'v1.0.0', registry: 'unreachable' }).out
        .publish,
    'true',
);

// --- the build has to exist -------------------------------------------------
// main and serviceFile point into dist/, which is gitignored. Publishing without
// it would put a manifest on the registry naming two files that are not in the
// tarball, and TizenBrew would install a module with no userscript and no
// service. This is a hard failure rather than a skip: reaching here with no
// build means the workflow ran its steps out of order.
const noDist = run({ versions: ['1.0.0', '1.1.0'], dist: null });
check('a missing build fails the run', noDist.status !== 0, true);
check('  ...naming the file', /dist\/userScript\.js/.test(noDist.stdout), true);
check('  ...rather than publishing', noDist.out.publish ?? 'unset', 'unset');

const emptyDist = run({
    versions: ['1.0.0', '1.1.0'],
    dist: { 'userScript.js': '', 'service.js': 'x' },
});
check('an empty bundle also fails', emptyDist.status !== 0, true);

const halfDist = run({ versions: ['1.0.0', '1.1.0'], dist: { 'userScript.js': 'script' } });
check('a half-built dist fails too', halfDist.status !== 0, true);
check('  ...naming the missing half', /dist\/service\.js/.test(halfDist.stdout), true);

// --- a malformed manifest ---------------------------------------------------
const noVersion = run({ versions: ['1.0.0'], extra: { version: undefined } });
check('a manifest with no version fails', noVersion.status !== 0, true);

// --- the two gates are independent ------------------------------------------
// The npm route needs no certificate and no widget version; the .wgt route needs
// both. Keying them together would mean a userscript fix either shipping a .wgt
// nobody needed or not reaching TizenBrew at all. Asserted by reading the
// scripts: each names one version source and not the other.
// Comments stripped first. Both scripts EXPLAIN the separation in prose, naming
// the other's version source to say why it is not read -- so matching the raw
// text finds each script describing its counterpart and reports them as
// entangled. What is asserted is what the code reads, not what it talks about.
const decomment = (text) =>
    text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
const npmGate = decomment(readFileSync(SCRIPT, 'utf8'));
const wgtGate = decomment(readFileSync(repoPath('.github', 'scripts', 'release-gate.sh'), 'utf8'));
check('the npm gate reads package.json', /package\.json/.test(npmGate), true);
check('  ...and not the widget config', /config\.xml/.test(npmGate), false);
check('the wgt gate reads config.xml', /config\.xml/.test(wgtGate), true);
check('  ...and not the package manifest', /NPM_MANIFEST|package\.json/.test(wgtGate), false);

// --- the workflow has to act on the gate's answer ---------------------------
// The gate is worthless unless the steps below it read its output. Without these
// conditions a pull request reaches `npm publish`, and a version cannot be
// un-taken. Asserted the same way cert.test.mjs asserts the certificate guard,
// and for the same reason: the guard lives in YAML, where nothing else checks it.
const workflow = readFileSync(repoPath('.github', 'workflows', 'build-release.yaml'), 'utf8');
const conditionOf = (step) => {
    const at = workflow.indexOf(`- name: ${step}\n`);
    return at < 0 ? '' : (workflow.slice(at, at + 400).match(/^\s+if: .*$/m) || [''])[0];
};
const PUBLISH_GUARD = "steps.npm.outputs.publish == 'true'";
const TOKEN_GUARD = "steps.npm-auth.outputs.configured == 'true'";
check(
    'the token check is gated on the gate',
    conditionOf('Check the npm token').includes(PUBLISH_GUARD),
    true,
);
for (const step of ['Verify the package contents', 'Publish to npm']) {
    const condition = conditionOf(step);
    check(`"${step}" is gated on the gate`, condition.includes(PUBLISH_GUARD), true);
    check('  ...and on a configured token', condition.includes(TOKEN_GUARD), true);
}
// And the step producing the answer must not gate on its own output, which would
// make it unreachable and skip every publish forever.
const gateAt = workflow.indexOf('id: npm\n');
check(
    'the gate step does not gate on its own output',
    gateAt > 0 && !workflow.slice(gateAt, gateAt + 300).includes(PUBLISH_GUARD),
    true,
);

// Order is load-bearing, not cosmetic: an npm version cannot be reused, so a
// tarball that reached the registry before the suite ran could never be taken
// back. The publish step has to sit after the harnesses.
check(
    'nothing is published before the harnesses run',
    workflow.indexOf('- name: Run the harnesses\n') < workflow.indexOf('- name: Publish to npm\n'),
    true,
);

// Provenance needs the id-token permission; asking for --provenance without it
// fails the publish outright.
check('the publish claims provenance', /npm publish[^\n]*--provenance/.test(workflow), true);
check('  ...and the job may mint the token', /id-token: write/.test(workflow), true);

// The pull-request nudge covers both routes. The .wgt half predates the npm
// package and the npm half is the one that goes quiet unnoticed, so it is the
// one pinned here -- by the file it reads, not by the prose around it.
const warnAt = workflow.indexOf('- name: Warn if shipped code changed without a version bump\n');
const warnStep =
    warnAt < 0 ? '' : workflow.slice(warnAt, workflow.indexOf('\n      - name:', warnAt + 1));
check(
    'the PR nudge diffs the package version',
    /\$\{BASE_SHA\}:package\.json/.test(warnStep),
    true,
);
check(
    '  ...as well as the widget version',
    /\$\{BASE_SHA\}:standalone\/config\.xml/.test(warnStep),
    true,
);

// --- the DIAL service has to name this package ------------------------------
// TizenBrew's app-control path does not install from the name it is handed; it
// looks it up among the modules already installed, with
// `modulesCache.find(m => m.name === name)`, and answers "App Control module not
// found" when nothing matches. So the name the service sends has to be the name
// this package publishes under, or casting to a TV running this fork launches
// nothing. Pinned here because the two live in different files and a rename
// would otherwise break only on a television.
const dialService = readFileSync(repoPath('service', 'service.ts'), 'utf8');
const pkgName = JSON.parse(readFileSync(repoPath('package.json'), 'utf8')).name;
const sent = (dialService.match(/moduleName:\s*'([^']+)'/) || [])[1];
check('the DIAL service names a module', typeof sent, 'string');
check('  ...and it is this package', sent, pkgName);

done();
