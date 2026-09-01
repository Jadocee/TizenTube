// The preview indicator's DOM shell, driven with a fake clock and a fake DOM.
//
// THIS FILE EXISTS BECAUSE OF WHERE THE BUGS WERE. previewState.ts had a harness
// from the day it was written and its reducer was correct; every defect an
// adversarial review found was in the dispatcher AROUND it -- what gets reset on
// a restart, which timer is re-armed, what disable() actually tears down. None
// of that is visible from a pure function's return value, so none of it was
// covered, and the pure-function harness went on passing while the mark was
// stranded on screen.
//
// The specific trap it now pins: the app's teardown is `end`, not `stop`, and
// playbackPreview wrapped a method the shipped service does not have. So
// onPreviewStop never fired, every consecutive preview arrived as
// start-on-top-of-start, and that path reset nothing and re-armed nothing.
import { checker } from '../lib/repo.mjs';
import { store, startListeners, stopListeners, configWrite } from './stub.mjs';

// --- a fake clock, installed before the module is imported ------------------
let clock = 0;
let seq = 0;
const timers = new Map();
globalThis.setTimeout = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: clock + (ms || 0), fn });
    return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.Date = class extends Date {
    static now() {
        return clock;
    }
};
/** Advance the clock, running whatever comes due, in time order. */
function tick(ms) {
    const until = clock + ms;
    for (;;) {
        let next = null;
        for (const [id, t] of timers)
            if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        clock = next[1].at;
        next[1].fn();
    }
    clock = until;
}
const liveTimers = () => timers.size;

// --- a fake DOM, only as much as the module touches -------------------------
const docListeners = new Map();
const winListeners = new Map();
const makeEl = () => {
    const el = {
        // `id` and `className` are PROPERTIES, not attributes -- the module
        // assigns them directly, and a fake implementing only setAttribute would
        // leave every element anonymous and every lookup below matching whatever
        // happened to be first.
        id: '',
        className: '',
        parent: null,
        attrs: new Map(),
        children: [],
        style: {
            props: new Map(),
            setProperty(k, v) {
                this.props.set(k, v);
            },
        },
        isConnected: false,
        setAttribute(k, v) {
            this.attrs.set(k, String(v));
        },
        removeAttribute(k) {
            this.attrs.delete(k);
        },
        getAttribute(k) {
            return this.attrs.has(k) ? this.attrs.get(k) : null;
        },
        appendChild(c) {
            this.children.push(c);
            c.parent = this;
            c.isConnected = true;
            return c;
        },
        // Actually detaches. Leaving it in the parent's list meant a stale
        // element from before a disable() kept answering lookups, so the harness
        // reported the OLD mark's state as the current one.
        remove() {
            this.isConnected = false;
            removed++;
            if (this.parent) {
                const at = this.parent.children.indexOf(this);
                if (at >= 0) this.parent.children.splice(at, 1);
                this.parent = null;
            }
        },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }),
    };
    return el;
};
let removed = 0;
let created = 0;
const body = makeEl();
globalThis.document = {
    body,
    activeElement: null,
    createElement: () => {
        created++;
        return makeEl();
    },
    addEventListener: (t, fn, capture) => {
        const key = `${t}:${capture ? 'c' : 'b'}`;
        if (!docListeners.has(key)) docListeners.set(key, new Set());
        docListeners.get(key).add(fn);
    },
    removeEventListener: (t, fn, capture) => {
        const key = `${t}:${capture ? 'c' : 'b'}`;
        docListeners.get(key)?.delete(fn);
    },
};
globalThis.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener: (t, fn) => {
        if (!winListeners.has(t)) winListeners.set(t, new Set());
        winListeners.get(t).add(fn);
    },
    removeEventListener: (t, fn) => winListeners.get(t)?.delete(fn),
};

await import('./runtime.generated.mts');

const { check, done } = checker();

