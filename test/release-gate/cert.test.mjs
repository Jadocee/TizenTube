// .github/scripts/prepare-certificate.sh, which turns the repository secrets
// into the .p12 the packager signs with -- and decides whether this repository
// signs at all.
//
// Two situations look alike from inside a workflow and must not be treated
// alike. NOT CONFIGURED (neither secret exists) is a legitimate choice: the
// TizenBrew module route needs no certificate, and a repository shipping only
// that way should not get a red main every time the widget version moves. That
// emits signed=false and exits 0. MISCONFIGURED -- one of the pair, bad base64,
// a decode too small to be a certificate -- is somebody's half-finished setup
// and fails at the step that is supposed to produce the material.
//
// The case that drove all of this is the one that actually happened on the
// first release: neither secret was set, `echo "" | base64 -d` wrote a
// zero-byte file, the step exited 0 *and let the build continue*, and the
// packager reported "Too few bytes to parse DER" half a minute later.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checker, repoPath, readRepo } from '../lib/repo.mjs';

const { check, done } = checker();
const SCRIPT = repoPath('.github', 'scripts', 'prepare-certificate.sh');

/** Runs the script with the given secrets. Never throws; reports the outcome. */
function run({ key, password }) {
    const dir = mkdtempSync(join(tmpdir(), 'tt-cert-'));
    const certPath = join(dir, 'author.p12');
    const outPath = join(dir, 'github_output');
    const env = { ...process.env, CERT_PATH: certPath, GITHUB_OUTPUT: outPath };
    // Deleted rather than set empty, so "unset" is genuinely unset.
    delete env.TIZEN_AUTHOR_KEY;
    delete env.TIZEN_AUTHOR_KEY_PW;
    if (key !== undefined) env.TIZEN_AUTHOR_KEY = key;
    if (password !== undefined) env.TIZEN_AUTHOR_KEY_PW = password;
    const collect = (code, out) => {
        const outputs = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
        const signed = (outputs.match(/^signed=(\S+)$/m) || [])[1] ?? null;
        return { code, out, signed, size: existsSync(certPath) ? statSync(certPath).size : -1 };
    };
    try {
        const stdout = execFileSync('bash', [SCRIPT], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).toString();
        return collect(0, stdout);
    } catch (e) {
        return collect(e.status, (e.stdout || '').toString() + (e.stderr || '').toString());
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- not configured: a choice, not a defect ---------------------------------
// This must not fail the run. It must also not report signed=true, because that
// is exactly the path that handed a zero-byte file to the packager.
let r = run({});
check('no secrets at all does not fail the run', r.code, 0);
check('  ...but reports that it cannot sign', r.signed, 'false');
check('  ...and leaves no .p12 behind', r.size <= 0, true);
check('  ...and says how to turn publishing on', r.out.includes('TIZEN_AUTHOR_KEY '), true);
check('  ...and warns rather than passing silently', r.out.includes('::warning::'), true);

r = run({ key: '', password: '' });
check('empty secrets are the same as unset', r.code, 0);
check('  ...reporting signed=false', r.signed, 'false');
check('  ...instead of leaving a 0-byte .p12 for the packager', r.size <= 0, true);

// --- half configured: somebody meant to sign here ---------------------------
r = run({ key: 'aGVsbG8=', password: '' });
check('a key with no password fails', r.code, 1);
check('  ...and names the password', r.out.includes('TIZEN_AUTHOR_KEY_PW is not'), true);

r = run({ password: 'pw' });
check('a password with no key fails', r.code, 1);
check('  ...and names the key', r.out.includes('TIZEN_AUTHOR_KEY is not'), true);

// --- material that decodes but is not a certificate -------------------------
r = run({ key: 'aGVsbG8=', password: 'pw' }); // "hello"
check('a tiny decode is rejected', r.code, 1);
check('  ...and says how big it actually was', /is 5 bytes/.test(r.out), true);
check('  ...and does not claim to have signed', r.signed, null);

r = run({ key: 'not!valid!base64!', password: 'pw' });
check('invalid base64 is rejected', r.code, 1);
check('  ...and says so plainly', r.out.includes('not valid base64'), true);

// --- a real certificate -----------------------------------------------------
// Generated here rather than committed: a .p12 in the repository is a bad habit
// even when it is throwaway.
const dir = mkdtempSync(join(tmpdir(), 'tt-realcert-'));
let realKey = null;
try {
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            join(dir, 'k.pem'),
            '-out',
            join(dir, 'c.pem'),
            '-days',
            '1',
            '-subj',
            '/CN=tizentube-test',
        ],
        { stdio: 'ignore' },
    );
    execFileSync(
        'openssl',
        [
            'pkcs12',
            '-export',
            '-out',
            join(dir, 'a.p12'),
            '-inkey',
            join(dir, 'k.pem'),
            '-in',
            join(dir, 'c.pem'),
            '-passout',
            'pass:testpw',
        ],
        { stdio: 'ignore' },
    );
    realKey = execFileSync('base64', ['-w0', join(dir, 'a.p12')])
        .toString()
        .trim();
} catch (e) {
    console.log('  --  openssl unavailable; skipping the valid-certificate cases');
} finally {
    rmSync(dir, { recursive: true, force: true });
}

if (realKey) {
    r = run({ key: realKey, password: 'testpw' });
    check('a real .p12 with the right password succeeds', r.code, 0);
    check('  ...and reports signed=true', r.signed, 'true');
    check('  ...and writes a certificate of a plausible size', r.size > 100, true);
    check('  ...and confirms the password opens it', r.out.includes('the password opens it'), true);

    // A wrong password must not fail the build here -- OpenSSL and the packager
    // disagree about older ciphers, so this warns and lets the packager decide.
    r = run({ key: realKey, password: 'wrong' });
    check('a wrong password warns rather than failing', r.code, 0);
    check('  ...and still reports signed=true', r.signed, 'true');
    check('  ...and points at the password', r.out.includes('::warning::'), true);
}

// --- signed=false has to actually stop the build ----------------------------
// The output is worthless unless the packaging steps read it: without these
// conditions an unconfigured repository would reach `tizenjs build` with no
// certificate at all, which is the original failure with extra steps.
const workflow = readRepo('.github', 'workflows', 'build-release.yaml');
const GUARD = "steps.cert.outputs.signed == 'true'";
for (const step of [
    'Build TizenTube',
    'Upload TizenTube package artifact',
    'Release TizenTube Build Results',
]) {
    const at = workflow.indexOf(`- name: ${step}\n`);
    const condition = at < 0 ? '' : (workflow.slice(at, at + 400).match(/^\s+if: .*$/m) || [''])[0];
    check(`"${step}" is gated on a certificate`, condition.includes(GUARD), true);
}
// And the step producing it must not gate on its own output, which would make
// it unreachable and skip every release forever.
const certAt = workflow.indexOf('id: cert\n');
check(
    'the certificate step does not gate on its own output',
    certAt > 0 && !workflow.slice(certAt, certAt + 200).includes(GUARD),
    true,
);

done();
