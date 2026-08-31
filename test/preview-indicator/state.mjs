// The preview indicator's decisions, run as the real module.
//
// This harness exists because of what the alternative is. A mark that says "this
// thumbnail is playing" is wrong in ways nobody can see from here: stranded on
// screen after playback ended, cancelled by the focus move that caused it, drawn
// off the edge of a right-to-left layout, anchored to a page container instead
// of a tile. On a television there is no console, so each of those arrives as
// "the icon is weird" and nothing more. Every one of them is a decision made by
// a pure function in mods/features/previewState.ts, and every one is asserted
// here.
//
// The module is copied verbatim by test/refresh.mjs -- it has no imports, so
// there is nothing to stub and nothing to drift.
import { checker } from '../lib/repo.mjs';
import {
    IDLE,
    reduce,
    anchorUsable,
    chipOrigin,
    shouldAnchor,
    MOVE_GRACE_MS,
    WATCHDOG_SLACK_MS,
    ANCHOR_SETTLE_MS,
    SAFE_FRACTION,
} from './previewState.generated.mts';

const { check, done } = checker();

const T0 = 1_000_000;
const started = reduce(IDLE, { type: 'start', now: T0, durationMs: 40000, anchored: true });

// --- the ordinary lifecycle ------------------------------------------------
check('start shows the mark', started.phase, 'playing');
check('  ...and records when it began', started.startedAt, T0);
check('  ...and a deadline past the requested duration', started.endsAt, T0 + 40000 + WATCHDOG_SLACK_MS);
check('stop hides it', reduce(started, { type: 'stop' }).phase, 'idle');
check('a route change hides it', reduce(started, { type: 'route' }).phase, 'idle');

// A preview that becomes a full-screen watch changes the route without ever
// calling stop(). Without this the mark rides on top of the video.
check('route wins even while stalled',
      reduce(reduce(started, { type: 'stall' }), { type: 'route' }).phase, 'idle');

// --- the focus move the app makes for itself --------------------------------
// Starting a preview moves focus as a side effect. Retiring on that would mean
// the mark never survived its own first frame -- and asserting only one side of
// this is exactly how you certify a coin flip, so both are here.
check('the app\'s own focus move does not cancel the mark',
      reduce(started, { type: 'move', now: T0 + MOVE_GRACE_MS - 1 }).phase, 'playing');
check('a real D-pad move does cancel it',
      reduce(started, { type: 'move', now: T0 + MOVE_GRACE_MS + 1 }).phase, 'idle');
check('a move while already idle is still idle',
      reduce(IDLE, { type: 'move', now: T0 }).phase, 'idle');

// --- the watchdog -----------------------------------------------------------
// The app stops its own previews. This bounds the case where that never
// happens, because a mark left up claims a still thumbnail is playing.
check('the watchdog retires a mark whose stop never came',
      reduce(started, { type: 'tick', now: started.endsAt }).phase, 'idle');
check('  ...and does not retire it a millisecond early',
      reduce(started, { type: 'tick', now: started.endsAt - 1 }).phase, 'playing');
check('a tick on idle returns the identical object',
      reduce(IDLE, { type: 'tick', now: T0 }) === IDLE, true);

// A duration the payload never carried must still produce a finite deadline, or
// the watchdog never fires and the mark is permanent.
for (const [label, duration] of [['absent', undefined], ['zero', 0], ['NaN', NaN], ['negative', -5]]) {
    const s = reduce(IDLE, { type: 'start', now: T0, durationMs: duration, anchored: false });
    check(`a ${label} duration still yields a finite deadline`,
          Number.isFinite(s.endsAt) && s.endsAt > T0, true);
}

// --- buffering --------------------------------------------------------------
check('stall only from playing', reduce(started, { type: 'stall' }).phase, 'stalled');
check('resume only from stalled',
      reduce(reduce(started, { type: 'stall' }), { type: 'resume' }).phase, 'playing');
check('resume from playing is a no-op', reduce(started, { type: 'resume' }).phase, 'playing');
check('stall on idle stays idle', reduce(IDLE, { type: 'stall' }).phase, 'idle');
check('stalling does not move the deadline',
      reduce(started, { type: 'stall' }).endsAt, started.endsAt);

