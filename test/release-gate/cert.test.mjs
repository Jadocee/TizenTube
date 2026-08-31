// .github/scripts/prepare-certificate.sh, which turns the repository secrets
// into the .p12 the packager signs with.
//
// The case that matters most is the one that actually happened on the first
// release: neither secret was set, `echo "" | base64 -d` wrote a zero-byte file,
// the step exited 0, and the packager reported "Too few bytes to parse DER" half
// a minute later -- a true statement about an empty file that says nothing about
// why. This asserts the step refuses at the point the material is missing.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checker, repoPath } from '../lib/repo.mjs';

const { check, done } = checker();
const SCRIPT = repoPath('.github', 'scripts', 'prepare-certificate.sh');

/** Runs the script with the given secrets. Never throws; reports the outcome. */
function run({ key, password }) {
    const dir = mkdtempSync(join(tmpdir(), 'tt-cert-'));
    const certPath = join(dir, 'author.p12');
    const env = { ...process.env, CERT_PATH: certPath };
    // Deleted rather than set empty, so "unset" is genuinely unset.
    delete env.TIZEN_AUTHOR_KEY;
    delete env.TIZEN_AUTHOR_KEY_PW;
    if (key !== undefined) env.TIZEN_AUTHOR_KEY = key;
    if (password !== undefined) env.TIZEN_AUTHOR_KEY_PW = password;
    try {
        const stdout = execFileSync('bash', [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        return { code: 0, out: stdout, size: existsSync(certPath) ? statSync(certPath).size : -1 };
    } catch (e) {
        return {
            code: e.status,
            out: (e.stdout || '').toString() + (e.stderr || '').toString(),
            size: existsSync(certPath) ? statSync(certPath).size : -1,
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// --- the failure that actually happened -------------------------------------
let r = run({});
check('no secrets at all fails', r.code, 1);
check('  ...and names the missing key', r.out.includes('TIZEN_AUTHOR_KEY is not set'), true);

r = run({ key: '', password: '' });
check('empty secrets fail rather than writing an empty file', r.code, 1);
check('  ...instead of leaving a 0-byte .p12 for the packager', r.size <= 0, true);

r = run({ key: 'aGVsbG8=', password: '' });
check('a key with no password fails', r.code, 1);
check('  ...and names the password', r.out.includes('TIZEN_AUTHOR_KEY_PW is not set'), true);

// --- material that decodes but is not a certificate -------------------------
r = run({ key: 'aGVsbG8=', password: 'pw' });          // "hello"
check('a tiny decode is rejected', r.code, 1);
check('  ...and says how big it actually was', /is 5 bytes/.test(r.out), true);

r = run({ key: 'not!valid!base64!', password: 'pw' });
check('invalid base64 is rejected', r.code, 1);
check('  ...and says so plainly', r.out.includes('not valid base64'), true);

// --- a real certificate -----------------------------------------------------
// Generated here rather than committed: a .p12 in the repository is a bad habit
// even when it is throwaway.
const dir = mkdtempSync(join(tmpdir(), 'tt-realcert-'));
let realKey = null;
try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout',
        join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=tizentube-test'],
        { stdio: 'ignore' });
    execFileSync('openssl', ['pkcs12', '-export', '-out', join(dir, 'a.p12'), '-inkey',
        join(dir, 'k.pem'), '-in', join(dir, 'c.pem'), '-passout', 'pass:testpw'], { stdio: 'ignore' });
    realKey = execFileSync('base64', ['-w0', join(dir, 'a.p12')]).toString().trim();
} catch (e) {
    console.log('  --  openssl unavailable; skipping the valid-certificate cases');
} finally {
    rmSync(dir, { recursive: true, force: true });
}

if (realKey) {
    r = run({ key: realKey, password: 'testpw' });
    check('a real .p12 with the right password succeeds', r.code, 0);
    check('  ...and writes a certificate of a plausible size', r.size > 100, true);
    check('  ...and confirms the password opens it', r.out.includes('the password opens it'), true);

    // A wrong password must not fail the build here -- OpenSSL and the packager
    // disagree about older ciphers, so this warns and lets the packager decide.
    r = run({ key: realKey, password: 'wrong' });
    check('a wrong password warns rather than failing', r.code, 0);
    check('  ...and points at the password', r.out.includes('::warning::'), true);
}

done();
