// .github/workflows/build-release.yaml, asserted as behaviour rather than as
// text where that is possible at all.
//
// The gate script next door decides whether to publish; this file covers the
// workflow that acts on that decision. Both halves matter and only one of them
// is a program you can run: the other is YAML, where a wrong `if:` is invisible
// until the day it publishes a pull request to the registry.
//
// TWO KINDS OF ASSERTION HERE, AND THE DIFFERENCE IS THE POINT:
//
//   - The pull-request version nudge is a shell script embedded in the YAML, so
//     it is EXTRACTED AND RUN against real throwaway repositories. Matching its
//     source for a substring proves the step reads a file, not that it warns.
//   - The step guards cannot be run without GitHub, so they are read -- but
//     compared WHOLE. `if:` is a boolean expression, and a check that merely
//     finds the guard text somewhere inside it passes for
//     `github.event_name == 'pull_request' || (<the guard>)`, which is the exact
//     mutation that publishes from every pull request.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checker, repoPath } from '../lib/repo.mjs';

const { check, done } = checker();
const WORKFLOW_PATH = repoPath('.github', 'workflows', 'build-release.yaml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

// --- reading the workflow as steps, not as one long string -------------------
// Steps sit at six spaces under `steps:`. A step owns every following line
// indented deeper than its own `- name:`, which is what lets an `if:` be found
// wherever in the step it was written -- YAML mapping keys are unordered, and a
// window of N characters after `id:` silently misses a guard placed above it.
function parseSteps(text) {
    const steps = [];
    let current = null;
    for (const line of text.split('\n')) {
        const named = /^ {6}- name: (.*)$/.exec(line);
        if (named) {
            if (current) steps.push(current);
            current = { name: named[1].trim().replace(/^['"]|['"]$/g, ''), lines: [] };
            continue;
        }
        if (!current) continue;
        // Anything at six spaces or less that is not a continuation ends the step.
        if (line.trim() !== '' && !/^ {7}/.test(line)) {
            steps.push(current);
            current = null;
            continue;
        }
        current.lines.push(line);
    }
    if (current) steps.push(current);
    return steps.map((s) => ({ name: s.name, body: s.lines.join('\n') }));
}

const STEPS = parseSteps(workflow);
const names = STEPS.map((s) => s.name);
const stepNamed = (name) => STEPS.find((s) => s.name === name);
/** The step's `if:` expression, or null when it has none. */
const ifOf = (name) => {
    const step = stepNamed(name);
    if (!step) return null;
    const m = /^ {8}if: (.*)$/m.exec(step.body);
    return m ? m[1].trim() : null;
};

check('the workflow parses into steps', STEPS.length > 10, true);

// --- every step these assertions talk about must EXIST -----------------------
// Named first and separately, because the checks below compare positions and
// conditions, and a missing step makes those vacuous rather than failing. An
// indexOf of an absent step returns -1, and -1 is less than every real index --
// so "published after the harnesses" would pass loudest exactly when there are
// no harnesses left to run.
const REQUIRED = [
    'Run the harnesses',
    'Warn if shipped code changed without a version bump',
    'Decide whether this run publishes to npm',
    'Check the npm token',
    'Verify the package contents',
    'Publish to npm',
    'Use Node 22',
];
for (const name of REQUIRED) check(`the workflow still has "${name}"`, names.includes(name), true);

// --- the workflow has to act on the gate's answer ---------------------------
// Without these conditions a pull request reaches `npm publish`, and a version
// cannot be un-taken. Compared in full: `if:` is a boolean expression, so a
// substring check would accept a widened one that inverts the meaning.
const PUBLISH_GUARD = "steps.npm.outputs.publish == 'true'";
const BOTH_GUARDS = `${PUBLISH_GUARD} && steps.npm-auth.outputs.configured == 'true'`;
check('the token check is gated on exactly the gate', ifOf('Check the npm token'), PUBLISH_GUARD);
check(
    'the pack check is gated on exactly the gate and the token',
    ifOf('Verify the package contents'),
    BOTH_GUARDS,
);
check(
    'the publish is gated on exactly the gate and the token',
    ifOf('Publish to npm'),
    BOTH_GUARDS,
);
// And the step producing the answer must not gate on anything, which would make
// it skippable and leave every downstream guard evaluating false forever.
check(
    'the gate step has no condition of its own',
    ifOf('Decide whether this run publishes to npm'),
    null,
);
check(
    'the nudge runs only on pull requests',
    ifOf('Warn if shipped code changed without a version bump'),
    "github.event_name == 'pull_request'",
);

// Order is load-bearing, not cosmetic: an npm version cannot be reused, so a
// tarball that reached the registry before the suite ran could never be taken
// back. Compared by position among parsed steps, which is only meaningful
// because both were asserted to exist above.
check(
    'nothing is published before the harnesses run',
    names.indexOf('Run the harnesses') < names.indexOf('Publish to npm'),
    true,
);
check(
    'and nothing is published before the gate decides',
    names.indexOf('Decide whether this run publishes to npm') < names.indexOf('Publish to npm'),
    true,
);

// --- npm has to be able to authenticate -------------------------------------
// NODE_AUTH_TOKEN is not an npm variable. It is the placeholder inside the
// .npmrc that actions/setup-node writes, and it writes that file ONLY when given
// registry-url. Without it `npm publish` runs unauthenticated and fails with
// ENEEDAUTH however correct the secret is -- a failure that cannot show up until
// the first run that actually tries to publish.
const setupNode = stepNamed('Use Node 22');
check(
    'setup-node is given a registry',
    /registry-url:\s*'?https:\/\/registry\.npmjs\.org/.test(setupNode.body),
    true,
);
check(
    '  ...and the publish passes the token it expands',
    /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/.test(stepNamed('Publish to npm').body),
    true,
);
// Provenance needs the id-token permission; asking for it without one fails the
// publish outright.
check(
    'the publish claims provenance',
    /npm publish[^\n]*--provenance/.test(stepNamed('Publish to npm').body),
    true,
);
check('  ...and the job may mint the token', /id-token: write/.test(workflow), true);

// --- the pull-request nudge, actually run ------------------------------------
// Extracted from the YAML and executed, because the thing worth asserting is
// whether it warns -- not whether its source mentions a filename.
function runBlockOf(name) {
    const body = stepNamed(name).body;
    const lines = body.split('\n');
    const at = lines.findIndex((l) => /^ {8}run: \|/.test(l));
    if (at < 0) throw new Error(`no run: block in "${name}"`);
    const out = [];
    for (const line of lines.slice(at + 1)) {
        if (line.trim() === '') {
            out.push('');
            continue;
        }
        if (!/^ {10}/.test(line)) break;
        out.push(line.slice(10));
    }
    return out.join('\n');
}
const NUDGE = runBlockOf('Warn if shipped code changed without a version bump');
check('the nudge script was extracted', NUDGE.includes('set -euo pipefail'), true);

const widget = (v) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<widget xmlns="http://www.w3.org/ns/widgets" version="${v}" viewmodes="maximized">\n</widget>\n`;
const pkg = (v, extra = {}) =>
    `${JSON.stringify({ name: 'tizentube-9', version: v, ...extra }, null, 2)}\n`;

/**
 * Builds a two-commit repo -- a base and a head -- writes `files` at each, then
 * runs the extracted nudge with BASE_SHA pointing at the base commit.
 */
function nudge({ base, head, baseSha }) {
    const dir = mkdtempSync(join(tmpdir(), 'tt-nudge-'));
    const git = (...a) =>
        execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
            .toString()
            .trim();
    const writeAll = (files) => {
        for (const [path, body] of Object.entries(files)) {
            mkdirSync(join(dir, dirname(path)), { recursive: true });
            writeFileSync(join(dir, path), body);
        }
    };
    try {
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@t');
        git('config', 'user.name', 't');
        writeAll(base);
        git('add', '-A');
        git('commit', '-qm', 'base');
        const sha = git('rev-parse', 'HEAD');
        writeAll(head);
        git('add', '-A');
        // --allow-empty so a case can hold the tree still and vary only the base
        // SHA, which is what the shallow-checkout case does.
        git('commit', '-q', '--allow-empty', '-m', 'head');
        let stdout = '';
        let status = 0;
        try {
            stdout = execFileSync('bash', ['-c', NUDGE], {
                cwd: dir,
                env: { ...process.env, BASE_SHA: baseSha ?? sha },
                stdio: ['ignore', 'pipe', 'pipe'],
            }).toString();
        } catch (e) {
            status = e.status ?? 1;
            stdout = `${e.stdout || ''}${e.stderr || ''}`;
        }
        return {
            status,
            stdout,
            npmWarned: /::warning::This PR changes code that ships in the npm package/.test(stdout),
            wgtWarned: /::warning::This PR changes shipped code but leaves the widget version/.test(
                stdout,
            ),
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const BASE = {
    'package.json': pkg('1.0.0'),
    'standalone/config.xml': widget('2.0.0'),
    'mods/userScript.ts': 'const a = 1;\n',
    'service/service.ts': 'const b = 1;\n',
    'docs/BUILDING.md': 'docs\n',
};

// The case the nudge exists for.
const modsNoBump = nudge({ base: BASE, head: { ...BASE, 'mods/userScript.ts': 'const a = 2;\n' } });
check('changing mods/ without an npm bump warns', modsNoBump.npmWarned, true);
check('  ...and about the widget too', modsNoBump.wgtWarned, true);
check('  ...without failing the step', modsNoBump.status, 0);

const modsBumped = nudge({
    base: BASE,
    head: { ...BASE, 'mods/userScript.ts': 'const a = 2;\n', 'package.json': pkg('1.1.0') },
});
check('bumping the package version silences the npm warning', modsBumped.npmWarned, false);
check('  ...but not the widget one', modsBumped.wgtWarned, true);

// package.json is not only metadata: TizenBrew reads main, serviceFile,
// websiteURL and keys straight out of the published copy, so changing one of
// them changes what runs on a television and needs a version to reach anyone.
const configOnly = nudge({
    base: BASE,
    head: { ...BASE, 'package.json': pkg('1.0.0', { websiteURL: 'https://example.invalid' }) },
});
check('changing shipped package.json fields warns', configOnly.npmWarned, true);

// Documentation ships in the tarball but changes nothing that runs, so it must
// not warn -- a nudge that fires on every pull request is one nobody reads.
const docsOnly = nudge({ base: BASE, head: { ...BASE, 'docs/BUILDING.md': 'more docs\n' } });
check('a docs-only change warns about neither', docsOnly.npmWarned || docsOnly.wgtWarned, false);

// The .wgt half still works, and is independent of the npm half.
const standaloneOnly = nudge({
    base: BASE,
    head: { ...BASE, 'standalone/index.html': '<html></html>\n' },
});
check('changing standalone/ warns about the widget', standaloneOnly.wgtWarned, true);
check('  ...and not about the npm package', standaloneOnly.npmWarned, false);
const widgetBumped = nudge({
    base: BASE,
    head: {
        ...BASE,
        'standalone/index.html': '<html></html>\n',
        'standalone/config.xml': widget('2.1.0'),
    },
});
check('bumping the widget version silences its warning', widgetBumped.wgtWarned, false);

// A base commit that is not in the checkout is a shallow clone, not a defect.
const shallow = nudge({ base: BASE, head: BASE, baseSha: 'b'.repeat(40) });
check('an unreachable base skips rather than failing', shallow.status, 0);
check('  ...saying so', /is not in this checkout/.test(shallow.stdout), true);

// --- the publish step, actually run -----------------------------------------
// The step before it can only see whether the secret is empty. Every other way
// a publish fails is an account setting it cannot read, and npm reports each of
// them as a one-line error code buried under a stack of notices -- so the step
// translates them, and this drives the real block against each code.
//
// The EOTP case is the one that actually happened: the token authenticated,
// provenance was signed and logged, and npm then asked for a one-time password
// because the account requires 2FA for writes.
const PUBLISH = runBlockOf('Publish to npm');
check('the publish script was extracted', PUBLISH.includes('npm publish'), true);

/** Runs the extracted publish block with a stubbed npm that fails a given way. */
function publish(npmBody) {
    const dir = mkdtempSync(join(tmpdir(), 'tt-publish-'));
    try {
        const bin = join(dir, 'bin');
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, 'npm'), `#!/bin/sh\n${npmBody}\n`, { mode: 0o755 });
        let stdout = '';
        let status = 0;
        try {
            stdout = execFileSync('bash', ['-c', PUBLISH], {
                cwd: dir,
                env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
                stdio: ['ignore', 'pipe', 'pipe'],
            }).toString();
        } catch (e) {
            status = e.status ?? 1;
            stdout = `${e.stdout || ''}${e.stderr || ''}`;
        }
        return { status, stdout };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const ok = publish('echo "+ tizentube-9@1.15.0"\nexit 0');
check('a successful publish succeeds', ok.status, 0);
check('  ...and says nothing alarming', /::error::/.test(ok.stdout), false);

const otp = publish(`echo "npm notice Publishing to https://registry.npmjs.org/"
echo "npm error code EOTP" >&2
echo "npm error This operation requires a one-time password from your authenticator." >&2
exit 1`);
check('an OTP demand fails the step', otp.status !== 0, true);
check(
    '  ...naming two-factor authentication as the cause',
    /::error::.*two-factor authentication/.test(otp.stdout),
    true,
);
check('  ...and Bypass 2FA as the fix', /Bypass 2FA/.test(otp.stdout), true);
check('  ...and that no version bump is needed to retry', /no bump/.test(otp.stdout), true);

const unauthorized = publish('echo "npm error code E401" >&2\nexit 1');
check('a rejected token fails the step', unauthorized.status !== 0, true);
check(
    '  ...and points at the secret, not at 2FA',
    /::error::npm rejected NPM_TOKEN/.test(unauthorized.stdout),
    true,
);

const forbidden = publish('echo "npm error code E403" >&2\nexit 1');
check('a forbidden publish fails the step', forbidden.status !== 0, true);
check('  ...and points at scope ownership', /does not own the scope/.test(forbidden.stdout), true);

// The one that actually stopped the first release, and the least legible of the
// four: npm answers "you cannot publish under this scope" with the same 404 it
// gives for a package that does not exist, on a PUT, under a pile of notices --
// which reads as a broken registry rather than as a naming problem.
const notMyScope = publish(`echo "npm error code E404" >&2
echo "npm error 404 Not Found - PUT https://registry.npmjs.org/@someone%2fthing" >&2
exit 1`);
check('a 404 on upload fails the step', notMyScope.status !== 0, true);
check(
    '  ...saying it is not a missing registry',
    /does not mean the registry is missing/.test(notMyScope.stdout),
    true,
);
check(
    '  ...but a scope you cannot publish under',
    /scope you cannot publish under/.test(notMyScope.stdout),
    true,
);

// An unrecognised failure must still fail. Translating only the codes we know
// about would otherwise turn every other npm error into a green run.
const unknown = publish('echo "npm error code ESOMETHINGNEW" >&2\nexit 1');
check('an unrecognised npm failure still fails the step', unknown.status !== 0, true);

done();
