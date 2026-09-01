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
    soundState,
    LOADING_TIMEOUT_MS,
    AUDIO_SETTLE_MS,
    MOVE_GRACE_MS,
    WATCHDOG_SLACK_MS,
    ANCHOR_SETTLE_MS,
    SAFE_FRACTION,
} from './previewState.generated.mts';

const { check, done } = checker();

const T0 = 1_000_000;
const started = reduce(IDLE, { type: 'start', now: T0, durationMs: 40000, anchored: true });
/** The same preview, once frames are actually arriving. */
const playing = reduce(started, { type: 'resume', now: T0 + 900 });

// --- the ordinary lifecycle ------------------------------------------------
// start() is the app being ASKED to play, not playback. On a television the gap
// between the two is a real wait, and treating them as the same moment is what
// made a focused tile look identical whether the preview was coming or had
// silently failed.
check('start shows the mark as loading', started.phase, 'loading');
check('  ...and records when it began', started.startedAt, T0);
check('  ...with nothing played yet', started.playingAt, 0);
check(
    '  ...and a deadline past the requested duration',
    started.endsAt,
    T0 + LOADING_TIMEOUT_MS + 40000 + WATCHDOG_SLACK_MS,
);

// --- loading resolves -------------------------------------------------------
check('the first frame starts playback', playing.phase, 'playing');
check('  ...and is recorded', playing.playingAt, T0 + 900);
check('  ...without moving the deadline', playing.endsAt, started.endsAt);
check(
    'a second frame does not re-record the start',
    reduce(playing, { type: 'resume', now: T0 + 5000 }).playingAt,
    T0 + 900,
);

// A preview asked for and never delivered. Without this the spinner outlives the
// thing it describes, which is the one outcome worse than showing nothing: it
// says "any moment now" forever.
check(
    'a load that never arrives is retired',
    reduce(started, { type: 'tick', now: T0 + LOADING_TIMEOUT_MS }).phase,
    'idle',
);
check(
    '  ...but not a millisecond early',
    reduce(started, { type: 'tick', now: T0 + LOADING_TIMEOUT_MS - 1 }).phase,
    'loading',
);
// ...and once it IS playing, the load timeout must not apply -- a preview longer
// than LOADING_TIMEOUT_MS would otherwise lose its mark mid-playback.
check(
    'the load timeout does not retire a playing preview',
    reduce(playing, { type: 'tick', now: T0 + LOADING_TIMEOUT_MS + 1 }).phase,
    'playing',
);
check('stop hides it', reduce(started, { type: 'stop' }).phase, 'idle');
check('a route change hides it', reduce(started, { type: 'route' }).phase, 'idle');

// A preview that becomes a full-screen watch changes the route without ever
// calling stop(). Without this the mark rides on top of the video.
check(
    'route wins even while stalled',
    reduce(reduce(started, { type: 'stall' }), { type: 'route' }).phase,
    'idle',
);

// --- the focus move the app makes for itself --------------------------------
// Starting a preview moves focus as a side effect. Retiring on that would mean
// the mark never survived its own first frame -- and asserting only one side of
// this is exactly how you certify a coin flip, so both are here.
check(
    "the app's own focus move does not cancel the mark",
    reduce(started, { type: 'move', now: T0 + MOVE_GRACE_MS - 1 }).phase,
    'loading',
);
check(
    'a real D-pad move does cancel it',
    reduce(started, { type: 'move', now: T0 + MOVE_GRACE_MS + 1 }).phase,
    'idle',
);
check(
    'a move while already idle is still idle',
    reduce(IDLE, { type: 'move', now: T0 }).phase,
    'idle',
);

// --- the watchdog -----------------------------------------------------------
// The app stops its own previews. This bounds the case where that never
// happens, because a mark left up claims a still thumbnail is playing.
check(
    'the watchdog retires a mark whose stop never came',
    reduce(started, { type: 'tick', now: started.endsAt }).phase,
    'idle',
);
check(
    '  ...and does not retire it a millisecond early',
    reduce(playing, { type: 'tick', now: playing.endsAt - 1 }).phase,
    'playing',
);
check(
    'a tick on idle returns the identical object',
    reduce(IDLE, { type: 'tick', now: T0 }) === IDLE,
    true,
);

