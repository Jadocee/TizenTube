// That the running build can say which version it is.
//
// It could not, and that cost a day. The version row in the settings panel was
// gated on `window.h5vcc && window.h5vcc.tizentube` -- the Cobalt/Android TV
// bridge, absent on Tizen -- so on a television nothing anywhere in the UI named
// the build. When three merged pull requests appeared to change nothing on the
// set, the only way to establish what was actually running was to unpack the
// published npm tarball and diff it against the repository. The answer turned
// out to be TizenBrew's own service caching the module script in a Map it never
// invalidates, but that is not the point: the point is that the question took a
// tarball diff to ask.
//
// THIS HARNESS READS THE BUILT BUNDLE, NOT THE SOURCE, and that is the whole
// design. The version reaches the bundle through rolldown's `define`, and
// `define` belongs inside `transform` -- written beside it, at the top level of
// the config, it is accepted without complaint and does nothing at all. The
// first version of this feature shipped exactly that way: the config looked
// right, the typecheck passed, the settings panel compiled, and the bundle
// carried the literal text `__TT_VERSION__` where the number should have been.
// No assertion on the source could have caught it. This one did.
import { readRepo, repoPath, checker, skip } from '../lib/repo.mjs';
import { existsSync, readdirSync } from 'node:fs';

const BUNDLE = ['dist', 'userScript.js'];
if (!existsSync(repoPath(...BUNDLE))) {
    skip('dist/userScript.js is not built. Run "pnpm build" in mods/ first.');
}

const { check, done } = checker();

const pkg = JSON.parse(readRepo('package.json'));
const bundle = readRepo(...BUNDLE);

// --- the version exists and is the one TizenBrew will see -------------------
// The ROOT package.json, deliberately: that is the npm package TizenBrew
// installs and the number it reads out of jsDelivr, so it is the one a user can
// compare against the registry. mods/package.json is a workspace member nobody
// publishes.
check('the root package has a version', typeof pkg.version, 'string');
check('  ...that looks like one', /^\d+\.\d+\.\d+/.test(pkg.version || ''), true);
check('  ...and names the package TizenBrew installs', pkg.name, '@jadocee/tizentube-9');

// --- the substitution actually happened -------------------------------------
// The two halves of the same fact, because either alone passes for the wrong
// reason: the version string could appear in the bundle for some unrelated
// reason, and the placeholder could be absent because the feature was deleted.
check(
    'the built bundle carries the real version',
    bundle.includes(`\`${pkg.version}\``) ||
        bundle.includes(`"${pkg.version}"`) ||
        bundle.includes(`'${pkg.version}'`),
    true,
);
check('  ...and no unsubstituted placeholder survives', bundle.includes('__TT_VERSION__'), false);
// It is interpolated into the header string rather than merely present.
check('  ...through the header string', bundle.includes('madeByVersion'), true);

// --- the config shape that made the placeholder survive ---------------------
// `define` has to be INSIDE `transform`. Asserted by brace-matching rather than
// by looking for the word, because the broken version contained the word too --
// in the right file, with the right value, one level too high.
const config = readRepo('mods', 'rolldown.config.js');
const code = config.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const transformAt = code.indexOf('transform:');
check('the build config has a transform block', transformAt >= 0, true);

let transformBody = '';
if (transformAt >= 0) {
    const open = code.indexOf('{', transformAt);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') {
            depth--;
            if (depth === 0) {
                transformBody = code.slice(open, i + 1);
                break;
            }
        }
    }
}
check('  ...with a closing brace', transformBody.length > 0, true);
check('  ...and define is inside it', transformBody.includes('__TT_VERSION__'), true);
// The failure mode named above: exactly one `define:` in the file, and it is the
// one inside transform. A second at the top level is the bug.
const defines = (code.match(/^\s*define\s*:/gm) || []).length;
check('  ...and there is no second define elsewhere', defines, 1);
check(
    '  ...reading the ROOT package.json, not mods/',
    /readFileSync\(\s*new URL\(\s*'\.\.\/package\.json'/.test(code),
    true,
);

// --- the panel shows it ------------------------------------------------------
const settings = readRepo('mods', 'ui', 'settings.ts');
const settingsCode = settings
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
check('the settings panel reads the version', settingsCode.includes('__TT_VERSION__'), true);
// In the TOP-LEVEL header, not behind a submenu: the question is "what is
// running", and it must not cost a navigation to answer. The old version row
// was inside the updater submenu AND gated on Cobalt, which is how it came to
// be invisible on every television.
//
// Anchored on the panel's own id rather than on its title string. The title is
// reused as a SUBTITLE by four submenus, so an indexOf for it lands on the
// first of those and measures a distance to nothing -- which is how the first
// draft of this check failed against correct code.
const panelAt = settingsCode.indexOf("'tt-settings'");
const openAt = panelAt >= 0 ? settingsCode.lastIndexOf('showModal(', panelAt) : -1;
const panelCall = openAt >= 0 ? settingsCode.slice(openAt, panelAt) : '';
check('the top-level panel is rendered by showModal', panelCall.length > 0, true);
check('  ...and its header carries the version', panelCall.includes('__TT_VERSION__'), true);
// NOT behind the Cobalt bridge, which is the mistake being undone: the previous
// version display was real, correct, and invisible on every Tizen set.
check('  ...unconditionally, not gated on Cobalt', panelCall.includes('h5vcc'), false);
check('  ...alongside the attribution, not replacing it', panelCall.includes('madeBy'), true);

// --- every locale carries the string ----------------------------------------
// Interpolated in both halves so no translation can drop the number: a locale
// that hardcoded "v" around {{version}} would still show it, but one that
// translated the whole sentence and lost the placeholder would not.
const dir = repoPath('mods', 'translations', 'resources');
let withMadeBy = 0;
const missing = [];
const malformed = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const tt = JSON.parse(readRepo('mods', 'translations', 'resources', file))?.settings
        ?.ttSettings;
    if (!tt || typeof tt.madeByText !== 'string') continue;
    withMadeBy++;
    if (typeof tt.madeByVersion !== 'string') {
        missing.push(file);
        continue;
    }
    if (!tt.madeByVersion.includes('{{version}}') || !tt.madeByVersion.includes('{{madeBy}}')) {
        malformed.push(file);
    }
}
check('there are locales to check', withMadeBy > 1, true);
check('  ...every one has the version string', missing, []);
check('  ...and every one keeps both placeholders', malformed, []);

done();
