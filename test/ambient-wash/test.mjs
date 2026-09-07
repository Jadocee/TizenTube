// The ambient wash behind the browse surfaces.
//
// It is five radial gradients painted into #container's own background-image,
// and everything that makes it SAFE is a property of how it is written rather
// than of how it looks. Each of those is one careless edit away from being
// undone, and none of them would show up as a visual regression -- they show up
// as a television that drops frames, or as metadata nobody can read.
//
// Measured on a page built from the live app's own rules at 1920x1080, this
// costs zero extra composited layers and zero GPU backing store: byte-identical
// to having no background at all. The assertions below are what keeps that true.
import { readRepo, checker } from '../lib/repo.mjs';

const { check, done } = checker();

const css = readRepo('mods', 'ui', 'bubbles.css');
// Every assertion here is about code, and the file's own comment explains each
// one in prose that would otherwise match.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

// --- the gate ---------------------------------------------------------------
// POSITIVE, on the app's own page-type class. The app assigns
// document.body.className wholesale immediately before it renders, so the class
// is correct before the first pixel -- but during boot the body carries NO class
// at all, so a negative gate would match and paint the wash under the splash.
check('the wash is gated on the app page type', code.includes('body.WEB_PAGE_TYPE_BROWSE'), true);
check(
    '  ...and it targets the app container',
    /body\.WEB_PAGE_TYPE_BROWSE\s+#container\s*\{/.test(code),
    true,
);
check(
    '  ...positively, so boot and playback match nothing',
    /body:not\(|:not\(\s*\.WEB_PAGE_TYPE/.test(code),
    false,
);

// --- background-IMAGE, never the shorthand ----------------------------------
// The shorthand resets background-color, and #container's #0f0f0f fill is what
// these gradients are composited over. Losing it puts them over the body's
// black and changes every colour below.
check('the wash is painted as background-image', /background-image\s*:/.test(code), true);
check('  ...never through the shorthand', /(^|[;{\s])background\s*:/.test(code), false);
// No !important anywhere: specificity (1,1,1) already beats the app's (1,0,0),
// and reaching for !important would mean the selector is wrong.
check('  ...and needs no !important', code.includes('!important'), false);

// --- it does not move, and that is the whole performance argument ------------
// background-position keyframes measured ~1945 raster tasks a second on the main
// thread. Transform-animated siblings measured +3.78 MiB of GPU texture at 1080p
// and turned an idle home screen from zero composited frames into 60 a second --
// to deliver drift of about 1.2 px/s, which is below the threshold at which a
// person notices motion at all.
check('nothing animates', /@keyframes|animation\s*:|transition\s*:/.test(code), false);
check(
    '  ...and nothing is promoted to its own layer',
    /will-change|translateZ|backface-/.test(code),
    false,
);
// blur() costs frames rather than memory, and a radial-gradient falloff already
// IS the blur, rasterised once.
check('  ...and nothing is blurred', /filter\s*:|backdrop-filter/.test(code), false);

// --- alpha is a contrast number, not a taste one ----------------------------
// YouTube's own secondary metadata is #909090 on #0f0f0f: a ground of 6.00:1.
// One 8% peak takes it to 5.41:1, two overlapping 8% peaks to 4.90:1, 10% to
// 4.53:1 and 12% to 4.25:1. 8% is the ceiling that keeps two overlapping
// bubbles clear of 4.5:1.
const alphas = [...code.matchAll(/rgb\([^)]*\/\s*([\d.]+)%\s*\)/g)]
    .map((m) => Number(m[1]))
    .filter((a) => a > 0);
check('the wash has peaks to check', alphas.length > 0, true);
check('  ...none above the 8% contrast ceiling', Math.max(...alphas), 8);

// --- shape ------------------------------------------------------------------
const gradients = (code.match(/radial-gradient\(/g) || []).length;
check('several bubbles rather than one wash', gradients >= 3, true);
// Few enough to rasterise once without cost; the measurement above was taken at
// five.
check('  ...but not so many they stop being bubbles', gradients <= 8, true);
// Every peak sits off the canvas or on its edge, so nothing bright is parked in
// the middle of the screen for hours -- the OLED worry clock.css also records.
const positions = [...code.matchAll(/at\s+(-?[\d.]+)%\s+(-?[\d.]+)%/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
]);
check('every bubble has a placed peak', positions.length, gradients);
const parked = positions.filter(([x, y]) => x > 15 && x < 85 && y > 15 && y < 85);
check('  ...and none is parked in the middle of the screen', parked, []);

done();
