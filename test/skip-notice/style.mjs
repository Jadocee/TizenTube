// The notice's appearance, in a real browser.
//
// THE DEFECT THIS EXISTS FOR. The notice had a fade, and on the first notice of
// a session it did not run: measured here, getAnimations() came back empty and
// opacity computed 1 in the same frame the attribute was set. A CSS transition
// needs a previous computed style to move from, and Chromium resolves style for
// the first time only once the element is in the document -- which the DOM shell
// does in the SAME TASK that sets data-shown. So the first skip every session
// hard-cut in and every later one faded, and nothing in the suite could tell.
//
// Nothing in this repository measured skipNotice.css at all before this file.
// The Node harnesses next door drive the timing and the element's attributes
// against a fake DOM, which cannot have an opinion about whether anything moved.
import {
    chromium as findChromium,
    chromiumExecutable,
    skip,
    readRepo,
    checker,
} from '../lib/repo.mjs';

const chromium = await findChromium();
if (!chromium) skip('Playwright is not installed; this harness needs a real browser');

const css = readRepo('mods', 'ui', 'skipNotice.css');
// Comments stripped before scanning the source. This file EXPLAINS its rules in
// prose -- it names transitions and transforms in sentences about why they are
// used -- so a check matched against the raw text reads its own commentary as
// code, which is how previewIndicator's harness once reported that file as
// violating a rule it was documenting.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
const { check, done } = checker();

// --- what the source itself must not contain --------------------------------
// Only transform and opacity may move. Everything else makes a television lay
// the page out again, sixty times a second, on the thread the D-pad runs on.
const COMPOSITOR_ONLY = new Set(['opacity', 'transform', 'visibility']);
const animatedProps = new Set();
for (const decl of code.matchAll(/transition:\s*([^;}]+)/g)) {
    for (const part of decl[1].split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (name && name !== 'none') animatedProps.add(name);
    }
}
check('the stylesheet transitions something', animatedProps.size > 0, true);
check(
    '  ...and only properties that composite',
    [...animatedProps].every((p) => COMPOSITOR_ONLY.has(p)),
    true,
);

const browser = await chromium.launch({ executablePath: chromiumExecutable() });

/**
 * Builds the notice exactly as mods/ui/skipNotice.ts builds it, appends it, and
 * sets data-shown IN THE SAME TASK -- which is the whole point. Doing it across
 * two tasks would give the element a resolved style to transition from and hide
 * the defect this file exists for.
 */
const BUILD = `(text) => {
    const node = document.createElement('div');
    node.id = 'tizentube-skip-notice';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'tt-sn-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z');
    svg.appendChild(path);
    node.appendChild(svg);
    const span = document.createElement('span');
    span.className = 'tt-sn-text';
    span.textContent = text;
    node.appendChild(span);
    document.body.appendChild(node);
    node.setAttribute('data-shown', '');
    return node;
}`;

async function open({ reducedMotion = false, text = 'Skipping Sponsor' } = {}) {
    const context = await browser.newContext(
        reducedMotion ? { reducedMotion: 'reduce' } : { reducedMotion: 'no-preference' },
    );
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.setContent(
        `<!doctype html><html><head><style>
            html { font-size: 24px; }
            body { margin: 0; background: #0f0f0f; }
            ${css}
         </style></head><body></body></html>`,
    );
    // Sampled in the same frame the element is shown, before anything can
    // settle -- an animation that has already finished is indistinguishable
    // from one that never ran.
    const shown = await page.evaluate(`((build) => {
        const node = (${BUILD})(${JSON.stringify(text)});
        const anims = node.getAnimations();
        const style = getComputedStyle(node);
        return {
            animations: anims.length,
            names: anims.map((a) => (a.animationName || (a.effect && a.effect.target && '') || '')),
            opacity: style.opacity,
            transform: style.transform,
            visibility: style.visibility,
        };
    })()`);
    const settled = await page.evaluate(`(async () => {
        await new Promise((r) => setTimeout(r, 450));
        const node = document.getElementById('tizentube-skip-notice');
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return {
            opacity: style.opacity,
            transform: style.transform,
            visibility: style.visibility,
            x: Math.round(box.x),
            width: Math.round(box.width),
            right: Math.round(1920 - box.right),
        };
    })()`);
    // Then take it down and look PART WAY THROUGH. Sampling at the end would
    // find the resting state whether or not anything moved to get there.
    const leaving = await page.evaluate(`(async () => {
        const node = document.getElementById('tizentube-skip-notice');
        node.removeAttribute('data-shown');
        await new Promise((r) => setTimeout(r, 100));
        const style = getComputedStyle(node);
        return {
            animations: node.getAnimations().length,
            opacity: style.opacity,
            transform: style.transform,
            visibility: style.visibility,
        };
    })()`);
    await context.close();
    return { shown, settled, leaving };
}

