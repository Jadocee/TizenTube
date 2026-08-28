// Re-derives every generated harness snapshot from the current sources.
//
// Several harnesses run the mod's real code, but hold a copy of it: a .mts with
// its imports repointed at stubs, a transpiled module spliced into an HTML
// page, an extracted function. Those copies go stale the moment a source file
// changes, so this runs before every pass -- which is what makes a harness
// failure mean "the code regressed" rather than "the copy is old".
//
// The `old`/`before` fixtures are NOT derived. They reproduce the bugs that
// were fixed, and refreshing them would erase the comparison.

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { repoPath, readRepo, testRoot } from './lib/repo.mjs';

const TSC = repoPath('mods', 'node_modules', '.bin', 'tsc');
const out = (rel, text) => {
    writeFileSync(join(testRoot, rel), text, 'utf8');
    console.log(`  ${rel}`);
};
const fail = (message) => { console.error(`refresh failed: ${message}`); process.exit(1); };

/** Type-strips one TypeScript source with the real compiler, not a regex. */
function transpile(source, name) {
    if (!existsSync(TSC)) fail(`the TypeScript compiler is not installed. Run "npm install" in mods/ first.`);
    const dir = mkdtempSync(join(tmpdir(), 'tt-refresh-'));
    try {
        const input = join(dir, name);
        const output = input.replace(/\.ts$/, '.js');
        writeFileSync(input, source, 'utf8');
        let diagnostics = '';
        try {
            execFileSync(TSC, ['--ignoreConfig', '--target', 'ES2020', '--module', 'ESNext',
                               '--outDir', dir, '--skipLibCheck', input], { stdio: 'pipe' });
        } catch (e) {
            // Type errors are expected and harmless here: these fragments are
            // lifted out of their module, so their imports and ambient globals
            // are gone. Only the emit matters -- tsc still writes it -- so the
            // check is whether the output exists, not the exit code.
            diagnostics = (e.stdout || e.message || '').toString();
        }
        if (!existsSync(output)) {
            fail(`could not transpile ${name}: ${diagnostics.slice(0, 400)}`);
        }
        return readFileSync(output, 'utf8');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log('Refreshing harness snapshots from source:');

// settings.ts, with its imports repointed at the stub module.
let settings = readRepo('mods', 'ui', 'settings.ts')
    .replace("import qrcode from 'qrcode-npm';", "import { qrcode } from './stubs.mjs';")
    .replace("from '../config.js'", "from './stubs.mjs'")
    .replace("from './ytUI.js'", "from './stubs.mjs'")
    .replace("from 'i18next'", "from './stubs.mjs'")
    .replace("from './startupError.js'", "from './startupError.generated.mts'")
    .replace(/^import type .*?;\n/gm, '');
out('settings/settings.generated.mts', settings);

// startupError.ts runs for real.
out('settings/startupError.generated.mts', readRepo('mods', 'ui', 'startupError.ts'));

// disableWhosWatching.ts, exported rather than self-invoking.
// Anchored at end of file on purpose. The same call also appears inside the
// config listener, and replacing that one instead puts an `export` in a
// function body -- which is exactly what happened once, silently, because the
// old runner did not check exit codes.
let whos = readRepo('mods', 'ui', 'disableWhosWatching.ts')
    .replace("from '../config.js'", "from './stub.mjs'")
    .replace(/disableWhosWatching\(configRead\('enableWhoIsWatchingMenu'\)\);\s*$/,
             'export default disableWhosWatching;\n');
if (!/export default disableWhosWatching;\s*$/.test(whos)) {
    fail('disableWhosWatching.ts no longer ends with the expected self-call; fix test/refresh.mjs');
}
if (whos.includes('export default disableWhosWatching;\n\nconst') || whos.split('export default').length > 2) {
    fail('the disableWhosWatching substitution matched more than once; fix test/refresh.mjs');
}
out('whos-watching/mod.generated.mts', whos);

// The patchYttvJson region of adblock.ts, on its own.
const adblock = readRepo('mods', 'features', 'adblock.ts');
const region = adblock.match(/^let jsonPatchAttempts[\s\S]*?^patchYttvJson\(\);$/m);
if (!region) fail('cannot find the patchYttvJson region in adblock.ts; fix test/refresh.mjs');
out('adblock/block.generated.js',
    transpile('declare const window: any;\n' + region[0], 'block.ts').replace(/^\n+/, ''));

// styleSheet.ts, spliced into the CSP test page.
const sheet = transpile(readRepo('mods', 'ui', 'styleSheet.ts'), 'styleSheet.ts').replace(/export function /g, 'function ');
const template = readFileSync(join(testRoot, 'stylesheet/page.template.html'), 'utf8');
const MARKER = '/* __STYLESHEET__ */';
if (!template.includes(MARKER)) fail(`stylesheet/page.template.html is missing its ${MARKER} marker`);
// A function replacement, so a '$&' or '$`' inside the transpiled source
// cannot be read as a replacement pattern -- the same trap styleSheet.ts
// itself documents on its own fallback path.
out('stylesheet/page.html', template.replace(MARKER, () => sheet.trimEnd()));

console.log('All snapshots current.');
