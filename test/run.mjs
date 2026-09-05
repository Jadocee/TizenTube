// Runs every harness. Refreshes the generated snapshots first, so a failure
// always means the code changed rather than a copy going stale.
//
//   node test/run.mjs            all harnesses
//   node test/run.mjs settings   only those whose name contains "settings"

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { testRoot, repoPath } from './lib/repo.mjs';
import { existsSync } from 'node:fs';

const HARNESSES = [
    { name: 'settings tree walk', dir: 'settings', file: 'drive.mjs', types: true },
    { name: 'menu scenarios', dir: 'settings', file: 'stale.mjs', types: true },
    { name: 'startup breadcrumb', dir: 'settings', file: 'crumb.mjs', types: true },
    { name: "who's-watching storage", dir: 'whos-watching', file: 'test.mjs', types: true },
    { name: 'adblock JSON patch', dir: 'adblock', file: 'test.mjs' },
    { name: 'command executor', dir: 'command-executor', file: 'test.mjs', types: true },
    { name: 'stylesheet under CSP', dir: 'stylesheet', file: 'run.mjs', browser: true },
    { name: 'theme panel styling', dir: 'panel-style', file: 'test.mjs', browser: true },
    { name: 'proxy injection', dir: 'injection', file: 'proxy.test.mjs' },
    {
        name: 'bundle at document-start',
        dir: 'injection',
        file: 'docstart.mjs',
        browser: true,
        needsBundle: true,
    },
    {
        name: 'bundle injected last',
        dir: 'injection',
        file: 'late.mjs',
        browser: true,
        needsBundle: true,
    },
    { name: 'splash state machine', dir: 'splash', file: 'test.mjs' },
    { name: 'injector attach', dir: 'injector', file: 'test.mjs', types: true },
    { name: 'strict service bundle', dir: 'strict-bundle', file: 'test.mjs' },
    { name: 'sponsorblock channels', dir: 'sponsorblock-channels', file: 'test.mjs', types: true },
    { name: 'release gate', dir: 'release-gate', file: 'test.mjs' },
    { name: 'release certificate', dir: 'release-gate', file: 'cert.test.mjs' },
    { name: 'npm publish gate', dir: 'release-gate', file: 'npm.test.mjs' },
    { name: 'release workflow shape', dir: 'release-gate', file: 'workflow.test.mjs' },
    { name: 'wgt docker stack', dir: 'release-gate', file: 'wgt-docker.test.mjs' },
    { name: 'wgt compose stack', dir: 'release-gate', file: 'wgt-compose.test.mjs' },
    { name: 'json-prune matcher', dir: 'json-prune', file: 'test.mjs', types: true },
    { name: 'preview indicator state', dir: 'preview-indicator', file: 'state.mjs', types: true },
    {
        name: 'preview indicator styling',
        dir: 'preview-indicator',
        file: 'style.mjs',
        browser: true,
    },
    {
        name: 'preview indicator runtime',
        dir: 'preview-indicator',
        file: 'runtime.mjs',
        types: true,
    },
    { name: 'preview service hook', dir: 'preview-indicator', file: 'hook.mjs', types: true },
    { name: 'sponsorblock skip filter', dir: 'skip-filter', file: 'test.mjs', types: true },
    { name: 'transport slots', dir: 'transport-slots', file: 'test.mjs', types: true },
    { name: 'blue key panel close', dir: 'transport-slots', file: 'blue.mjs', types: true },
    { name: 'home tile fixes', dir: 'tile-fixes', file: 'test.mjs', types: true },
    { name: 'dearrow request cache', dir: 'tile-fixes', file: 'dearrow.mjs', types: true },
    { name: 'focus motion switches', dir: 'focus-motion', file: 'test.mjs', types: true },
    { name: 'sidebar re-select', dir: 'guide-reselect', file: 'test.mjs', types: true },
    { name: 'tile menu suppression', dir: 'tile-menu', file: 'test.mjs', types: true },
    { name: 'sidebar guide filter', dir: 'guide-filter', file: 'test.mjs', types: true },
    { name: 'caption preferences', dir: 'caption-prefs', file: 'test.mjs', types: true },
    { name: 'caption runtime', dir: 'caption-prefs', file: 'runtime.mjs', types: true },
    { name: 'aislist parsing', dir: 'aislist', file: 'test.mjs', types: true },
    { name: 'aislist refresh', dir: 'aislist', file: 'refresh.mjs', types: true },
    { name: 'aislist fetch gate', dir: 'aislist', file: 'toggle.mjs', types: true },
    { name: 'css nesting on M120', dir: 'css-nesting', file: 'test.mjs' },
    { name: 'docs match the suite', dir: 'docs', file: 'test.mjs' },
];

const filter = process.argv[2];
const selected = filter
    ? HARNESSES.filter((h) => `${h.name} ${h.dir}`.toLowerCase().includes(filter.toLowerCase()))
    : HARNESSES;

if (!selected.length) {
    console.error(`No harness matches "${filter}".`);
    process.exit(1);
}

const refresh = spawnSync(process.execPath, [join(testRoot, 'refresh.mjs')], { stdio: 'inherit' });
if (refresh.status !== 0) process.exit(1);

let failed = 0,
    skipped = 0,
    passed = 0;

for (const h of selected) {
    console.log(`\n########## ${h.name} ##########`);

    // The two document-order harnesses load the real bundle, which has to exist.
    if (h.needsBundle && !existsSync(repoPath('dist', 'userScript.js'))) {
        console.log(
            'SKIPPED: dist/userScript.js is not built. Run "npm run build" in mods/ first.',
        );
        skipped++;
        continue;
    }

    const args = h.types ? ['--experimental-strip-types', h.file] : [h.file];
    const res = spawnSync(process.execPath, args, { cwd: join(testRoot, h.dir), stdio: 'inherit' });

    if (res.status === 0) passed++;
    else if (res.status === 2) skipped++;
    else {
        failed++;
        console.log(`>>> ${h.name} FAILED`);
    }
}

console.log(`\n${'='.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);

// A skipped harness is not a passing one. Skipping is the right default on a
// developer's machine -- no Chromium is not a defect in the code under test --
// but in CI it is a hole: if the browser install fails, five harnesses skip and
// the run still goes green, reporting coverage that never ran. TT_STRICT_SKIP
// makes CI refuse that.
const strictSkip = process.env.TT_STRICT_SKIP === '1';
if (strictSkip && skipped) {
    console.log(
        `TT_STRICT_SKIP is set, so ${skipped} skipped harness${skipped === 1 ? '' : 'es'} count as failures.`,
    );
}
process.exit(failed || (strictSkip && skipped) ? 1 : 0);
