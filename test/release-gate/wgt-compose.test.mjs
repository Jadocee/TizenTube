// compose.yaml, parsed by compose itself.
//
// SEPARATE FROM wgt-docker.test.mjs, and exiting 2 when compose is absent, so
// the repository's skip convention means something here. Folding these into that
// file would make a contributor without Docker either fail a suite over a tool
// they do not need, or -- worse, and what the first version of this did -- print
// "SKIPPED" mid-run and then "ALL PASS", which reads as coverage that never
// happened and which TT_STRICT_SKIP cannot see.
import { spawnSync } from 'node:child_process';
import { checker, repoPath } from '../lib/repo.mjs';

const COMPOSE = repoPath('compose.yaml');

const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
if (probe.status !== 0) {
    console.log('SKIPPED: docker compose is not installed, so compose.yaml was not parsed.');
    process.exit(2);
}

const { check, done } = checker();

const render = (args = [], env = {}) =>
    spawnSync('docker', ['compose', '-f', COMPOSE, ...args, 'config', '--format', 'json'], {
        encoding: 'utf8',
        // A stray .env beside compose.yaml is compose's own mechanism for these
        // variables and would otherwise decide what this suite sees.
        env: { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1', TIZEN_AUTHOR_KEY_PW: 'harness' },
        ...env,
    });

const base = render();
check('compose.yaml parses', base.status, 0);
const cfg = JSON.parse(base.stdout);
const wgt = cfg.services.wgt;

// --- the build service -------------------------------------------------------
check('there is a wgt service', typeof wgt, 'object');
// Samsung publishes no arm64 host build of the SDK at any layer.
check('  ...pinned to amd64', wgt.platform, 'linux/amd64');
// A build that cannot reach the network cannot send the certificate it was just
// handed anywhere. Asserted on the SERVICE, not on the rendered document, so the
// debug shell's own setting cannot satisfy it.
check('  ...with no network at all', wgt.network_mode, 'none');
// sdb's local server binds 0.0.0.0:26099; publishing anything from this stack
// would put a debug bridge on the network.
check('  ...publishing no ports', (wgt.ports ?? []).length, 0);
check(
    '  ...mounting the repository',
    (wgt.volumes ?? []).some((v) => v.target === '/work'),
    true,
);
check(
    '  ...and the certificate read-only',
    (wgt.volumes ?? []).some((v) => v.target === '/run/secrets/author.p12' && v.read_only === true),
    true,
);
check('  ...running the packaging entrypoint', wgt.entrypoint, null);

// --- the debug shell ---------------------------------------------------------
const withDebug = render(['--profile', 'debug']);
check('the debug profile parses', withDebug.status, 0);
const shell = JSON.parse(withDebug.stdout).services.shell;
check('the shell service is behind a profile', (shell.profiles ?? []).includes('debug'), true);
check('  ...and is not in the default set', cfg.services.shell, undefined);
check('  ...it is a shell', (shell.entrypoint ?? []).join(' '), '/bin/bash');
check('  ...and publishes no ports either', (shell.ports ?? []).length, 0);

// --- the certificate password ------------------------------------------------
// Deliberately NOT a compose `:?` requirement. That would block `build`, `ps`
// and `down` as well as `run`, and pre-building the image before you have the
// certificate to hand is exactly what somebody will want to do.
const noPassword = render([], {
    env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'TIZEN_AUTHOR_KEY_PW'),
    ),
});
check('compose works without the certificate password', noPassword.status, 0);
check(
    '  ...leaving the entrypoint to refuse',
    JSON.parse(noPassword.stdout).services.wgt.environment.TIZEN_AUTHOR_KEY_PW,
    '',
);

done();
