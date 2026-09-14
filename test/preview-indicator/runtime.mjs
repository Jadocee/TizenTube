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
import { configWrite, startListeners, stopListeners } from './stub.mjs';

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
let createdNS = 0;
const body = makeEl();
globalThis.document = {
    body,
    activeElement: null,
    createElement: () => {
        created++;
        return makeEl();
    },
    // The two state marks are inline SVG, which is built through the namespaced
    // constructor rather than createElement. Counted separately: `created`
    // measures how many times the indicator's container is built, and folding
    // its children into that number would make the build-once assertions below
    // pass for the wrong reason.
    createElementNS: () => {
        createdNS++;
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
/** The media element the module learns from the event, and the events it reads.
 *  getBoundingClientRect is the PLAYER's box, not the tile's: the app moves one
 *  shared player onto the thumbnail's rect, so this is the box the bar has to
 *  land on. 300x170 at (40, 60) is a plausible tile-sized thumbnail in the
 *  1920x1080 viewport declared below. */
let playerBox = { left: 40, top: 60, width: 300, height: 170 };
const player = {
    muted: false,
    volume: 1,
    webkitAudioDecodedByteCount: 0,
    currentTime: 0,
    getBoundingClientRect: () => playerBox,
};
const fireMedia = (type) => {
    for (const fn of docListeners.get(`${type}:c`) || []) fn({ type, target: player });
};
/** Advance the video's own clock and let the module see it, the way a real
 *  element's timeupdate does. Seconds, because currentTime is in seconds. */
const playTo = (seconds) => {
    player.currentTime = seconds;
    fireMedia('timeupdate');
};
const mark = () => body.children.find((c) => c.id === 'tizentube-preview-indicator') || null;
const stateOf = () => mark()?.getAttribute('data-state') ?? null;
const soundOf = () => mark()?.getAttribute('data-sound') ?? null;
/** The countdown: whether it is drawn at all, and what it reads. Found by class
 *  rather than position, so reordering the mark's children cannot silently make
 *  this assert about the speaker. */
const timeOf = () => mark()?.getAttribute('data-time') ?? null;
const timeText = () =>
    mark()?.children.find((c) => c.className === 'tt-pi-time')?.textContent ?? null;
/** The progress bar, found the same way and for the same reason. */
const barEl = () => body.children.find((c) => c.id === 'tizentube-preview-progress') || null;
const barState = () => barEl()?.getAttribute('data-state') ?? null;
const fillEl = () => barEl()?.children.find((c) => c.className === 'tt-pp-fill') ?? null;
/** The scale the fill has been given, as a number, or null when it has none. */
const fillScale = () => {
    const raw = fillEl()?.style?.transform;
    if (typeof raw !== 'string') return null;
    const m = /scaleX\(([-\d.]+)\)/.exec(raw);
    return m ? Number(m[1]) : null;
};
const barVar = (name) => barEl()?.style?.props?.get(name) ?? null;

// --- the ordinary lifecycle -------------------------------------------------
startPreview();
check('a start draws the loading mark', stateOf(), 'loading');
check('  ...and arms exactly one timer', liveTimers(), 1);
// No bar yet: nothing has played, so there is no position to describe. The
// badge's spinner is the whole signal until a frame arrives.
check('  ...and no bar at all while loading', barState(), null);

tick(500);
fireMedia('playing');
check('the first frame switches to playing', stateOf(), 'playing');
// THREE timers here, and all three are wanted: the watchdog, the one-shot audio
// settle re-check, and the countdown's 1Hz tick. Recorded rather than
// hard-coded, so the re-enable check at the end compares against what a first
// enable actually does instead of a number picked by hand -- which is how that
// assertion was wrong the first time. Recorded is not the same as unexamined,
// though: the next line pins the number, because a recorded value silently
// absorbs a leak, and this one silently absorbed the countdown when it was added.
const timersWhilePlaying = liveTimers();
check('  ...arming the watchdog, the audio re-check and the countdown', timersWhilePlaying, 3);
check('  ...and no speaker until the audio is known', soundOf(), null);

// --- the countdown ----------------------------------------------------------
// Drawn only once frames arrive: while loading there is nothing honest to count.
// DEFAULT_PREVIEW_DURATION_MS is 40s and the frame landed at +500ms.
check('playing draws the countdown', timeOf(), 'on');
// 39.5s left at this point, and remainingMs ceils, so it reads a full 0:40.
check('  ...reading the window it was given', timeText(), '0:40');

// --- the progress bar -------------------------------------------------------
// Driven by the media element's own clock rather than the wall clock, because
// that is what the app's own progress-overlay-view-model does:
//   b = Math.min(100, Math.max(0, Math.max(0, b.current - e) / c * 100))
// with `c` the requested window in seconds and `e` the start offset. The
// numbers below are that formula.
check('playing draws the bar', barState(), 'playing');
// The box the VIDEO is in, not the box the tile is in: 40+300 wide at top 60,
// 170 tall, so the bar's bottom edge is 230 and its width the thumbnail's.
check(
    '  ...across the bottom of the box the video is playing in',
    [barVar('--tt-pp-x'), barVar('--tt-pp-y'), barVar('--tt-pp-w')].join(' '),
    '40px 230px 300px',
);
check('  ...starting from empty', fillScale(), 0);
// Suppressed for exactly one write. Without it a preview starting while the
// last one's bar was still up would animate backwards across the new tile.
check(
    '  ...with the transition suppressed for the snap',
    fillEl()?.style?.transitionDuration,
    '0ms',
);

playTo(10);
check('ten seconds into a forty second window fills a quarter', fillScale(), 0.25);
check('  ...and hands the transition back', fillEl()?.style?.transitionDuration, '');
playTo(80);
check('a video running past the window stops at full', fillScale(), 1);
playTo(10);

fireMedia('waiting');
check('a stall marks the bar', barState(), 'stalled');
check('  ...and leaves it exactly where it was', fillScale(), 0.25);
// THE FILL POSITION IS NOT THE TEST HERE, and reading it was how this check
// passed with the anti-re-arm guard deleted outright: armBar re-snaps the fill
// to progressFraction, which at this moment is the same 0.25 it already showed.
// What a re-arm cannot hide is the transition -- armBar always suppresses it for
// the snap, so an empty transitionDuration is the observable form of "this was
// not re-armed". Measured: deleting the guard flips both of these to '0ms'.
check('  ...without re-arming', fillEl()?.style?.transitionDuration, '');
fireMedia('playing');
check('resuming un-marks it', barState(), 'playing');
check('  ...still without re-arming', fillEl()?.style?.transitionDuration, '');
check('  ...and without sending the fill back to zero', fillScale(), 0.25);

// --- the box is re-measured once, on a timer that already exists -------------
// The app animates its player onto the tile on one of its two paths (200ms,
// ease-in-out), so the box read at the first frame can be one the player was
// still travelling through. The audio-settle timer corrects it.
//
// PROBED ON THIS PREVIEW, WHICH STARTED AT CLOCK 0, because that is the case
// that was broken: placeBar guarded on `!barArmedFor`, barArmedFor holds a
// startedAt, and zero is falsy -- so the correction never ran for the first
// preview of a session. The same trap the module documents twice elsewhere.
// It rides the countdown's existing ticks rather than adding its own: the
// settle timer is due at 1700 and the two ticks below straddle it.
playerBox = { left: 90, top: 110, width: 320, height: 180 };
// MEASURED FROM THE REQUEST, NOT FROM THE FRAME, and these numbers are how you
// can tell. The app arms the timer that stops a preview inside its own start()
// -- `a.I=setTimeout(function(){a.J.stop();...},e)`, with the deferInlineFadeOut
// branch that would wait for playback switched off on this build -- so the load
// latency comes out of the preview. The preview was asked for at clock 0 and the
// frame arrived at 500ms, so the readout at any moment is ceil((40000-clock)/1000)
// and every line below reads exactly 500ms lower than it did when the countdown
// was based on the first frame. On the device that half second was the gap
// between the badge reading "0:02" and the preview having already stopped.
tick(1000); // clock 1500; last tick ran at 1000 with 39.0s left
check('  ...which a second in has already moved', timeText(), '0:39');
check('the bar still has the box measured at the first frame', barVar('--tt-pp-x'), '40px');
tick(4000); // clock 5500; the settle timer fell due at 1700 on the way past
check('  ...and five seconds later has counted down', timeText(), '0:35');
check('  ...and the settle timer re-measured the bar', barVar('--tt-pp-x'), '90px');
check('  ...on every axis', [barVar('--tt-pp-y'), barVar('--tt-pp-w')].join(' '), '290px 320px');
check('  ...without re-arming the fill', fillEl()?.style?.transitionDuration, '');
playerBox = { left: 40, top: 60, width: 300, height: 170 };
// Re-armed against the wall clock rather than on a fixed 1000ms period, so a
// busy TV SoC cannot make the readout drift behind the preview it describes.
tick(30000); // clock 35500; last tick ran at 35000 with 5.0s left
check('  ...still tracking the clock thirty seconds in', timeText(), '0:05');

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
// The bar's own retirement, asserted while the ELEMENT IS STILL THERE. The only
// other place this read null was after dropBar() had detached the node, so it
// was reading the absence of an element rather than the clearing of a state --
// and every path that leaves the bar drawn forever passed it.
check('  ...and the bar is retired too', barState(), null);
check('  ...without being thrown away', barEl() !== null, true);

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
check('the countdown is running again', timeOf(), 'on');

stopPreview();
check('a stop retires the mark', stateOf(), null);
check('  ...and the bar with it', barState(), null);
check('  ...still without throwing the element away', barEl() !== null, true);
// render()'s idle branch RETURNS before the countdown code at the bottom of the
// function, so every stop path had to be given an explicit clear. Without it the
// 1Hz tick outlived every ordinary preview -- one timer, forever, per session.
check('  ...and clears its timers', liveTimers(), 0);
check('  ...including the countdown', timeOf(), null);
check('  ...and blanks its text, so a restart cannot flash a stale number', timeText(), '');

// --- a box that cannot be measured --------------------------------------------
// A preview adopted into a full-screen watch: barBox rejects the player's box
// because it is the whole viewport, and a bar across the bottom of a full-screen
// video would read as the video's own progress rather than the preview's.
//
// What it must NOT do is treat that as the preview ending. The sampled origin is
// this preview's, and throwing it away means a bar that reappears later measures
// from wherever the video has got to and claims the preview has just started.
// Asserted through that consequence, since the origin itself is module-private.
playerBox = { left: 0, top: 0, width: 1920, height: 1080 };
startPreview();
tick(300);
player.currentTime = 100;
fireMedia('playing');
check('a full-screen box draws no bar', barState(), null);
check('  ...though the badge still says the preview is playing', stateOf(), 'playing');
playTo(110);
// Back on a tile, and re-armed by a setting toggle rather than a new preview.
playerBox = { left: 40, top: 60, width: 300, height: 170 };
configWrite('enablePreviewProgressBar', false);
configWrite('enablePreviewProgressBar', true);
check('  ...and the origin it sampled survived the failure', fillScale(), 0.25);
stopPreview();
player.currentTime = 10;

// --- the setting -------------------------------------------------------------
startPreview();
tick(300);
fireMedia('playing');
check('running before the setting is touched', stateOf(), 'playing');

check('  ...and so is the bar', barState(), 'playing');

// --- the two halves are independent ------------------------------------------
// They share a state machine and nothing else. Switching one off while a preview
// is running has to take that one away and leave the other running -- which is
// the whole point of the bar having its own setting: the quietest arrangement
// anyone actually asked for is the bar without the badge.
// The video's clock is deliberately NOT at zero here. The preview above left it
// at 10s, and the app resumes a partly-watched video rather than restarting it
// (`resumeVideo: true` in the mod's own command), so the origin the bar measures
// is the position the preview STARTED at, not the position zero.
check('  ...measured from where this preview began', fillScale(), 0);
playTo(20);
check('  ...so ten seconds of play is a quarter of the window', fillScale(), 0.25);

removed = 0;
configWrite('enablePreviewIndicator', false);
check('turning the badge off removes it', removed, 1);
check('  ...and stops its countdown', liveTimers(), 2);
check('  ...while the bar carries on', barState(), 'playing');
playTo(30);
check('  ...still tracking the video', fillScale(), 0.5);

// place() positions the badge that EXISTS; it must never build one. It used to
// call ensureElement(), and refreshSound() calls place() unconditionally on any
// change in the audio verdict -- so a muted preview, with the badge switched
// off, put the badge back on screen. Driven through that exact path.
const createdBeforeMute = created;
player.muted = true;
fireMedia('volumechange');
check('a sound change does not resurrect the badge', mark(), null);
check('  ...nor build one to position', created, createdBeforeMute);
player.muted = false;
fireMedia('volumechange');

// ONLY THE BAR REJOINS A PREVIEW ALREADY RUNNING, and the asymmetry is about
// anchors. armBar measures the video's own box, so the bar can place itself at
// any moment. The badge anchors to whatever has focus, and by the time someone
// has reached the settings panel to switch it on, focus IS the settings panel --
// so a badge drawn here had its position variables never written, and the
// stylesheet resolves those to a hard translate3d(0px, 0px): the badge in the
// corner of the screen for the rest of the preview. It waits for the next one.
const createdBeforeToggle = created;
configWrite('enablePreviewIndicator', true);
check('turning the badge back on does not redraw it mid-preview', stateOf(), null);
check('  ...and builds nothing to misplace', created, createdBeforeToggle);
check('  ...and leaves the bar alone', fillScale(), 0.5);

removed = 0;
configWrite('enablePreviewProgressBar', false);
check('turning the bar off removes it', removed, 1);
configWrite('enablePreviewProgressBar', true);
// Back at the position the video has actually reached, not at zero. The origin
// survives the setting going off precisely so this cannot claim the preview has
// just started when it is half over.
check('turning it back on restores it where the video is', fillScale(), 0.5);
check('  ...and it is drawn again', barState(), 'playing');

removed = 0;
configWrite('enablePreviewIndicator', false);
configWrite('enablePreviewProgressBar', false);
// One, not two: the badge was already gone, dropped when it was switched off
// above and never rebuilt.
check('turning both off removes what is left', removed, 1);
check('  ...and clears every timer', liveTimers(), 0);

// The bug: disable() dropped the element and left the listeners and the preview
// callbacks in place, so the next preview rebuilt it through ensureElement() and
// the mark came back with the setting off.
const createdBefore = created;
const createdNSBefore = createdNS;
startPreview();
tick(500);
fireMedia('playing');
check('a preview while disabled draws nothing', stateOf(), null);
check('  ...nor a bar', barState(), null);
check('  ...and builds no element', created, createdBefore);
// The two Material marks are the element's children, so a rebuild that slipped
// past the check above would show up here as fresh SVGs even if the container
// were somehow reused.
check('  ...nor the icons inside it', createdNS, createdNSBefore);
check('  ...and schedules nothing', liveTimers(), 0);

configWrite('enablePreviewIndicator', true);
configWrite('enablePreviewProgressBar', true);
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
