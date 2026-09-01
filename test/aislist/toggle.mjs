// When the AiSList fetch is kicked off.
//
// The gate used to be a bare top-level `if (configRead('enableAiSList'))`,
// evaluated once at import. The setting ships OFF, so on a fresh install it was
// false, no timer was ever scheduled, and nothing else in the tree called
// refresh(): ticking the box left the row reading ON and the feature hiding
// nothing until the television app was killed and relaunched. There is no
// console on the device, so it looked exactly like a setting that did not work.
//
// What is under test is the module's SIDE EFFECTS, which is the whole of it --
// there is no return value to assert on, and that is precisely why nothing
// covered it.
import { checker } from '../lib/repo.mjs';
import { store, calls, configWrite } from './toggleStub.mjs';

// A controllable clock, installed before the import: the module schedules its
// first fetch 15s out so the download never competes with the home screen.
let clock = 0, seq = 0;
const pending = new Map();
globalThis.setTimeout = (fn, ms) => { const id = ++seq; pending.set(id, { at: clock + (ms || 0), fn }); return id; };
globalThis.clearTimeout = (id) => pending.delete(id);
function tick(ms) {
    const until = clock + ms;
    for (;;) {
        let next = null;
        for (const [id, t] of pending) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        pending.delete(next[0]); clock = next[1].at; next[1].fn();
    }
    clock = until;
}

// Off at import, which is how it ships.
store.enableAiSList = false;
await import('./refreshGate.generated.mts');

const { check, done } = checker();
const reset = () => { calls.length = 0; };

// --- the fresh install --------------------------------------------------------
tick(30000);
check('a disabled feature schedules nothing', calls.length, 0);

// --- the toggle ----------------------------------------------------------------
reset();
configWrite('enableAiSList', true);
check('turning it on fetches immediately', calls.length, 1);
// Forced: the user just asked for this, so the 12-hour TTL is not the answer to
// "should I fetch now".
check('  ...and forces past the TTL', calls[0], true);

// Turning it off must not fetch.
reset();
configWrite('enableAiSList', false);
check('turning it off fetches nothing', calls.length, 0);

// --- the warnlist ---------------------------------------------------------------
reset();
store.enableAiSList = true;
configWrite('aisListIncludeWarnlist', true);
check('turning the warnlist on fetches', calls.length, 1);
// NOT forced: refresh() decides per source now, so an unfetched warnlist is
// stale on its own terms and the blocklist is left alone.
check('  ...without forcing the blocklist too', calls[0], false);

reset();
store.enableAiSList = false;
configWrite('aisListIncludeWarnlist', true);
check('the warnlist alone does nothing while the feature is off', calls.length, 0);

// --- unrelated settings -----------------------------------------------------------
reset();
for (const key of ['enableAdBlock', 'hideMembersOnlyVideos', 'captionsDefault', 'videoSpeed']) {
    configWrite(key, true);
}
check('no other setting triggers a fetch', calls.length, 0);

// --- the deferred first fetch -------------------------------------------------------
// Proved by a second import in a fresh module registry: the gate runs at import,
// so this is the only way to see the enabled-at-launch path.
reset();
store.enableAiSList = true;
await import('./refreshGate.generated.mts?enabled');
check('an enabled feature does not fetch during startup', calls.length, 0);
tick(14000);
check('  ...still not at 14s', calls.length, 0);
tick(2000);
check('  ...and does at 15s', calls.length, 1);
check('  ...unforced, so the cache TTL still applies', calls[0], false);

done();
