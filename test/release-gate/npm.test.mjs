// .github/scripts/npm-gate.sh, driven through every case that decides whether
// CI publishes the npm package TizenBrew installs.
//
// An npm version cannot be reused once taken and cannot meaningfully be
// unpublished after 72 hours, so a gate that publishes when it should not is
// unrecoverable in a way the .wgt gate beside it is not -- a bad GitHub release
// can simply be deleted. That asymmetry is why every branch here is exercised
// against a real git repo rather than a stub of one.
//
// The two gates are deliberately separate and read different versions: this one
// reads package.json, release-gate.sh reads standalone/config.xml. The last case
// below asserts that independence directly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

/**
 * Builds a repo whose history moves package.json through `versions`, then runs
 * the gate as the given event. Returns the parsed GITHUB_OUTPUT, stdout, and
 * the exit status.
 */
function run({
    versions,
    event = 'push',
    refType = 'branch',
    refName = 'main',
    before = 'HEAD~1',
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
                    ...process.env,
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
        for (const line of execFileSync('cat', [outFile]).toString().split('\n')) {
            const at = line.indexOf('=');
            if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
        }
        return { out, stdout, status };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- a version bump on main -------------------------------------------------
const bumped = run({ versions: ['1.0.0', '1.1.0'] });
check('a version bump on main publishes', bumped.out.publish, 'true');
check('  ...at the new version', bumped.out.version, '1.1.0');
check('  ...under the package name', bumped.out.name, '@jadocee/tizentube');

// --- everything that must NOT publish ---------------------------------------
check('an unchanged version does not', run({ versions: ['1.0.0', '1.0.0'] }).out.publish, 'false');
// The one that matters most: a version cannot be un-taken, and a pull request is
// untrusted code.
check(
    'a pull request does not',
    run({ versions: ['1.0.0', '1.1.0'], event: 'pull_request' }).out.publish,
    'false',
);
check(
    'a workflow_dispatch does not',
    run({ versions: ['1.0.0', '1.1.0'], event: 'workflow_dispatch' }).out.publish,
    'false',
);
// These two OVERLAP, and the harness says so rather than pretending otherwise.
// An all-zero SHA is not a resolvable commit either, so deleting the zero check
// leaves the cat-file check below it producing the same refusal -- mutating that
// line away does NOT fail this file, and a test written to imply otherwise would
// be theatre. What the zero check contributes alone is the MESSAGE: "no previous
// commit" is a useful thing to read in a log, where "not in this checkout" would
// send someone hunting a fetch-depth problem that does not exist. So the outcome
// is asserted for both, and the wording for the one that owns it.
const newBranch = run({ versions: ['1.0.0'], before: 'ZERO' });
check('a brand-new branch does not', newBranch.out.publish, 'false');
check(
    '  ...and says why, in its own words',
    /no previous commit to compare against/.test(newBranch.stdout),
    true,
);
const shallow = run({ versions: ['1.0.0', '1.1.0'], before: 'ABSENT' });
check('a shallow checkout does not', shallow.out.publish, 'false');
check(
    '  ...and names the commit it could not find',
    /is not in this checkout/.test(shallow.stdout),
    true,
);
check(
    'a first commit with no history does not',
    run({ versions: ['1.0.0'], before: 'HEAD~1' }).out.publish,
    'false',
);

// --- tag pushes -------------------------------------------------------------
const tagged = run({ versions: ['1.0.0'], refType: 'tag', refName: 'v1.0.0' });
check('a matching tag push publishes', tagged.out.publish, 'true');
const mismatched = run({ versions: ['1.0.0'], refType: 'tag', refName: 'v9.9.9' });
check('a mismatched tag still publishes', mismatched.out.publish, 'true');
check('  ...but says so', /::warning::tag v9\.9\.9 does not match/.test(mismatched.stdout), true);

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
const npmGate = decomment(execFileSync('cat', [SCRIPT]).toString());
const wgtGate = decomment(
    execFileSync('cat', [repoPath('.github', 'scripts', 'release-gate.sh')]).toString(),
);
check('the npm gate reads package.json', /package\.json/.test(npmGate), true);
check('  ...and not the widget config', /config\.xml/.test(npmGate), false);
check('the wgt gate reads config.xml', /config\.xml/.test(wgtGate), true);
check('  ...and not the package manifest', /NPM_MANIFEST|package\.json/.test(wgtGate), false);

done();