const startPreview = () => startListeners.forEach((fn) => fn());
const stopPreview = () => stopListeners.forEach((fn) => fn());
/** The media element the module learns from the event, and the events it reads. */
const player = { muted: false, volume: 1, webkitAudioDecodedByteCount: 0 };
const fireMedia = (type) => {
    for (const fn of docListeners.get(`${type}:c`) || []) fn({ type, target: player });
};
const mark = () => body.children.find((c) => c.id === 'tizentube-preview-indicator') || null;
const stateOf = () => mark()?.getAttribute('data-state') ?? null;
const soundOf = () => mark()?.getAttribute('data-sound') ?? null;

// --- the ordinary lifecycle -------------------------------------------------
startPreview();
check('a start draws the loading mark', stateOf(), 'loading');
check('  ...and arms exactly one timer', liveTimers(), 1);

tick(500);
fireMedia('playing');
check('the first frame switches to playing', stateOf(), 'playing');
// Two timers here, and both are wanted: the watchdog and the one-shot audio
// settle re-check. Recorded rather than hard-coded, so the re-enable check at
// the end compares against what a first enable actually does instead of a
// number picked by hand -- which is how that assertion was wrong the first time.
const timersWhilePlaying = liveTimers();
check('  ...and no speaker until the audio is known', soundOf(), null);

player.webkitAudioDecodedByteCount = 8192;
fireMedia('volumechange');
check('decoded audio draws the speaker', soundOf(), 'on');

// --- THE RESTART, which is the normal case, not the edge case ---------------
// No stop is fired at all here, exactly as on the device.
const beforeRestart = liveTimers();
startPreview();
check('a preview starting over another goes back to loading', stateOf(), 'loading');
// This is the bug the review found: the previous preview's speaker was drawn
// over the new one's spinner, because the reset was keyed to "was idle".
check('  ...and drops the previous speaker', soundOf(), null);
check('  ...and still has exactly one timer', liveTimers(), 1);
check('  ...not the old one as well', liveTimers() <= beforeRestart, true);

// ...and the timer it has is the NEW deadline. With the old code the stale timer
// fired into an unchanged state, dispatch returned early, and nothing was left
// scheduled at all -- an animating spinner in one screen position, forever.
tick(12000);
check('a load that never arrives is retired', stateOf(), null);
check('  ...leaving nothing running', liveTimers(), 0);

// --- a restart whose load never arrives, twice ------------------------------
startPreview();
tick(100);
startPreview();
tick(100);
startPreview();
check('repeated restarts keep one timer', liveTimers(), 1);
tick(12000);
check('  ...and the last one still retires', stateOf(), null);
check('  ...with nothing left scheduled', liveTimers(), 0);

// --- stop, when the app does provide one ------------------------------------
startPreview();
tick(300);
fireMedia('playing');
check('playing again', stateOf(), 'playing');
stopPreview();
check('a stop retires the mark', stateOf(), null);
check('  ...and clears its timers', liveTimers(), 0);

// --- the setting -------------------------------------------------------------
startPreview();
tick(300);
fireMedia('playing');
check('running before the setting is touched', stateOf(), 'playing');

removed = 0;
configWrite('enablePreviewIndicator', false);
check('turning it off removes the element', removed, 1);
check('  ...and clears every timer', liveTimers(), 0);

// The bug: disable() dropped the element and left the listeners and the preview
// callbacks in place, so the next preview rebuilt it through ensureElement() and
// the mark came back with the setting off.
const createdBefore = created;
startPreview();
tick(500);
fireMedia('playing');
check('a preview while disabled draws nothing', stateOf(), null);
check('  ...and builds no element', created, createdBefore);
check('  ...and schedules nothing', liveTimers(), 0);

configWrite('enablePreviewIndicator', true);
startPreview();
check('re-enabling works again', stateOf(), 'loading');
check('  ...with one timer', liveTimers(), 1);
// Re-enabling must not double-register: two registrations mean every event is
// handled twice and the second dispatch sees a state the first already moved.
tick(300);
fireMedia('playing');
check('  ...and one playing transition', stateOf(), 'playing');
// The point of this one: re-enabling must not register the preview callbacks a
// second time. A double registration dispatches every event twice, and the
// second dispatch sees a state the first already moved -- so the count matching
// a first enable exactly is the observable form of "registered once".
check('  ...and behaves exactly like a first enable', liveTimers(), timersWhilePlaying);

done();
