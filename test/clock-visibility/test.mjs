// When the clock is on screen, and how clock.ts and clock.css say so.
//
// The clock used to be drawn whenever its setting was on: over the home page,
// over search, over the guide, permanently. It is now meant to appear only while
// a video is playing in the fullscreen watch player, and that is three separate
// facts about the app -- the route, the player, and whether the thing playing is
// a thumbnail preview -- combined by a pure function this harness runs directly.
//
// The DOM half is asserted as source shape rather than driven, because the two
// ways this feature breaks are not observable from a state machine:
//
//   1. Hiding with `opacity`. ui.ts's idle dimming writes `opacity` with
//      `!important` over every `.tt-dimmable` element, and the clock is one of
//      them. An opacity-based hide is a race that is won by whichever of the two
//      ran last, and on a television it presents as "the clock sometimes stays".
//   2. Writing the `display` rule AFTER a nested rule in clock.css. Chromium 120
//      hoists such a declaration above the nested rules, which would make
//      `display: none` unconditional and the clock permanently invisible.
//
// Both are one grep each, and both have a wrong version that type-checks, bundles
// and passes every other harness in the suite.
import { readRepo, checker } from '../lib/repo.mjs';
import { HIDDEN, reduce, clockVisible, isWatchRoute } from './clockVisibility.generated.mts';

const { check, done } = checker();

/** Folds a run of signals, the way clock.ts does one at a time. */
const play = (...signals) => signals.reduce(reduce, HIDDEN);
const visibleAfter = (...signals) => clockVisible(play(...signals));

// --- the route is what makes it "fullscreen" --------------------------------
check('nothing playing, nothing shown', clockVisible(HIDDEN), false);
check('a video playing off the watch page stays hidden', visibleAfter('play'), false);
check('the watch page with nothing playing stays hidden', visibleAfter('enterWatch'), false);
check('the watch page with a video playing shows it', visibleAfter('enterWatch', 'play'), true);
check('  ...in either order, because events race', visibleAfter('play', 'enterWatch'), true);

// --- leaving the video ------------------------------------------------------
// Audio can outlive the route change by a beat, so the route alone has to be
// enough to hide it -- otherwise the clock is left over the home page for
// exactly as long as the app takes to tear the player down.
check(
    'leaving the watch page hides it even while playing',
    visibleAfter('enterWatch', 'play', 'leaveWatch'),
    false,
);
check('pausing hides it', visibleAfter('enterWatch', 'play', 'stop'), false);
check('  ...and resuming brings it back', visibleAfter('enterWatch', 'play', 'stop', 'play'), true);

// --- previews are playback too ----------------------------------------------
// A focused tile plays through the same element. Without the preview signal the
// clock would come back the moment the home page auto-played a thumbnail, which
// is the bug being fixed, not a corner of it.
check('a tile preview never shows it', visibleAfter('previewStart', 'play'), false);
check(
    'a preview on the watch page suppresses it',
    visibleAfter('enterWatch', 'play', 'previewStart'),
    false,
);
check(
    '  ...and the preview ending restores it',
    visibleAfter('enterWatch', 'play', 'previewStart', 'previewStop'),
    true,
);

// --- the latch that would otherwise be permanent ----------------------------
// playbackPreview can only report a preview ENDING when the shipped service has
// a teardown method to wrap; previewStopHooked() exists precisely because it has
// been wrong about that before. If `stop` did not clear `previewing`, one
// preview with no matching stop would hide the clock for the rest of the
// session and no signal would ever undo it.
const latched = play('previewStart', 'play', 'stop');
check('a stop clears the preview flag as well', latched.previewing, false);
check(
    '  ...so the next video recovers with no previewStop at all',
    clockVisible(reduce(reduce(latched, 'enterWatch'), 'play')),
    true,
);

// --- the reducer's identity contract ----------------------------------------
// clock.ts skips the DOM write when reduce() returns the same object. `playing`
// fires again after every buffer stall, so this is the difference between one
// write and one per stall.
const watching = play('enterWatch', 'play');
check('a repeated play is the same object', reduce(watching, 'play') === watching, true);
check(
    'a repeated enterWatch is the same object',
    reduce(watching, 'enterWatch') === watching,
    true,
);
check('a stop with nothing playing is the same object', reduce(HIDDEN, 'stop') === HIDDEN, true);
check(
    'a previewStop with no preview is the same object',
    reduce(HIDDEN, 'previewStop') === HIDDEN,
    true,
);
check('an unknown signal is the same object', reduce(HIDDEN, 'nonsense') === HIDDEN, true);

// --- reading the route ------------------------------------------------------
// Matched on the `v=` parameter, which is how sponsorblock.ts and
// captionRuntime.ts already read this hash.
check('a watch hash is a watch route', isWatchRoute('#/watch?v=dQw4w9WgXcQ'), true);
check('  ...with further parameters', isWatchRoute('#/watch?v=abc&list=RD'), true);
check('  ...and as a bare query', isWatchRoute('#?v=abc'), true);
check('  ...with v= not first', isWatchRoute('#/watch?list=RD&v=abc'), true);
check('the home hash is not', isWatchRoute('#/'), false);
check('  ...nor an empty hash', isWatchRoute(''), false);
check('  ...nor a browse hash', isWatchRoute('#?c=FEwhat_to_watch'), false);
// `v` has to be the whole parameter name and has to have a value. A browse hash
// carrying `?tv=1` matched a looser test, and every browse page would then have
// counted as a video.
check('a parameter merely ending in v does not count', isWatchRoute('#/browse?tv=1'), false);
check('an empty v does not count', isWatchRoute('#/watch?v='), false);
check('a missing hash does not throw', isWatchRoute(null), false);
check('  ...nor a non-string', isWatchRoute(undefined), false);

