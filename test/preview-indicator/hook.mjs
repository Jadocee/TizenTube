// The wrapper around YouTube's PlaybackPreviewService, against a service shaped
// like the real one.
//
// THE BUG THIS EXISTS FOR SHIPPED AND NOTHING NOTICED. The wrapper hooked
// `service.stop` for its entire life, and the shipped service has no stop: its
// prototype carries start, end, isActive, pause, reset, select and
// togglePlaying. Assigning `service.stop = wrapper` therefore CREATED a property
// nothing would ever call, so the code looked hooked, reported itself hooked,
// and onPreviewStop never fired once. Everything downstream then had to survive
// on watchdogs alone, and every consecutive preview arrived as a start with no
// intervening stop -- the case the indicator's dispatcher handled worst.
//
// The shape of the fake service below is the point: `end` and no `stop`, taken
// from the real prototype. A fixture invented to suit the code would have had a
// stop, and this harness would have passed against the broken version.
import { checker } from '../lib/repo.mjs';

// --- browser globals the module reads at import ------------------------------
let registry = null;
globalThis.window = {
    addEventListener: () => {},
    get _yttv() {
        return registry;
    },
};
// 'complete' so install() runs at import rather than waiting on a load event
// this harness would have to synthesise. The deferred path is the same function.
globalThis.document = { readyState: 'complete' };

const pending = [];
globalThis.setTimeout = (fn) => {
    pending.push(fn);
    return pending.length;
};
/** Run whatever install() scheduled, up to `n` rounds. */
const drain = (n = 1) => {
    for (let i = 0; i < n; i++) {
        const next = pending.shift();
        if (!next) return;
        next();
    }
};

const hook = await import('./hook.generated.mts');
const { check, done } = checker();

/** The real prototype's method names, from the shipped bundle. NOTE: no stop. */
const REAL_METHODS = ['start', 'end', 'isActive', 'pause', 'reset', 'select', 'togglePlaying'];

function makeService() {
    const calls = [];
    const service = {};
    for (const name of REAL_METHODS) {
        service[name] = (...args) => {
            calls.push({ name, args });
            return `${name}-result`;
        };
    }
    return { service, calls };
}

const starts = [];
const stops = [];
hook.onPreviewStart(() => starts.push(1));
hook.onPreviewStop(() => stops.push(1));

// --- the service appears late, as it does on a television -------------------
check('nothing is hooked before the registry exists', hook.previewHookStatus(), 'pending');
drain(2);
check('  ...and it keeps retrying rather than giving up', hook.previewHookStatus(), 'pending');

const { service, calls } = makeService();
registry = {
    // The shape install() actually looks for: it finds an entry that HAS a
    // `mappings` property and then calls `.get` on THAT ENTRY, not on the
    // mappings object. Getting it wrong is invisible -- the module just keeps
    // retrying -- so the fixture is written from the code, not from the name.
    anything: {
        mappings: true,
        get: (name) => (name === 'PlaybackPreviewService' ? service : null),
    },
};
drain();
check('it hooks once the service is registered', hook.previewHookStatus(), 'hooked');

// --- the teardown ------------------------------------------------------------
// The whole point. `end` is what the app calls; `stop` does not exist.
check('a teardown was found to wrap', hook.previewStopHooked(), true);
check('  ...and it is not stop', typeof service.stop, 'undefined');
check('  ...wrapping did not invent one', REAL_METHODS.includes('stop'), false);

service.start({ some: 'command' });
check('start is forwarded', calls[0].name, 'start');
check('  ...and notifies', starts.length, 1);

service.end({ oM: true });
check('end is forwarded', calls[1].name, 'end');
check('  ...and notifies the stop listeners', stops.length, 1);
check('  ...preserving the return value', service.end({}), 'end-result');

// The other methods are left alone: wrapping more than the two that matter would
// put this module in the path of every preview interaction.
const untouched = ['isActive', 'pause', 'reset', 'select', 'togglePlaying'];
const before = calls.length;
for (const name of untouched) service[name]();
check('every other method still works', calls.length - before, untouched.length);

// --- vetoes ------------------------------------------------------------------
let veto = false;
hook.addPreviewVeto(() => veto);
veto = true;
const count = calls.length;
const startsBefore = starts.length;
service.start({});
check('a veto suppresses start', calls.length, count);
check('  ...and its listeners', starts.length, startsBefore);
const stopsBefore = stops.length;
service.end({});
check('a veto suppresses the teardown too', stops.length, stopsBefore);
veto = false;

// A veto that throws must not be able to suppress playback -- that is the one
// direction this feature must never fail in.
hook.addPreviewVeto(() => {
    throw new Error('broken veto');
});
const startsBeforeThrow = starts.length;
service.start({});
check('a throwing veto does not suppress playback', starts.length, startsBeforeThrow + 1);

// A listener that throws runs inside YouTube's own call stack.
hook.onPreviewStart(() => {
    throw new Error('broken listener');
});
let threw = null;
try {
    service.start({});
} catch (e) {
    threw = e.message;
}
check('a throwing listener cannot break the preview', threw, null);

done();
