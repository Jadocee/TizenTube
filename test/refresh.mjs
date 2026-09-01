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

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath, readRepo, testRoot } from './lib/repo.mjs';

const TSC = repoPath('mods', 'node_modules', '.bin', 'tsc');
const out = (rel, text) => {
    writeFileSync(join(testRoot, rel), text, 'utf8');
    console.log(`  ${rel}`);
};
const fail = (message) => {
    console.error(`refresh failed: ${message}`);
    process.exit(1);
};

/** Type-strips one TypeScript source with the real compiler, not a regex. */
function transpile(source, name) {
    if (!existsSync(TSC))
        fail(`the TypeScript compiler is not installed. Run "npm install" in mods/ first.`);
    const dir = mkdtempSync(join(tmpdir(), 'tt-refresh-'));
    try {
        const input = join(dir, name);
        const output = input.replace(/\.ts$/, '.js');
        writeFileSync(input, source, 'utf8');
        let diagnostics = '';
        try {
            execFileSync(
                TSC,
                [
                    '--ignoreConfig',
                    '--target',
                    'ES2020',
                    '--module',
                    'ESNext',
                    '--outDir',
                    dir,
                    '--skipLibCheck',
                    input,
                ],
                { stdio: 'pipe' },
            );
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
const settings = readRepo('mods', 'ui', 'settings.ts')
    .replace("import qrcode from 'qrcode-npm';", "import { qrcode } from './stubs.mjs';")
    .replace("from '../config.js'", "from './stubs.mjs'")
    .replace("from './ytUI.js'", "from './stubs.mjs'")
    .replace("from 'i18next'", "from './stubs.mjs'")
    .replace("from './startupError.js'", "from './startupError.generated.mts'")
    .replace("from '../features/videoContext.js'", "from './stubs.mjs'")
    .replace("from '../features/aisList.js'", "from './stubs.mjs'")
    .replace("from '../features/tileMenu.js'", "from './stubs.mjs'")
    .replace(/^import type .*?;\n/gm, '');
// The guard, not the replacements, is what makes this safe: a NEW import added
// to settings.ts fails the tree walk with ERR_MODULE_NOT_FOUND, and this names
// which one rather than leaving a stack trace to read.
for (const gone of [
    '../config.js',
    './ytUI.js',
    '../features/videoContext.js',
    '../features/aisList.js',
    '../features/tileMenu.js',
]) {
    if (settings.includes(`'${gone}'`))
        fail(`settings.ts import of ${gone} no longer matches; fix test/refresh.mjs`);
}
out('settings/settings.generated.mts', settings);

// startupError.ts runs for real.
out('settings/startupError.generated.mts', readRepo('mods', 'ui', 'startupError.ts'));

// disableWhosWatching.ts, exported rather than self-invoking.
// Anchored at end of file on purpose. The same call also appears inside the
// config listener, and replacing that one instead puts an `export` in a
// function body -- which is exactly what happened once, silently, because the
// old runner did not check exit codes.
const whos = readRepo('mods', 'ui', 'disableWhosWatching.ts')
    .replace("from '../config.js'", "from './stub.mjs'")
    .replace(
        /disableWhosWatching\(configRead\('enableWhoIsWatchingMenu'\)\);\s*$/,
        'export default disableWhosWatching;\n',
    );
if (!/export default disableWhosWatching;\s*$/.test(whos)) {
    fail('disableWhosWatching.ts no longer ends with the expected self-call; fix test/refresh.mjs');
}
if (
    whos.includes('export default disableWhosWatching;\n\nconst') ||
    whos.split('export default').length > 2
) {
    fail('the disableWhosWatching substitution matched more than once; fix test/refresh.mjs');
}
out('whos-watching/mod.generated.mts', whos);

// customCommandExecution.ts has no imports, so it runs as-is.
out('command-executor/mod.generated.mts', readRepo('mods', 'ui', 'customCommandExecution.ts'));

// The patchYttvJson region of adblock.ts, on its own.
const adblock = readRepo('mods', 'features', 'adblock.ts');
const region = adblock.match(/^let jsonPatchAttempts[\s\S]*?^patchYttvJson\(\);$/m);
if (!region) fail('cannot find the patchYttvJson region in adblock.ts; fix test/refresh.mjs');
out(
    'adblock/block.generated.js',
    transpile(`declare const window: any;\n${region[0]}`, 'block.ts').replace(/^\n+/, ''),
);

// injector.ts, with its four imports repointed at the stub and the attach path
// exported. isConnecting is module-private and is exactly what the harness has
// to watch -- it is what the splash polls, and clearing it too early is what
// made the app exit out from under its own attach.
let injector = readRepo('standalone', 'service', 'injector.ts')
    .replace("import * as adbhost from 'adbhost';", "import { adbhost } from './stub.mjs';")
    .replace("import CDP from 'chrome-remote-interface';", "import CDP from './stub.mjs';")
    .replace("import nodeFetch from 'node-fetch';", "import { nodeFetch } from './stub.mjs';")
    .replace(
        "import * as userScript from './userScript.js';",
        "import { userScript } from './stub.mjs';",
    );
for (const gone of ['adbhost', 'chrome-remote-interface', 'node-fetch', './userScript.js']) {
    if (injector.includes(`'${gone}'`))
        fail(`injector.ts import of ${gone} no longer matches; fix test/refresh.mjs`);
}
if (!/^export \{ startDebugger, canConnectToDaemon \};$/m.test(injector)) {
    fail('injector.ts no longer ends with the expected export list; fix test/refresh.mjs');
}
injector = injector.replace(
    /^export \{ startDebugger, canConnectToDaemon \};$/m,
    'export { startDebugger, canConnectToDaemon, connectToDebugger };\nexport const readIsConnecting = () => isConnecting;',
);
out('injector/mod.generated.mts', injector);

// The proxy's userscript-injection block, lifted out of index.ts into a callable
// function. The harness used to carry its own copy of this logic and assert
// against that, so the regression it exists to catch -- the tag going to the end
// of the document, behind YouTube's own scripts -- passed clean.
const proxy = readRepo('standalone', 'service', 'index.ts');
const START = "if (req.url.indexOf('/tv') === 0 && req.url.indexOf('/tv_config') === -1) {";
const startAt = proxy.indexOf(START);
if (startAt < 0)
    fail('cannot find the /tv injection gate in standalone/service/index.ts; fix test/refresh.mjs');
if (proxy.indexOf(START, startAt + 1) !== -1)
    fail('the /tv injection gate matched more than once; fix test/refresh.mjs');
// Walk braces from the gate so the region is whatever the block actually is,
// rather than a slice that silently truncates when the code moves.
let depth = 0,
    endAt = -1;
for (let i = startAt; i < proxy.length; i++) {
    if (proxy[i] === '{') depth++;
    else if (proxy[i] === '}' && --depth === 0) {
        endAt = i + 1;
        break;
    }
}
if (endAt < 0) fail('could not brace-match the injection block; fix test/refresh.mjs');
const injectRegion = proxy.slice(startAt, endAt);
if (!injectRegion.includes('<head[^>]*>') || !injectRegion.includes('const tag =')) {
    fail('the injection block no longer contains the head match and the tag; fix test/refresh.mjs');
}
out(
    'injection/inject.generated.mjs',
    '// Generated from standalone/service/index.ts by test/refresh.mjs. Do not edit.\n' +
        'export function injectUserScript(text, req, PORT, USERSCRIPT_PATH) {\n' +
        injectRegion +
        '\n    return text;\n}\n',
);

// jsonPrune.ts has no imports, so it runs as-is.
out('json-prune/mod.generated.mts', readRepo('mods', 'features', 'jsonPrune.ts'));

// previewState.ts and tileFixes.ts likewise. Both are deliberately
// dependency-free so the harness runs the shipping code rather than a stub of
// it -- and the guard below is what keeps that true: the moment either grows an
// import, the copy stops being the real thing and the whole suite says so
// instead of quietly passing against a module that no longer resolves.
for (const [file, dir, landmarks] of [
    [
        'previewState.ts',
        'preview-indicator',
        [
            'export function reduce',
            'export function chipOrigin',
            'export function anchorUsable',
            'export function shouldAnchor',
            'MOVE_GRACE_MS',
            'WATCHDOG_SLACK_MS',
        ],
    ],
    [
        'tileFixes.ts',
        'tile-fixes',
        [
            'export function bestThumbnail',
            'export function previewableTile',
            'export function startInlinePlayback',
            'export function pageNameFromHash',
            'export function shelfIsEmpty',
            'export function hasMembersOnlyBadge',
        ],
    ],
    [
        'dearrowCache.ts',
        'tile-fixes',
        [
            'export function fetchBranding',
            'export function bestTitle',
            'export function bestThumbnailTime',
            'CACHE_LIMIT',
        ],
    ],
    [
        'guideReselect.ts',
        'guide-reselect',
        [
            'export function shouldArm',
            'export function decide',
            'export function isRefreshableRoute',
            'RESELECT_WINDOW_MS',
        ],
    ],
    [
        'captionPrefs.ts',
        'caption-prefs',
        [
            'export function preferenceFor',
            'export function commandFor',
            'export function shouldApply',
            'export function listHasChannel',
        ],
    ],
    [
        'aisListParse.ts',
        'aislist',
        [
            'export function parseList',
            'export function indexHasChannel',
            'export function normaliseHandle',
            'export function serialiseIndex',
        ],
    ],
    [
        'guideFilter.ts',
        'guide-filter',
        [
            'export function filterGuide',
            'export function shouldRemoveEntry',
            'export function isWatchLaterEntry',
            'WATCH_LATER_BROWSE_IDS',
        ],
    ],
    [
        'tileMenu.ts',
        'tile-menu',
        [
            'export function menuItems',
            'export function tileIdentity',
            'export function offeredRows',
            'export function isChannelHidden',
            'export function tileIsHidden',
            'RENDERABLE_SERVICE_ENDPOINTS',
        ],
    ],
]) {
    const source = readRepo('mods', 'features', file);
    for (const landmark of landmarks) {
        if (!source.includes(landmark))
            fail(`${file} no longer contains ${landmark}; fix test/refresh.mjs`);
    }
    if (/^\s*import\s/m.test(source)) {
        fail(
            `${file} gained an import; the harness runs it as-is. Keep it dependency-free or fix test/refresh.mjs.`,
        );
    }
    out(`${dir}/${file.replace(/\.ts$/, '')}.generated.mts`, source);
}

// focusMotion.ts reads config, so its one import is repointed at a stub -- the
// videoContext recipe below.
const focusMotion = readRepo('mods', 'features', 'focusMotion.ts').replace(
    "from '../config.js'",
    "from './stub.mjs'",
);
if (focusMotion.includes("'../config.js'"))
    fail('focusMotion.ts import of ../config.js no longer matches; fix test/refresh.mjs');
if (!focusMotion.includes('export function applyFocusMotion'))
    fail('focusMotion.ts no longer exports applyFocusMotion; fix test/refresh.mjs');
out('focus-motion/mod.generated.mts', focusMotion);

// The AD_RULES block, lifted out of adblock.ts so the harness exercises the
// rules the mod actually ships rather than a copy of them.
const adblockSrc = readRepo('mods', 'features', 'adblock.ts');
const rulesMatch = adblockSrc.match(/^const AD_RULES: PruneRule\[\] = \[[\s\S]*?^\];$/m);
if (!rulesMatch) fail('cannot find AD_RULES in adblock.ts; fix test/refresh.mjs');
out(
    'json-prune/rules.generated.mts',
    "import type { PruneRule } from './mod.generated.mts';\n" +
        rulesMatch[0].replace('const AD_RULES', 'export const AD_RULES') +
        '\n',
);

// aisList.ts's refresh path. Its two imports are repointed: config at a stub the
// harness drives, and aisListParse at the module the aislist harness already
// runs -- so the fetch/cache logic is exercised against the REAL parser rather
// than a fake index.
const aisList = readRepo('mods', 'features', 'aisList.ts')
    .replace("from '../config.js'", "from './stub.mjs'")
    .replace("from './aisListParse.js'", "from './aisListParse.generated.mts'");
for (const gone of ['../config.js', './aisListParse.js']) {
    if (aisList.includes(`'${gone}'`))
        fail(`aisList.ts import of ${gone} no longer matches; fix test/refresh.mjs`);
}
if (!aisList.includes('export async function refresh'))
    fail('aisList.ts no longer exports refresh; fix test/refresh.mjs');
out('aislist/mod.generated.mts', aisList);

// captionRuntime.ts and the videoContext it reads. Both are lifted so the
// harness drives the SHIPPING wiring: the predicates in captionPrefs.ts already
// have a harness, and it passed the whole time the runtime was resolving them
// against the wrong channel.
const captionRuntime = readRepo('mods', 'features', 'captionRuntime.ts')
    .replace("from '../config.js'", "from './stub.mjs'")
    .replace("from '../resolveCommand.js'", "from './stub.mjs'")
    .replace("from './videoContext.js'", "from './videoContext.generated.mts'")
    .replace("from './captionPrefs.js'", "from './captionPrefs.generated.mts'");
for (const gone of [
    '../config.js',
    '../resolveCommand.js',
    './videoContext.js',
    './captionPrefs.js',
]) {
    if (captionRuntime.includes(`'${gone}'`))
        fail(`captionRuntime.ts import of ${gone} no longer matches; fix test/refresh.mjs`);
}
out('caption-prefs/runtime.generated.mts', captionRuntime);
out(
    'caption-prefs/videoContext.generated.mts',
    readRepo('mods', 'features', 'videoContext.ts').replace(
        "from '../config.js'",
        "from './stub.mjs'",
    ),
);

// aisListRefresh.ts, whose whole job is deciding WHEN to fetch. Its aisList
// import is stubbed with a counter: what is under test is that the toggle calls
// refresh at all, which is what it did not do.
const aisRefresh = readRepo('mods', 'features', 'aisListRefresh.ts')
    .replace("from '../config.js'", "from './toggleStub.mjs'")
    .replace("from './aisList.js'", "from './toggleStub.mjs'");
for (const gone of ['../config.js', './aisList.js']) {
    if (aisRefresh.includes(`'${gone}'`))
        fail(`aisListRefresh.ts import of ${gone} no longer matches; fix test/refresh.mjs`);
}
out('aislist/refreshGate.generated.mts', aisRefresh);

// videoContext.ts, which decides whether SponsorBlock is off for a channel.
out(
    'sponsorblock-channels/mod.generated.mts',
    readRepo('mods', 'features', 'videoContext.ts').replace(
        "from '../config.js'",
        "from './stub.mjs'",
    ),
);

// styleSheet.ts, spliced into the CSP test page.
const sheet = transpile(readRepo('mods', 'ui', 'styleSheet.ts'), 'styleSheet.ts').replace(
    /export function /g,
    'function ',
);
const template = readFileSync(join(testRoot, 'stylesheet/page.template.html'), 'utf8');
const MARKER = '/* __STYLESHEET__ */';
if (!template.includes(MARKER))
    fail(`stylesheet/page.template.html is missing its ${MARKER} marker`);
// A function replacement, so a '$&' or '$`' inside the transpiled source
// cannot be read as a replacement pattern -- the same trap styleSheet.ts
// itself documents on its own fallback path.
out(
    'stylesheet/page.html',
    template.replace(MARKER, () => sheet.trimEnd()),
);

console.log('All snapshots current.');