// --- junk -------------------------------------------------------------------
// This runs off YouTube's own callbacks. A throw here would take the preview
// with it, so every one of these must return rather than raise.
let threw = null;
for (const junk of [null, undefined, {}, { type: 'nope' }, { type: 'start' }, { type: 'move' },
                    { type: 'tick' }, { type: 'start', now: NaN, durationMs: NaN }]) {
    try {
        const s = reduce(started, junk);
        if (s.phase !== 'idle' && !Number.isFinite(s.endsAt)) threw = `unbounded state from ${JSON.stringify(junk)}`;
    } catch (e) {
        threw = `${JSON.stringify(junk)} threw ${e.message}`;
    }
}
check('junk events never throw and never leave an unbounded state', threw, null);
check('a null state falls back to idle', reduce(null, { type: 'stop' }).phase, 'idle');

// --- is this box a tile? ----------------------------------------------------
const VIEWPORT = { width: 1920, height: 1080 };
const TILE = { left: 300, top: 400, width: 320, height: 180 };
check('a plausible tile is usable', anchorUsable(TILE, VIEWPORT), true);
check('a full-viewport box is not', anchorUsable({ left: 0, top: 0, width: 1920, height: 1080 }, VIEWPORT), false);
check('a shelf-width box is not', anchorUsable({ left: 0, top: 400, width: 1800, height: 200 }, VIEWPORT), false);
check('a collapsed box is not', anchorUsable({ left: 0, top: 0, width: 0, height: 0 }, VIEWPORT), false);
check('null is not', anchorUsable(null, VIEWPORT), false);
check('a NaN rect is not', anchorUsable({ left: NaN, top: 0, width: 320, height: 180 }, VIEWPORT), false);
check('a zero viewport rejects everything', anchorUsable(TILE, { width: 0, height: 0 }), false);

// --- where the mark goes ----------------------------------------------------
const CHIP = { width: 64, height: 64 };
const onTile = chipOrigin(TILE, VIEWPORT, CHIP);
check('an anchored mark sits inside the tile\'s top-left', onTile.x > TILE.left && onTile.x < TILE.left + TILE.width, true);
check('  ...on both axes', onTile.y > TILE.top && onTile.y < TILE.top + TILE.height, true);

// Title-safe is 5% of EACH dimension. One number for all four edges is 42px
// looser than the standard horizontally at 16:9, and horizontal is the axis
// that actually gets clipped.
const corner = chipOrigin(null, VIEWPORT, CHIP);
check('the fallback clears the title-safe inset on the right',
      VIEWPORT.width - (corner.x + CHIP.width) >= VIEWPORT.width * SAFE_FRACTION - 1, true);
check('  ...and along the bottom',
      VIEWPORT.height - (corner.y + CHIP.height) >= VIEWPORT.height * SAFE_FRACTION - 1, true);

// A tile at the extreme edge must not push the mark off screen.
const extremes = [
    ['far right', { left: 1900, top: 400, width: 320, height: 180 }],
    ['far bottom', { left: 300, top: 1060, width: 320, height: 180 }],
    ['negative origin', { left: -50, top: -50, width: 320, height: 180 }],
];
let offscreen = null;
for (const [label, rect] of extremes) {
    const o = chipOrigin(rect, VIEWPORT, CHIP);
    if (o.x < 0 || o.y < 0 || o.x + CHIP.width > VIEWPORT.width || o.y + CHIP.height > VIEWPORT.height) {
        offscreen = `${label} -> ${JSON.stringify(o)}`;
    }
}
check('the mark is never placed off screen', offscreen, null);
check('a junk viewport still yields finite coordinates',
      Number.isFinite(chipOrigin(TILE, { width: NaN, height: NaN }, CHIP).x), true);

// --- has focus settled enough to measure? -----------------------------------
check('a session with no move yet anchors', shouldAnchor(0, T0), true);
check('mid-movement does not anchor', shouldAnchor(T0, T0 + ANCHOR_SETTLE_MS - 1), false);
check('settled focus anchors', shouldAnchor(T0, T0 + ANCHOR_SETTLE_MS), true);
check('a backwards clock does not anchor', shouldAnchor(T0, T0 - 1000), false);
check('a NaN clock anchors rather than throwing', shouldAnchor(T0, NaN), true);

done();
