// The skip notice's DOM shell, driven with a fake clock and a fake DOM.
//
// THE PURE MODULE NEXT DOOR WAS NEVER WRONG. shouldShow() and remainingMs()
// had a harness from the day they were written and both were correct; the first
// defect a review found was in the shell AROUND them -- hide() reset the
// coalesce record when the pill came down, which silently made the coalescing
// window the same length as the notice. The 400ms between NOTICE_DURATION_MS
// and COALESCE_WINDOW_MS became unreachable, so a repeated skip could blink the
// same message straight back in, which is the one thing the window exists to
// prevent. No assertion on a pure function can see that, because the function
// was asked the right question and gave the right answer; the shell threw away
// the state before asking.
import { checker } from '../lib/repo.mjs';

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
const makeEl = () => ({
    id: '',
    className: '',
    textContent: '',
    parent: null,
    attrs: new Map(),
    children: [],
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
});
let created = 0;
const body = makeEl();
globalThis.document = {
    body,
    createElement: () => {
        created++;
        return makeEl();
    },
    createElementNS: () => makeEl(),
};

const { showSkipNotice, hideSkipNotice } = await import('./runtime.generated.mts');
const { NOTICE_DURATION_MS, COALESCE_WINDOW_MS } = await import('./skipNotice.generated.mts');

const { check, done } = checker();

const pill = () => body.children.find((c) => c.id === 'tizentube-skip-notice') || null;
const shown = () => pill()?.getAttribute('data-shown') ?? null;
const text = () => pill()?.children.find((c) => c.className === 'tt-sn-text')?.textContent ?? null;
/** The glyph currently drawn. Found through the svg's single child, which is
 *  how the module builds it. */
const glyph = () => {
    const svg = pill()?.children.find((c) => c.getAttribute('class') === 'tt-sn-icon');
    return svg?.children[0]?.getAttribute('d') ?? null;
};

// --- the ordinary lifecycle -------------------------------------------------
showSkipNotice('Skipping sponsored segment');
check('a skip draws the notice', shown(), '');
check('  ...with the message', text(), 'Skipping sponsored segment');
check('  ...and arms exactly one timer', liveTimers(), 1);
check('  ...building the element once', created > 0, true);
const builtOnce = created;

tick(NOTICE_DURATION_MS);
check('it comes down on its own', shown(), null);
check('  ...leaving nothing scheduled', liveTimers(), 0);

// --- THE DEFECT: the record has to outlive the pill --------------------------
// The window is deliberately WIDER than the notice. Between the two, the pill is
// already down and the same message must still be suppressed -- otherwise a
// chained skip blinks it back in the instant it left.
check(
    'the same message is still suppressed after the pill goes',
    (() => {
        showSkipNotice('Skipping sponsored segment');
        return shown();
    })(),
    null,
);
check('  ...and nothing was scheduled for it', liveTimers(), 0);

// ...until the window really has passed.
tick(COALESCE_WINDOW_MS - NOTICE_DURATION_MS);
showSkipNotice('Skipping sponsored segment');
check('once the window passes it shows again', shown(), '');
check('  ...reusing the element rather than rebuilding it', created, builtOnce);

// --- a different message is never swallowed ---------------------------------
// PART WAY THROUGH the first notice's life, deliberately. Replacing at the same
// instant makes a restarted timer and an inherited one indistinguishable, which
// is how the first draft of this harness passed while the timer was NOT being
// restarted. 1500ms in, the two deadlines are 1500ms apart and the difference
// is the whole assertion.
tick(1500);
showSkipNotice('Skipping interaction reminder');
check('a different skip replaces it immediately', text(), 'Skipping interaction reminder');
check('  ...and still holds one timer, not two', liveTimers(), 1);
// If the timer had been inherited rather than restarted, this notice would come
// down 1100ms from here instead of 2600ms.
tick(NOTICE_DURATION_MS - 1);
check('  ...running its OWN full duration, not the remainder', shown(), '');
tick(1);
check('  ...and then coming down', shown(), null);

// --- the glyph has to agree with the sentence -------------------------------
// "Not skipping ..." under a fast-forward arrow says two opposite things at
// once, and that message is the one a user is least likely to already
// understand -- so it is the one that can least afford a contradictory mark.
tick(COALESCE_WINDOW_MS);
showSkipNotice('Skipping sponsored segment', true);
const forward = glyph();
check('a skip draws an arrow', typeof forward === 'string' && forward.length > 0, true);
tick(COALESCE_WINDOW_MS);
showSkipNotice('Not skipping sponsored segment (was skipped 3 times)', false);
check('a NOT-skip draws a different mark', glyph() !== forward, true);
check('  ...and it is still a real path', (glyph() || '').length > 0, true);
tick(COALESCE_WINDOW_MS);
showSkipNotice('Skipping outro', true);
check('  ...and a later skip goes back to the arrow', glyph(), forward);
tick(COALESCE_WINDOW_MS);

// --- leaving the player forgets ---------------------------------------------
// The one event that makes the history irrelevant: the next video's first skip
// must never be swallowed as a repeat of the previous video's last one.
showSkipNotice('Skipping outro');
check('a skip near the end of a video shows', shown(), '');
hideSkipNotice();
check('leaving the player takes it down', shown(), null);
check('  ...and clears its timer', liveTimers(), 0);
showSkipNotice('Skipping outro');
check('  ...and forgets, so the next video shows the same message', shown(), '');

done();
