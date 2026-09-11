// The config bootstrap: what happens when the stored blob is not a config.
//
// JSON.parse SUCCEEDING IS NOT THE SAME AS IT RETURNING AN OBJECT. `null`, a
// number, a string, `true` and an array all parse without throwing, and the old
// bootstrap handed each of them straight to configRead as `localConfig`. FOUR of
// those five then threw on the FIRST READ -- reading a key off null, or
// assigning the repaired default onto a number, a string or a boolean, which is
// a TypeError because the bundle is an ES module and therefore strict.
//
// That is why this harness reads through a try/catch and reports the throw as a
// failure rather than letting it kill the process: configRead runs at MODULE
// SCOPE in several files (clock.ts ends with toggleClock(configRead('enableClock'))),
// so one of those throws aborts every module imported after it and the whole mod
// is gone -- plain YouTube, no ad blocking, no way to tell why. It is the same
// failure test/whos-watching exists for.
//
// The array is the quiet one: it parses, it indexes, every read returns a
// repaired default, and then configWrite stringifies it back as `[]` with the
// settings dropped on the floor. That is what the persistence check below is
// for -- settings that appear to save and are gone on the next launch.
import { checker, readRepo } from '../lib/repo.mjs';

const { check, done } = checker();

// config.ts narrates every repair and every write. Captured rather than printed:
// the fallback warning is itself an assertion below, and 79 settings x 9 blobs of
// "Populating key ..." would bury the results.
const warnings = [];
console.warn = (...a) => warnings.push(a.map((x) => String(x)).join(' '));
console.info = () => {};

const CONFIG_KEY = 'ytaf-configuration';
const HERE = new URL('.', import.meta.url).href;