// A duration the payload never carried must still produce a finite deadline, or
// the watchdog never fires and the mark is permanent.
for (const [label, duration] of [
    ['absent', undefined],
    ['zero', 0],
    ['NaN', NaN],
    ['negative', -5],
]) {
    const s = reduce(IDLE, { type: 'start', now: T0, durationMs: duration, anchored: false });
    check(
        `a ${label} duration still yields a finite deadline`,
        Number.isFinite(s.endsAt) && s.endsAt > T0,
        true,
    );
}

// --- buffering --------------------------------------------------------------
check('stall only from playing', reduce(playing, { type: 'stall' }).phase, 'stalled');
check(
    'resume only from stalled',
    reduce(reduce(playing, { type: 'stall' }), { type: 'resume', now: T0 + 2000 }).phase,
    'playing',
);
check(
    'resume from playing is a no-op',
    reduce(playing, { type: 'resume', now: T0 + 2000 }).phase,
    'playing',
);
check('stall on idle stays idle', reduce(IDLE, { type: 'stall' }).phase, 'idle');
// A stall before the first frame is not new information -- nothing has played,
// so the spinner is already the right answer and swapping would flicker.
check('stall while loading stays loading', reduce(started, { type: 'stall' }).phase, 'loading');
check(
    'stalling does not move the deadline',
    reduce(playing, { type: 'stall' }).endsAt,
    playing.endsAt,
);
// Recovering from a stall must not re-stamp playingAt, or the audio settle
// window restarts every time the connection hiccups and the speaker never
// resolves.
check(
    'recovering from a stall keeps the original start',
    reduce(reduce(playing, { type: 'stall' }), { type: 'resume', now: T0 + 9000 }).playingAt,
    T0 + 900,
);

// --- does it make a noise? --------------------------------------------------
// Three answers, and the third is the point: a speaker drawn on a silent video
// sends someone hunting for audio that was never there, so anything short of
// evidence draws nothing.
check('a muted element is silent', soundState({ muted: true }), 'silent');
check('zero volume is silent', soundState({ muted: false, volume: 0 }), 'silent');
check('an unreadable element is unknown', soundState(null), 'unknown');
check('an element with no muted flag is unknown', soundState({ volume: 1 }), 'unknown');

// No byte counter (another engine, or a build that does not expose it): the mod
// asked for sound and nothing is suppressing it, which is the best claim
// available and right for the overwhelming majority of videos.
check('unmuted with no counter is audible', soundState({ muted: false, volume: 1 }), 'audible');
check(
    'decoded audio is audible',
    soundState({ muted: false, volume: 1, audioBytes: 4096, playingForMs: 10 }),
    'audible',
);
// The trap: Chromium reports zero decoded bytes for the first frames of a video
// that DOES have sound. Concluding "silent" there would mark almost everything
// silent.
check(
    'zero bytes too early is unknown, not silent',
    soundState({ muted: false, volume: 1, audioBytes: 0, playingForMs: AUDIO_SETTLE_MS - 1 }),
    'unknown',
);
check(
    '  ...and silent once it has had time',
    soundState({ muted: false, volume: 1, audioBytes: 0, playingForMs: AUDIO_SETTLE_MS }),
    'silent',
);
// Muting wins over a counter that has already moved: the video has sound, but it
// is not making any.
check(
    'muted beats a non-zero counter',
    soundState({ muted: true, volume: 1, audioBytes: 4096, playingForMs: 9999 }),
    'silent',
);
let soundThrew = null;
for (const junk of [null, undefined, 0, '', 'x', [], {}, NaN, true]) {
    try {
        soundState(junk);
    } catch (e) {
        soundThrew = `soundState(${JSON.stringify(junk)}) threw ${e.message}`;
    }
}
check('soundState never throws', soundThrew, null);