// --- clock.ts wires all of it -----------------------------------------------
const clock = readRepo('mods', 'ui', 'clock.ts');
// Comments are stripped first. Every assertion below is about code that runs,
// and every one of these strings also appears in the prose explaining it.
const code = clock
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

check(
    'clock.ts uses the state machine',
    code.includes("from '../features/clockVisibility.js'"),
    true,
);
for (const [event, signal] of [
    ['playing', 'play'],
    ['pause', 'stop'],
    ['ended', 'stop'],
    ['emptied', 'stop'],
]) {
    check(
        `  ...and maps ${event} to ${signal}`,
        new RegExp(`\\[\\s*'${event}'\\s*,\\s*'${signal}'\\s*\\]`).test(code),
        true,
    );
}
// Capture phase, on the document. Media events do not bubble and the app
// replaces its <video>, so a listener on the element is a listener that stops
// firing at the moment it matters.
check(
    '  ...listening on the document in the capture phase',
    /document\.addEventListener\(\s*type\s*,[\s\S]*?,\s*true,?\s*\)/.test(code),
    true,
);
check('  ...and only for <video> targets', code.includes("=== 'VIDEO'"), true);
check('  ...following the route', code.includes("window.addEventListener('hashchange'"), true);
check(
    '  ...and the preview service',
    code.includes('onPreviewStart(') && code.includes('onPreviewStop('),
    true,
);

// The hide has to be an attribute the stylesheet keys off, NOT a style write:
// see the header. A `style.opacity` or `style.display` here would be the bug.
check('  ...toggling an attribute rather than a style', code.includes("'data-watching'"), true);
check(
    '  ...and never writing opacity or display itself',
    /\.style\.(opacity|display)|setProperty\(\s*'(opacity|display)'/.test(code),
    false,
);
// The ticker follows visibility. A hidden clock that still ticks is a timer, a
// Date and a string compare every second, forever, on a CPU decoding video.
check(
    '  ...stopping the ticker when hidden',
    /clockVisible\(playback\)[\s\S]*?stopClock\(\)/.test(code),
    true,
);
check('  ...and seeding state when the clock is enabled', code.includes('resyncPlayback()'), true);

// --- clock.css does the hiding ----------------------------------------------
const css = readRepo('mods', 'ui', 'clock.css');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const hideAt = rules.indexOf('display: none');
const firstNested = rules.indexOf('&');
const showAt = rules.indexOf('&[data-watching]');

check('clock.css hides the clock by default', hideAt >= 0, true);
check('  ...and un-hides it on the attribute', showAt >= 0, true);
check(
    '  ...with display, not opacity',
    /&\[data-watching\]\s*\{\s*display:\s*block/.test(rules),
    true,
);
// The M120 hoist. `display: none` written below a nested rule is moved above it,
// where nothing can override it -- so the ordering is the assertion, and it is
// only meaningful once both landmarks are known to exist.
check('  ...a nested rule to be ordered against', firstNested >= 0, true);
check(
    '  ...and the default hide written before them',
    hideAt >= 0 && firstNested >= 0 && hideAt < firstNested,
    true,
);

// --- the corner, and the size ------------------------------------------------
// Asked for: the very top right, slightly smaller. What is kept is a margin
// small enough to read as the corner and large enough to survive a set that
// overscans; the old 3rem/4rem sat on the 5% title-safe line and read as inset.
const offsets = [...rules.matchAll(/inset-block-(?:start|end):\s*([\d.]+)rem/g)].map((m) =>
    Number(m[1]),
);
const inline = [...rules.matchAll(/(?:left|right):\s*([\d.]+)rem/g)].map((m) => Number(m[1]));
check('all four corners set a block offset', offsets.length, 4);
check('all four set an inline offset', inline.length, 4);
check('  ...the same block offset for each', new Set(offsets).size, 1);
check('  ...and the same inline offset', new Set(inline).size, 1);
check('  ...nearer the corner than the old 3rem', offsets[0] < 3, true);
check('  ...and than the old 4rem', inline[0] < 4, true);
// Not zero: a clock cropped off the edge of an overscanning set is worse than
// one sitting a little inside it, because the user cannot tell it is there.
check('  ...but off the physical edge', offsets[0] > 0 && inline[0] > 0, true);

const size = rules.match(/font-size:\s*([\d.]+)rem/);
check('the clock still sets a font size', !!size, true);
check('  ...smaller than the old 2rem', Number(size?.[1]) < 2, true);
// "Slightly". Halving it would make a clock nobody can read across a lounge.
check('  ...but not shrunk past legibility', Number(size?.[1]) >= 1.4, true);

done();
