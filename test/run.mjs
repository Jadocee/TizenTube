// Runs every harness. Refreshes the generated snapshots first, so a failure
// always means the code changed rather than a copy going stale.
//
//   node test/run.mjs            all harnesses
//   node test/run.mjs settings   only those whose name contains "settings"

import { spawnSync } from 'child_process';
import { join } from 'path';
import { testRoot, repoPath } from './lib/repo.mjs';
import { existsSync } from 'fs';

const HARNESSES = [
    { name: 'settings tree walk',    dir: 'settings',      file: 'drive.mjs',      types: true },
    { name: 'menu scenarios',        dir: 'settings',      file: 'stale.mjs',      types: true },
    { name: 'startup breadcrumb',    dir: 'settings',      file: 'crumb.mjs',      types: true },
    { name: "who's-watching storage", dir: 'whos-watching', file: 'test.mjs',      types: true },
    { name: 'adblock JSON patch',    dir: 'adblock',       file: 'test.mjs' },
    { name: 'command executor',      dir: 'command-executor', file: 'test.mjs', types: true },
    { name: 'stylesheet under CSP',  dir: 'stylesheet',    file: 'run.mjs',        browser: true },
    { name: 'theme panel styling',   dir: 'panel-style',   file: 'test.mjs',       browser: true },
    { name: 'proxy injection',       dir: 'injection',     file: 'proxy.test.mjs' },
    { name: 'bundle at document-start', dir: 'injection',  file: 'docstart.mjs',   browser: true, needsBundle: true },
    { name: 'bundle injected last',  dir: 'injection',     file: 'late.mjs',       browser: true, needsBundle: true },
    { name: 'splash state machine',  dir: 'splash',        file: 'test.mjs' },
    { name: 'injector attach',       dir: 'injector',      file: 'test.mjs',       types: true },
    { name: 'strict service bundle', dir: 'strict-bundle', file: 'test.mjs' },
];

const filter = process.argv[2];
const selected = filter
    ? HARNESSES.filter((h) => (h.name + ' ' + h.dir).toLowerCase().includes(filter.toLowerCase()))
    : HARNESSES;

if (!selected.length) {
    console.error(`No harness matches "${filter}".`);
    process.exit(1);
}

const refresh = spawnSync(process.execPath, [join(testRoot, 'refresh.mjs')], { stdio: 'inherit' });
if (refresh.status !== 0) process.exit(1);

let failed = 0, skipped = 0, passed = 0;

for (const h of selected) {
    console.log(`\n########## ${h.name} ##########`);

    // The two document-order harnesses load the real bundle, which has to exist.
    if (h.needsBundle && !existsSync(repoPath('dist', 'userScript.js'))) {
        console.log('SKIPPED: dist/userScript.js is not built. Run "npm run build" in mods/ first.');
        skipped++;
        continue;
    }

    const args = h.types ? ['--experimental-strip-types', h.file] : [h.file];
    const res = spawnSync(process.execPath, args, { cwd: join(testRoot, h.dir), stdio: 'inherit' });

    if (res.status === 0) passed++;
    else if (res.status === 2) skipped++;
    else { failed++; console.log(`>>> ${h.name} FAILED`); }
}

console.log(`\n${'='.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