// --- junk -------------------------------------------------------------------
// This runs off YouTube's own callbacks. A throw here would take the preview
// with it, so every one of these must return rather than raise.
let threw = null;
for (const junk of [
    null,
    undefined,
    {},
    { type: 'nope' },
    { type: 'start' },
    { type: 'move' },
    { type: 'tick' },
    { type: 'start', now: NaN, durationMs: NaN },
]) {
    try {
        const s = reduce(started, junk);
        if (s.phase !== 'idle' && !Number.isFinite(s.endsAt))
            threw = `unbounded state from ${JSON.stringify(junk)}`;
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
check(
    'a full-viewport box is not',
    anchorUsable({ left: 0, top: 0, width: 1920, height: 1080 }, VIEWPORT),
    false,
);
check(
    'a shelf-width box is not',
    anchorUsable({ left: 0, top: 400, width: 1800, height: 200 }, VIEWPORT),
    false,
);
check(
    'a collapsed box is not',
    anchorUsable({ left: 0, top: 0, width: 0, height: 0 }, VIEWPORT),
    false,
);
check('null is not', anchorUsable(null, VIEWPORT), false);
check(
    'a NaN rect is not',
    anchorUsable({ left: NaN, top: 0, width: 320, height: 180 }, VIEWPORT),
    false,
);
check('a zero viewport rejects everything', anchorUsable(TILE, { width: 0, height: 0 }), false);

// --- where the mark goes ----------------------------------------------------
const CHIP = { width: 64, height: 64 };
const onTile = chipOrigin(TILE, VIEWPORT, CHIP);
check(
    "an anchored mark sits inside the tile's top-left",
    onTile.x > TILE.left && onTile.x < TILE.left + TILE.width,
    true,
);
check('  ...on both axes', onTile.y > TILE.top && onTile.y < TILE.top + TILE.height, true);

// Title-safe is 5% of EACH dimension. One number for all four edges is 42px
// looser than the standard horizontally at 16:9, and horizontal is the axis
// that actually gets clipped.
const corner = chipOrigin(null, VIEWPORT, CHIP);
check(
    'the fallback clears the title-safe inset on the right',
    VIEWPORT.width - (corner.x + CHIP.width) >= VIEWPORT.width * SAFE_FRACTION - 1,
    true,
);
check(
    '  ...and along the bottom',
    VIEWPORT.height - (corner.y + CHIP.height) >= VIEWPORT.height * SAFE_FRACTION - 1,
    true,
);

// A tile at the extreme edge must not push the mark off screen.
const extremes = [
    ['far right', { left: 1900, top: 400, width: 320, height: 180 }],
    ['far bottom', { left: 300, top: 1060, width: 320, height: 180 }],
    ['negative origin', { left: -50, top: -50, width: 320, height: 180 }],
];
let offscreen = null;
for (const [label, rect] of extremes) {
    const o = chipOrigin(rect, VIEWPORT, CHIP);
    if (
        o.x < 0 ||
        o.y < 0 ||
        o.x + CHIP.width > VIEWPORT.width ||
        o.y + CHIP.height > VIEWPORT.height
    ) {
        offscreen = `${label} -> ${JSON.stringify(o)}`;
    }
}
check('the mark is never placed off screen', offscreen, null);
check(
    'a junk viewport still yields finite coordinates',
    Number.isFinite(chipOrigin(TILE, { width: NaN, height: NaN }, CHIP).x),
    true,
);

// --- has focus settled enough to measure? -----------------------------------
check('a session with no move yet anchors', shouldAnchor(0, T0), true);
check('mid-movement does not anchor', shouldAnchor(T0, T0 + ANCHOR_SETTLE_MS - 1), false);
check('settled focus anchors', shouldAnchor(T0, T0 + ANCHOR_SETTLE_MS), true);
check('a backwards clock does not anchor', shouldAnchor(T0, T0 - 1000), false);
check('a NaN clock anchors rather than throwing', shouldAnchor(T0, NaN), true);

done();