// --- THE REGRESSION ---------------------------------------------------------
const first = await open();
check('the first notice of a session animates in', first.shown.animations > 0, true);
// Sampled before it could finish. An entrance that started at opacity 1 is a
// hard cut wearing an animation's name.
check('  ...starting from invisible', Number(first.shown.opacity) < 1, true);
check(
    '  ...and from somewhere other than its resting place',
    first.shown.transform !== 'none',
    true,
);
check(
    '  ...while already visible, so nothing is hidden mid-entrance',
    first.shown.visibility,
    'visible',
);

// --- and it finishes where it belongs ---------------------------------------
/**
 * No displacement and no scaling left over.
 *
 * `none` and the identity matrix mean the same thing and the browser reports
 * whichever the cascade happened to produce: an element whose transform comes
 * from a finished animation with `both` fill computes `matrix(1, 0, 0, 1, 0, 0)`
 * rather than the keyword. Asserting the literal string tested which of the two
 * mechanisms was in use, not whether anything had been left displaced.
 */
const atRest = (transform) =>
    transform === 'none' || /^matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)$/.test(transform);

check('it settles fully opaque', first.settled.opacity, '1');
check('  ...at its resting place', atRest(first.settled.transform), true);
// The negative control for the line above: the entrance really did start
// somewhere else, so "at rest" is a fact about the end rather than about a
// transform that was never applied.
check('  ...having genuinely moved to get there', atRest(first.shown.transform), false);

// --- the transform must not move it ------------------------------------------
// The pill is centred by auto margins precisely so a transform is available for
// something else. If the entrance ever shifted it off centre, this is where it
// would show.
check('it stays centred once settled', first.settled.x, first.settled.right);
check('  ...and within the title-safe box', first.settled.x > 1920 * 0.05, true);

// --- and it leaves the way it came ------------------------------------------
// The exit is the ONLY thing the resting transform on the base rule is for: the
// entrance takes its starting point from the keyframes. Delete that declaration
// and the notice fades out without moving, which nothing else here would catch.
check('taking it down starts something', first.leaving.animations > 0, true);
check('  ...that is still part way through at 100ms', Number(first.leaving.opacity) < 1, true);
check('  ...and has not finished either', Number(first.leaving.opacity) > 0, true);
check('  ...with the pill moving, not only fading', atRest(first.leaving.transform), false);
// Out is slower than in, so it is still on its way at 100ms while a 260ms
// entrance sampled at the same point would be nearly done. That asymmetry is
// deliberate -- the notice should register at once and leave quietly.
check('  ...and still visible while it goes', first.leaving.visibility, 'visible');

// --- motion is a preference --------------------------------------------------
const still = await open({ reducedMotion: true });
check('reduced motion runs no entrance', still.shown.animations, 0);
// The resting transform has to go with it. Left behind, every notice would sit
// three quarters of a rem low and slightly small, forever.
check('  ...and leaves nothing displaced', atRest(still.shown.transform), true);
// ...and takes it down at once rather than sliding it away.
check('  ...and no exit either', still.leaving.animations, 0);
check('  ...it is simply gone', still.leaving.opacity, '0');
check('  ...and the notice is still shown', still.shown.visibility, 'visible');
check('  ...fully opaque immediately', still.shown.opacity, '1');
check('  ...still centred', still.settled.x, still.settled.right);

// --- a long message still behaves -------------------------------------------
// The welcome goes through this element too, and it is much longer than a
// segment name. The stylesheet is built to wrap rather than to run off the
// screen; this is the assertion that says so.
const long = await open({
    text: 'Welcome to TizenTube 9 — Go to settings and click on TizenTube 9 Settings for settings.',
});
check('a welcome-length message stays inside the cap', long.settled.width <= 1920 * 0.74, true);
check('  ...and stays centred', long.settled.x, long.settled.right);
check('  ...and still animates in', long.shown.animations > 0, true);

await browser.close();
done();
