import * as stub from './stub.mjs';
import disableWhosWatching from './mod.generated.mts';

const NOW = Date.now();
const full = () => ({
    data: {
        data: {
            'startup-screen-account-selector-with-guest': { lastFired: NOW - 60_000 },
            whos_watching_fullscreen_zero_accounts: { lastFired: NOW - 60_000 },
            'startup-screen-signed-out-welcome-back': { lastFired: NOW - 60_000 },
        },
    },
});

// Real-world shapes the stored blob can take. YouTube only records an action
// once it has fired, so a profile that has never seen a given startup screen
// simply has no entry for it.
const shapes = {
    'key absent entirely (fresh profile)': undefined,
    'empty string': '',
    'all three actions present': JSON.stringify(full()),
    'no whos_watching_fullscreen_zero_accounts': (() => {
        const o = full();
        delete o.data.data.whos_watching_fullscreen_zero_accounts;
        return JSON.stringify(o);
    })(),
    'no account-selector entry': (() => {
        const o = full();
        delete o.data.data['startup-screen-account-selector-with-guest'];
        return JSON.stringify(o);
    })(),
    'empty data.data': JSON.stringify({ data: { data: {} } }),
    'no data wrapper': JSON.stringify({}),
};

let throws = 0;
for (const [label, raw] of Object.entries(shapes)) {
    for (const enabled of [false, true]) {
        for (const perma of [false, true]) {
            if (!enabled && perma) continue;
            globalThis.localStorage = {};
            if (raw !== undefined)
                globalThis.localStorage['yt.leanback.default::recurring_actions'] = raw;
            stub.store.permanentlyEnableWhoIsWatchingMenu = perma;
            const mode = enabled ? (perma ? 'enabled+permanent' : 'enabled') : 'disabled';
            try {
                disableWhosWatching(enabled);
                console.log(`  ok    ${label.padEnd(38)} ${mode}`);
            } catch (e) {
                throws++;
                console.log(
                    `  THROW ${label.padEnd(38)} ${mode}  -> ${e.constructor.name}: ${e.message.slice(0, 60)}`,
                );
            }
        }
    }
}
console.log(`\n${throws} of the cases above throw. This function is called at module scope in the`);
console.log(`bundle, so each of those aborts every module imported after it.`);

// --- and what it actually writes --------------------------------------------
// Not throwing is half of it. The other half is the DIRECTION of the timestamp,
// which was wrong: the enabled-but-not-permanent path stamped lastFired with the
// current time. The app reads that field as `now - lastFired` and suppresses the
// screen while the result is inside its cooldown, so "show the who's watching
// menu" was the thing preventing it, and only the permanent path -- which
// backdates by seven days -- made the screen appear. Nothing here could see it,
// because everything here asked "did it throw".
let wrong = 0;
const DAY = 24 * 60 * 60 * 1000;
// Older than the two-hour guard, or the guard returns before writing anything --
// which is what the first draft of this did, reporting the fix as absent.
function stale() {
    const o = full();
    for (const k of Object.keys(o.data.data))
        o.data.data[k].lastFired = Date.now() - 3 * 60 * 60 * 1000;
    return o;
}

function writes(label, { enabled, perma }, expect) {
    globalThis.localStorage = {};
    globalThis.localStorage['yt.leanback.default::recurring_actions'] = JSON.stringify(stale());
    stub.store.permanentlyEnableWhoIsWatchingMenu = perma;
    disableWhosWatching(enabled);
    const after = JSON.parse(globalThis.localStorage['yt.leanback.default::recurring_actions']);
    const written = after.data.data['startup-screen-account-selector-with-guest'].lastFired;
    const ok = expect(written - Date.now());
    if (!ok) wrong++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${label.padEnd(52)} lastFired ${Math.round((written - Date.now()) / DAY)}d from now`,
    );
}

// Enabled: the screen has to be eligible, so the stamp must be far enough in the
// PAST to clear the app's cooldown (120 minutes for a signed-in device).
writes(
    'enabled backdates so the screen is eligible',
    { enabled: true, perma: false },
    (delta) => delta < -2 * 60 * 60 * 1000,
);
writes(
    '  ...and so does enabled+permanent',
    { enabled: true, perma: true },
    (delta) => delta < -2 * 60 * 60 * 1000,
);
// Disabled: the stamp must be in the FUTURE, which is how the mod suppresses it.
writes(
    'disabled postdates so the screen is suppressed',
    { enabled: false, perma: false },
    (delta) => delta > 0,
);

// The two-hour guard: a screen shown minutes ago must be left alone, so YouTube
// suppresses it exactly as it would without the mod.
globalThis.localStorage = {};
const recent = full();
recent.data.data['startup-screen-account-selector-with-guest'].lastFired = Date.now() - 60_000;
globalThis.localStorage['yt.leanback.default::recurring_actions'] = JSON.stringify(recent);
stub.store.permanentlyEnableWhoIsWatchingMenu = false;
disableWhosWatching(true);
const untouched = JSON.parse(globalThis.localStorage['yt.leanback.default::recurring_actions']).data
    .data['startup-screen-account-selector-with-guest'].lastFired;
const guardHeld = Math.abs(untouched - (Date.now() - 60_000)) < 5_000;
if (!guardHeld) wrong++;
console.log(`${guardHeld ? '  ok  ' : 'FAIL  '}a screen shown a minute ago is left alone`);

// Any throw here is a regression: this runs at module scope in the bundle, so
// one of them aborts every module imported after it.
process.exit(throws || wrong ? 1 : 0);