// Every setting name, read out of the source rather than off the module's own
// object -- so "no key reads undefined" is measured against the declaration and
// cannot be satisfied by the bootstrap losing keys.
const body = readRepo('mods', 'config.ts').match(/const defaultConfig = \{([\s\S]*?)\n\};/)[1];
const KEYS = [...body.matchAll(/^ {4}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);

/**
 * A fresh module instance over a given stored blob. ESM caches by specifier, and
 * the bootstrap runs exactly once per instance, so each case needs its own
 * query string.
 */
let seq = 0;
async function boot(raw) {
    const store = {};
    if (raw !== undefined) store[CONFIG_KEY] = raw;
    globalThis.window = { localStorage: store };

    warnings.length = 0;
    const mod = await import(`${HERE}mod.generated.mts?case=${++seq}`);
    return { mod, store, bootWarnings: warnings.slice() };
}

/** Calls fn, reporting a throw as the string the check will fail on. */
function attempt(fn) {
    try {
        return { value: fn(), threw: null };
    } catch (e) {
        return { value: null, threw: `${e.constructor.name}: ${e.message}` };
    }
}

// --- blobs that parse but are not a config ----------------------------------
// Each is a value localStorage really can hold: a half-written key, a stray
// migration, a different mod writing the same name, a truncated flush.
const unusable = {
    'key absent (fresh install)': undefined,
    'empty string': '',
    'the string "null"': 'null',
    'a number': '42',
    'a JSON string': '"hello"',
    'the boolean true': 'true',
    'an empty array': '[]',
    'a populated array': '[1,2,3]',
    'truncated JSON': '{"enableAdBlock":tr',
};

for (const [label, raw] of Object.entries(unusable)) {
    const { mod, store, bootWarnings } = await boot(raw);

    // The first read is the one that used to throw.
    const first = attempt(() => mod.configRead('enableAdBlock'));
    check(`${label}: first read does not throw`, first.threw, null);
    check(`${label}:   ...and returns the default`, first.value, true);

    if (!first.threw) {
        const undefinedKeys = KEYS.filter((k) => mod.configRead(k) === undefined);
        check(`${label}:   ...no setting reads undefined`, undefinedKeys, []);
        check(
            `${label}:   ...an array default survives`,
            mod.configRead('sponsorBlockManualSkips'),
            ['intro', 'outro', 'filler'],
        );

        // A write has to persist a whole config. Against a stored array the old
        // bootstrap serialized `[]` -- JSON.stringify drops string properties
        // from an array -- so the setting was gone by the next launch.
        const wrote = attempt(() => mod.configWrite('clockPosition', 'bottom-left'));
        check(`${label}:   ...a write does not throw`, wrote.threw, null);
        const persisted = attempt(() => JSON.parse(store[CONFIG_KEY]));
        check(
            `${label}:   ...persists an object`,
            {
                object: !!persisted.value && typeof persisted.value === 'object',
                array: Array.isArray(persisted.value),
            },
            { object: true, array: false },
        );
        check(
            `${label}:   ...persists the written value`,
            persisted.value && persisted.value.clockPosition,
            'bottom-left',
        );
        check(
            `${label}:   ...and the settings beside it`,
            persisted.value && KEYS.filter((k) => !Object.hasOwn(persisted.value, k)),
            [],
        );
    }

    // A silent fallback is the wrong kind of quiet: the console is the only
    // diagnostic anyone has on a television.
    check(`${label}:   ...says so on the console`, bootWarnings.length > 0, true);
}

// --- a real stored config is still honoured ---------------------------------
// The fallback must be the exception. If it fired on a valid object every
// setting would reset on every launch, which is a worse bug than the one above.
{
    const stored = { enableAdBlock: false, clockPosition: 'bottom-left', videoSpeed: 1.5 };
    const { mod, bootWarnings } = await boot(JSON.stringify(stored));
    check('valid config: stored value wins', mod.configRead('enableAdBlock'), false);
    check('valid config:   ...for a string', mod.configRead('clockPosition'), 'bottom-left');
    check('valid config:   ...for a number', mod.configRead('videoSpeed'), 1.5);
    check('valid config:   ...missing key repairs', mod.configRead('enableSponsorBlock'), true);
    check(
        'valid config:   ...no fallback warning',
        bootWarnings.join('|').includes('not an object'),
        false,
    );
}

// --- a stored null for one key ----------------------------------------------
// launchToOnStartup defaulted to null before it became ''; repairing only
// `undefined` handed that back typed as a non-nullable string forever.
{
    const { mod } = await boot(JSON.stringify({ launchToOnStartup: null }));
    check('a null setting repairs to its default', mod.configRead('launchToOnStartup'), '');
}

// --- the defaults must not be reachable from what configRead returns --------
// resolveCommand.ts's `arrayValue` branch backs every multi-select row in the
// settings panel and does, verbatim:
//
//     const arr = configRead(item);
//     if (arr.includes(value)) arr.splice(arr.indexOf(value), 1);
//     else arr.push(value);
//     configWrite(item, arr);
//
// -- an in-place edit of the array configRead just handed out. Under a shallow
// `{...defaultConfig}` that array IS defaultConfig's own, so unticking one
// SponsorBlock category rewrote the module's declared default. Eight settings
// reach that branch.
//
// THE configWrite(key, null) BELOW IS CONTRIVED AND IS SAID SO PLAINLY. The
// pollution has no other observable: defaultConfig is not exported, a second
// module instance has its own copy of it, and within one instance a key is
// repaired only once -- so asking for that default a SECOND time is the only
// way to see whether the first caller damaged it. Nulling the key is how you
// ask. That makes this a structural assertion, not a user-facing one, and the
// structure is what matters: the invariant is closed by construction here, and
// the previous attempt to close it by auditing the callers got the audit wrong.
//
// Both paths that can hand out a default are covered, because they are separate
// code: readStoredConfig's fallback, and configRead's repair for a key a stored
// config lacks -- which is every array setting ever added by an upgrade.
{
    // The repair path: a stored config that predates the setting.
    const { mod } = await boot(JSON.stringify({ enableAdBlock: true }));
    const repaired = mod.configRead('hiddenChannels');
    check('the repair path hands out the empty default', repaired, []);
    repaired.push('UCabc Polluted'); // what the settings panel does to it
    mod.configWrite('hiddenChannels', null);
    check('  ...and an in-place edit of it does not stick', mod.configRead('hiddenChannels'), []);
}
{
    // The fallback path: nothing stored at all.
    const { mod } = await boot(undefined);
    const skips = mod.configRead('sponsorBlockManualSkips');
    check('the fallback hands out the real default', skips, ['intro', 'outro', 'filler']);
    skips.splice(skips.indexOf('intro'), 1); // unticking "Intro"
    mod.configWrite('sponsorBlockManualSkips', null);
    check('  ...and that edit does not stick either', mod.configRead('sponsorBlockManualSkips'), [
        'intro',
        'outro',
        'filler',
    ]);
}

// --- the key list the assertions above are measured against -----------------
// If this regex ever stopped matching, "no setting reads undefined" would pass
// over an empty list and mean nothing.
check(
    'the source yields a plausible key list',
    KEYS.length > 60 && KEYS.includes('enableClock'),
    true,
);

done(`ALL PASS (${KEYS.length} settings)`);
