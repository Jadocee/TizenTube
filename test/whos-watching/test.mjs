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
// Any throw here is a regression: this runs at module scope in the bundle, so
// one of them aborts every module imported after it.
process.exit(throws ? 1 : 0);
