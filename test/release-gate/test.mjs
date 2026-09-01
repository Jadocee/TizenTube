// .github/scripts/release-gate.sh, driven through every case that decides
// whether CI publishes a signed .wgt.
//
// This is the least forgiving code in the repository to get wrong: it runs with
// the signing certificate available and can create or move a git tag that people
// download a package from. It had also never executed once, because the workflow
// only fired on tags and the repository has none.
//
// Each case builds a throwaway git repo, so the script runs against real git
// history rather than a stub of it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checker, repoPath } from '../lib/repo.mjs';

const { check, done } = checker();
const SCRIPT = repoPath('.github', 'scripts', 'release-gate.sh');

const configXml = (version) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<widget xmlns:tizen="http://tizen.org/ns/widgets" xmlns="http://www.w3.org/ns/widgets" ` +
    `id="https://tizentube.app" version="${version}" viewmodes="maximized">\n` +
    `    <tizen:application id="xvvl3S1TT1.TizenTubeStandalone" package="xvvl3S1TT1" required_version="9.0"/>\n` +
    `</widget>\n`;

/**
 * Builds a repo whose history moves config.xml through `versions`, then runs the
 * gate as the given event. Returns the parsed GITHUB_OUTPUT plus stdout.
 */
function run({
    versions,
    event = 'push',
    refType = 'branch',
    refName = 'main',
    before = 'HEAD~1',
    tags = [],
}) {
    const dir = mkdtempSync(join(tmpdir(), 'tt-gate-'));
    const git = (...args) =>
        execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
            .toString()
            .trim();
    try {
        mkdirSync(join(dir, 'standalone'), { recursive: true });
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@t');
        git('config', 'user.name', 't');
        const shas = [];
        versions.forEach((v, i) => {
            writeFileSync(join(dir, 'standalone', 'config.xml'), configXml(v));
            // Something unrelated changes in every commit, so a commit that
            // leaves the version alone is still a commit -- which is the whole
            // point of the unchanged-version cases.
            writeFileSync(join(dir, 'src.txt'), `change ${i}\n`);
            git('add', '-A');
            git('commit', '-qm', `commit ${i} (version ${v})`);
            shas.push(git('rev-parse', 'HEAD'));
        });
        for (const t of tags) git('tag', t);

        let beforeSha = before;
        if (before === 'HEAD~1') beforeSha = shas.length > 1 ? shas[shas.length - 2] : '';
        else if (before === 'ZERO') beforeSha = '0'.repeat(40);
        else if (before === 'ABSENT') beforeSha = 'b'.repeat(40);

        const outFile = join(dir, 'gh-output');
        writeFileSync(outFile, '');
        const stdout = execFileSync('bash', [SCRIPT], {
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
        const out = Object.fromEntries(
            readFileSync(outFile, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => l.split('=', 2)),
        );
        return { ...out, stdout };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- a push to main ---------------------------------------------------------
let r = run({ versions: ['2.0.1', '2.0.2'] });
check('a version bump on main publishes', r.release, 'true');
check('  ...under the new version', r.tag, 'v2.0.2');

r = run({ versions: ['2.0.1', '2.0.1'] });
check('an unchanged version does not publish', r.release, 'false');

// The bug this replaced: reusing `git describe` would have found the previous
// release's tag and re-published over it.
r = run({ versions: ['2.0.1', '2.0.1'], tags: ['v2.0.1'] });
check('an unchanged version does not re-publish an existing tag', r.release, 'false');

// Never move a tag someone may already have downloaded a .wgt from.
r = run({ versions: ['2.0.0', '2.0.1'], tags: ['v2.0.1'] });
check('a bump onto an existing tag refuses rather than moving it', r.release, 'false');
check('  ...and says why', r.stdout.includes('already exists as a tag'), true);

// --- a tag push -------------------------------------------------------------
r = run({ versions: ['2.0.1'], refType: 'tag', refName: 'v2.0.1', before: 'ZERO' });
check('a tag push publishes', r.release, 'true');
check('  ...under the pushed tag', r.tag, 'v2.0.1');

r = run({ versions: ['2.0.1'], refType: 'tag', refName: 'v9.9.9', before: 'ZERO' });
check('a tag that disagrees with config.xml still publishes', r.release, 'true');
check('  ...but warns about the mismatch', r.stdout.includes('::warning::'), true);

// --- everything else --------------------------------------------------------
r = run({ versions: ['2.0.1', '2.0.2'], event: 'pull_request' });
check('a pull request never publishes', r.release, 'false');

r = run({ versions: ['2.0.1'], before: 'ZERO' });
check('a brand-new branch does not publish', r.release, 'false');

r = run({ versions: ['2.0.1', '2.0.2'], before: 'ABSENT' });
check('an unreachable previous commit does not publish', r.release, 'false');

// --- reading the version ----------------------------------------------------
// The unanchored match takes the XML declaration and yields "1.0", which is what
// the inline version of this logic did.
r = run({ versions: ['2.0.1', '2.0.2'] });
check('the version comes from <widget>, not the XML declaration', r.tag, 'v2.0.2');
check('  ...so it is never v1.0', r.tag !== 'v1.0', true);

done();
