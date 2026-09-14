// The preview indicator's stylesheet, in a real browser.
//
// Two of these checks exist because of specific ways this class of change goes
// wrong on a television and nowhere else. A rule that never matches must show
// NOTHING rather than parking a disc in the corner, so there is a negative
// control. And the element is appended to document.body, which inherits the
// app's direction -- rtl for an Arabic account -- so a logical inset would put
// the mark off the opposite edge, exactly the trap clock.css already records.
import {
    chromium as findChromium,
    chromiumExecutable,
    skip,
    readRepo,
    checker,
} from '../lib/repo.mjs';

const chromium = await findChromium();
if (!chromium) skip('Playwright is not installed; this harness needs a real browser');

const css = readRepo('mods', 'ui', 'previewIndicator.css');
// Scanned with comments stripped. The file EXPLAINS why it uses physical
// properties rather than logical ones, so it names inset-inline and
// border-inline in prose -- and the checks below, matched against the raw text,
// found those and reported the file as violating its own rule.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
const { check, done } = checker();

// --- what the source itself must not contain --------------------------------
// Written so it cannot pass vacuously: the set of transitioned properties has to
// be non-empty AND a subset of the compositor-only ones. A file that transitions
// nothing would otherwise satisfy "subset of" trivially.
const transitioned = new Set();
for (const declaration of code.matchAll(/transition:\s*([^;}]+)/g)) {
    for (const part of declaration[1].split(',')) {
        const property = part.trim().split(/\s+/)[0];
        if (property && property !== 'none') transitioned.add(property);
    }
}
check('something is actually transitioned', transitioned.size > 0, true);
check(
    '  ...and only compositor-only properties are',
    [...transitioned].filter((p) => !['opacity', 'transform', 'visibility'].includes(p)),
    [],
);
// A glyph in the same place on every focused tile, animating forever, is what an
// OLED holds on to -- so the one infinite animation this file has is fenced in
// two directions. It may only be the LOADING glyph, a state previewState.ts
// retires after LOADING_TIMEOUT_MS, and it must stop under reduced motion.
const infinites = [...code.matchAll(/([^{}]*)\{[^{}]*\binfinite\b[^{}]*\}/g)].map((m) =>
    m[1].trim(),
);
check('at most one thing animates forever', infinites.length <= 1, true);
check(
    '  ...and only in the loading state',
    infinites.every((sel) => sel.includes('[data-state="loading"]')),
    true,
);
// Asserted in the browser at the end of this file, under emulated reduced
// motion, rather than by matching the text here. A whole-file regex passes on
// any file that merely CONTAINS those three fragments in that order -- in
// unrelated blocks, in a rule the cascade overrides, or with a selector that
// never matches the element. It is the shape of check that reports a stylesheet
// as compliant with its own comment while the television spins anyway.
// The spinner is only honest if something ends it. This is a source check rather
// than a browser one because the timeout lives in previewState.ts, whose own
// harness proves it fires -- what is asserted here is that the two agree the
// state exists at all.
check('the loading state is a real state', /\[data-state="loading"\]/.test(code), true);
// Logical properties inherit the app's direction. Physical ones do not.
check('placement uses no logical insets', /inset-inline|inset-block/.test(code), false);
check('the spinner uses no logical borders', /border-inline|border-block/.test(code), false);

// The three marks previewIndicator.ts builds, as one string used by both pages
// below -- the fixture is a COPY of the real markup, and two copies drift twice
// as fast as one.
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"';
const PLAY_ARROW_PATH = 'M8 5v14l11-7z';
const VOLUME_UP_PATH =
    'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
// The countdown span was MISSING from this fixture for the whole life of the
// countdown: previewIndicator.ts builds glyph, play, time, sound, and this
// string built three of the four. Every check below therefore ran against a
// pill one element narrower than the real one. It is here now, and the hook
// tripwire below has grown the two names that would catch it going again.
const MARKS =
    '<span class="tt-pi-glyph"></span>' +
    `<svg class="tt-pi-play" ${ICON_ATTRS}><path d="${PLAY_ARROW_PATH}"/></svg>` +
    '<span class="tt-pi-time">0:40</span>' +
    `<svg class="tt-pi-sound" ${ICON_ATTRS}><path d="${VOLUME_UP_PATH}"/></svg>`;
/** The progress bar, likewise a copy of what previewIndicator.ts builds. */
const BAR = '<div class="tt-pp-fill"></div>';

const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0b0b0b}html{font-size:16px}
  /* Stand-ins for whatever is on the page underneath. Their boxes are what the
     layout-neutrality check compares. */
  .fixture{width:300px;height:170px;display:inline-block;margin:8px}</style>
<style id="tt">${css}</style></head><body>
  <div class="fixture" id="f1"></div><div class="fixture" id="f2"></div>
  <div id="tizentube-preview-indicator" class="tt-dimmable">${MARKS}</div>
  <div id="tizentube-preview-progress" class="tt-dimmable">${BAR}</div>
</body></html>`);

// The markup above is a COPY of what previewIndicator.ts builds, and a copy is
// only safe while something notices it going stale.
//
// WHAT THIS GUARD IS AND IS NOT. It is a substring tripwire: it catches a hook
// disappearing from the source entirely, and nothing subtler. Renaming
// `setAttribute('data-state', ...)` while `removeAttribute('data-state')`
// survives still passes here -- measured, not assumed. The real coverage for
// that is preview-indicator/runtime.mjs, which executes this module and reads
// the attributes back; the entries below are listed because the fixture depends
// on them, not because this loop proves they work. It went stale once already:
// the source grew a second glyph and gained class names, and this fixture kept
// its lone bare <span> -- so every check below went on passing against a DOM the
// mod no longer produces. Nothing is derived here because the builder sits
// behind four imports, so the guard is the next best thing: every hook the
// fixture and the CSS rely on has to be present in the real source.
const source = readRepo('mods', 'ui', 'previewIndicator.ts');
for (const hook of [
    'tizentube-preview-indicator',
    'tt-pi-glyph',
    'tt-pi-play',
    'tt-pi-time',
    'tt-pi-sound',
    'data-state',
    'data-sound',
    'data-time',
    'tizentube-preview-progress',
    'tt-pp-fill',
    '--tt-pp-x',
    '--tt-pp-y',
    '--tt-pp-w',
]) {
    if (!source.includes(hook)) {
        console.log(
            `FAIL  previewIndicator.ts no longer produces "${hook}"; this fixture is stale`,
        );
        process.exit(1);
    }
}

// The fixture's icons are a copy too, and the class-name tripwire above would
// not notice the mod drawing a DIFFERENT path under the same class -- which is
// the whole point of using the icon set rather than something hand-drawn. So the
// exact path data the fixture asserts against has to appear in the source.
// Measured: changing the `d` in previewIndicator.ts while leaving this out went
// undetected.
for (const [name, path] of [
    ['PlayArrow', PLAY_ARROW_PATH],
    ['VolumeUp', VOLUME_UP_PATH],
]) {
    check(`the mod draws Material ${name}`, source.includes(path), true);
}

const px = (v) => parseFloat(v) || 0;
const styles = (sel, props) =>
    page.evaluate(
        ([s, p]) => {
            const el = document.querySelector(s);
            if (!el) return null;
            const cs = getComputedStyle(el);
            return Object.fromEntries(p.map((k) => [k, cs.getPropertyValue(k)]));
        },
        [sel, props],
    );

// --- did the nested block parse at all? -------------------------------------
// If the browser rejected the nesting, every check below is meaningless.
const chip = await styles('#tizentube-preview-indicator', [
    'background-color',
    'position',
    'pointer-events',
    'visibility',
    'opacity',
    'color',
    'border-radius',
]);
check(
    'nesting parsed (the disc has its fill)',
    chip !== null && chip['background-color'] !== 'rgba(0, 0, 0, 0)',
    true,
);

// --- the negative control ---------------------------------------------------
// With no data-state the mark must be invisible. Without this a rule that never
// matches on a real television would pass every other check here.
check('with no state it is hidden', chip.visibility, 'hidden');
check('  ...and fully transparent', px(chip.opacity), 0);

// --- it can never perturb the page ------------------------------------------
check('it is out of flow', chip.position, 'fixed');
check('it cannot take a press', chip['pointer-events'], 'none');

const neutrality = await page.evaluate(() => {
    const boxes = () =>
        [...document.querySelectorAll('.fixture')].map((e) => {
            const r = e.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height];
        });
    const withChip = { boxes: boxes(), scroll: document.documentElement.scrollHeight };
    // BOTH of the mod's elements, because both are appended to document.body and
    // either one taking part in layout would move the page under them.
    const nodes = ['tizentube-preview-indicator', 'tizentube-preview-progress'].map((id) =>
        document.getElementById(id),
    );
    nodes.forEach((n) => n.remove());
    const without = { boxes: boxes(), scroll: document.documentElement.scrollHeight };
    nodes.forEach((n) => document.body.appendChild(n));
    return { withChip, without };
});
check(
    'every other box is identical with and without it',
    JSON.stringify(neutrality.withChip.boxes),
    JSON.stringify(neutrality.without.boxes),
);
check('  ...and so is the page height', neutrality.withChip.scroll, neutrality.without.scroll);

// --- the states -------------------------------------------------------------
// The fade is real, so a computed opacity read immediately after the attribute
// changes is the mid-transition value -- which is ~0 and looks exactly like the
// rule not applying at all. Settle it first, and assert separately that it was
// in fact animating.
const setState = async (value) =>
    await page.evaluate(async (v) => {
        const node = document.getElementById('tizentube-preview-indicator');
        // Force a recalc first, so the change below has a "before" value to
        // transition FROM. Without it the transition may never be created.
        getComputedStyle(node).opacity;
        node.setAttribute('data-state', v);
        // Two frames, so the style change has committed and the transition has
        // actually been started rather than merely scheduled.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const running = node.getAnimations().length;
        // Settle it, so the computed values read afterwards are the final ones
        // rather than wherever the fade happens to be.
        node.getAnimations().forEach((a) => a.finish());
        return running;
    }, value);
const fadeStarted = await setState('playing');
const playing = await styles('#tizentube-preview-indicator', [
    'visibility',
    'opacity',
    'width',
    'height',
]);
check('playing makes it visible', playing.visibility, 'visible');
check('  ...at full opacity', px(playing.opacity), 1);

// Asserted as "a transition exists", not as a mid-flight opacity: reading
// computed style in the same synchronous block as the attribute change forces a
// recalc that resolves to the FINAL value, so a value probe measures when the
// engine recalculates rather than whether anything animates.
check('showing it starts a transition rather than snapping', fadeStarted > 0, true);

await setState('stalled');
const stalled = await styles('#tizentube-preview-indicator', ['visibility', 'opacity', 'filter']);
check('stalled stays visible', stalled.visibility, 'visible');
// A FILTER, NOT OPACITY. ui.ts's idle dimming stamps `opacity` inline with
// !important on every .tt-dimmable element, and both of the mod's preview
// elements are .tt-dimmable -- so a stall dim written as opacity is silently
// overridden for exactly the people who turned screen dimming on. Asserted as
// the computed filter so that swapping it back would fail here.
const dimmed = (filter) => {
    const m = /opacity\((\d*\.?\d+)\)/.exec(filter || '');
    return !!m && Number(m[1]) < 1 && Number(m[1]) > 0;
};
check('  ...but reads as dimmed', dimmed(stalled.filter), true);
check('  ...without touching opacity, which ui.ts owns', px(stalled.opacity), 1);

// --- big enough to resolve across a room ------------------------------------
// THE FLOOR IS A FRACTION OF THE APP'S OWN PAGE, because that is the only frame
// of reference the captured assets actually establish. `.R7cAXb{width:80rem;
// height:45rem}` is the box leanback lays itself out in, so "an eighteenth of
// the screen's height" holds whatever the panel does with a CSS pixel.
//
// The check this replaces was `>= 48px at a 16px root`, and the comment above it
// reasoned about arcminutes at three metres from a root font of 24px at 1920.
// Nothing in the app says the root is 24px: main.css sets
// `body,html{font-size:100%}`, neither main.js nor base.js writes
// documentElement.style.fontSize, and tv.html has no viewport meta. That was the
// repo's own assumption being fed back to itself as evidence, so it is gone
// rather than restated in units that flatter the new number.
//
// It IS a reduction: 3rem was a fifteenth of the page height, 2.5rem is an
// eighteenth. What changed is the job -- a fifteenth is what a mark needs when
// it is the ONLY evidence a preview is running, and the bar now carries that
// across the full width of the thumbnail.
const PAGE_HEIGHT_REM = 45; // .R7cAXb, the app's own page box
check(
    "the badge is at least an eighteenth of the app's page height",
    px(playing.width) / 16 >= PAGE_HEIGHT_REM / 18 && playing.width === playing.height,
    true,
);
const boxOf = async (selector) =>
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, display: getComputedStyle(el).display };
    }, selector);

await setState('playing');
// Material's PlayArrow, asserted by the path it draws and not merely by being
// present: an SVG with the wrong `d` is still an SVG, and the point of using the
// icon set is that these are the shapes people recognise from every other
// player.
const play = await page.evaluate(() => {
    const el = document.querySelector('#tizentube-preview-indicator > .tt-pi-play');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
        tag: el.tagName.toLowerCase(),
        width: r.width,
        height: r.height,
        display: getComputedStyle(el).display,
        fill: getComputedStyle(el).fill,
        viewBox: el.getAttribute('viewBox'),
        path: el.querySelector('path')?.getAttribute('d'),
        hidden: el.getAttribute('aria-hidden'),
    };
});
check('the play mark is an svg', play?.tag, 'svg');
check('  ...actually drawn', play.width > 0 && play.height > 0, true);
check('  ...on the Material 24 grid', play.viewBox, '0 0 24 24');
check('  ...drawing Material PlayArrow', play.path, PLAY_ARROW_PATH);
// currentColor is what makes the mark dim with the rest of the indicator rather
// than staying the one bright thing on a dimmed screen.
check('  ...filled with the inherited colour', play.fill, 'rgb(241, 241, 241)');
check('  ...and hidden from screen readers', play.hidden, 'true');
const triangle = { width: play.width, height: play.height };

// --- loading ----------------------------------------------------------------
// The state that did not exist before. A preview takes a real moment to arrive
// on a television, and without this the mark claimed playback from the instant
// the app was ASKED to play -- so a focused tile looked identical whether the
// preview was coming or had silently failed.
await setState('loading');
const loading = await styles('#tizentube-preview-indicator', ['visibility', 'opacity']);
check('loading is visible', loading.visibility, 'visible');
check('  ...at full opacity', px(loading.opacity), 1);

const spinner = await page.evaluate(() => {
    const el = document.querySelector('#tizentube-preview-indicator > .tt-pi-glyph');
    const cs = getComputedStyle(el);
    // PAUSED BEFORE MEASURING, and then measured from the computed size rather
    // than the painted box. A rotating square's bounding rect is
    // s*(|cos t|+|sin t|), so getBoundingClientRect returned a different number
    // on every run -- which made "the spinner is not the play mark" pass
    // whatever the two declared sizes were, including identical ones. Measured:
    // setting .tt-pi-play to the spinner's exact size still passed.
    el.getAnimations().forEach((a) => a.pause());
    const r = el.getBoundingClientRect();
    return {
        width: parseFloat(cs.inlineSize),
        painted: r.width,
        height: parseFloat(cs.blockSize),
        radius: cs.borderTopLeftRadius,
        // A ring is only a ring if the four border colours are not all equal --
        // that is what makes the rotation legible rather than a spinning circle
        // that looks static.
        colours: new Set([
            cs.borderTopColor,
            cs.borderRightColor,
            cs.borderBottomColor,
            cs.borderLeftColor,
        ]).size,
        animations: el.getAnimations().length,
    };
});
check('the spinner is drawn', spinner.width > 0 && spinner.height > 0, true);
check('  ...and actually painted', spinner.painted > 0, true);
check('  ...as a ring', spinner.radius !== '0px', true);
check('  ...with a visible leading edge', spinner.colours > 1, true);
check('  ...and it is actually rotating', spinner.animations > 0, true);

// They are now separate elements, so the risk is the opposite one: both showing
// at once, which would stack a spinner on top of a play mark.
const bothAtOnce = await page.evaluate(() => {
    const shown = (sel) =>
        getComputedStyle(document.querySelector(`#tizentube-preview-indicator > ${sel}`))
            .display !== 'none';
    return { glyph: shown('.tt-pi-glyph'), play: shown('.tt-pi-play') };
});
check('loading shows the spinner', bothAtOnce.glyph, true);
check('  ...and not the play mark as well', bothAtOnce.play, false);
// Declared sizes, not painted boxes -- see the note in the spinner block above.
check('the spinner is not the play mark', spinner.width !== triangle.width, true);

// --- sound ------------------------------------------------------------------
// Only ever drawn when previewState.soundState() returned 'audible'. A speaker
// on a silent video sends someone hunting for audio that was never there.
await setState('playing');
const silentSpeaker = await boxOf('#tizentube-preview-indicator > .tt-pi-sound');
check('no speaker without the attribute', silentSpeaker.display, 'none');

const withSound = await page.evaluate(async () => {
    const node = document.getElementById('tizentube-preview-indicator');
    node.setAttribute('data-sound', 'on');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    node.getAnimations().forEach((a) => a.finish());
    const speaker = document.querySelector('#tizentube-preview-indicator > .tt-pi-sound');
    const sr = speaker.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    return {
        speaker: {
            tag: speaker.tagName.toLowerCase(),
            width: sr.width,
            height: sr.height,
            display: getComputedStyle(speaker).display,
            fill: getComputedStyle(speaker).fill,
            viewBox: speaker.getAttribute('viewBox'),
            path: speaker.querySelector('path')?.getAttribute('d'),
        },
        pill: { width: nr.width, height: nr.height },
    };
});
check('the speaker appears', withSound.speaker.display !== 'none', true);
check('  ...as an svg', withSound.speaker.tag, 'svg');
check(
    '  ...and is actually drawn',
    withSound.speaker.width > 0 && withSound.speaker.height > 0,
    true,
);
check('  ...on the Material 24 grid', withSound.speaker.viewBox, '0 0 24 24');
check('  ...drawing Material VolumeUp', withSound.speaker.path, VOLUME_UP_PATH);
check('  ...filled with the inherited colour', withSound.speaker.fill, 'rgb(241, 241, 241)');

check('sound widens the disc into a pill', withSound.pill.width > withSound.pill.height, true);

// ...which is exactly why the mark has to be re-placed when the speaker appears.
// The placement clamp keeps it inside the viewport, and it last ran while this
// was still a disc -- so a pill positioned with the disc's width hangs past the
// edge it was clamped to. Asserted here as the SIZE CHANGE that makes the
// re-place necessary; that previewIndicator.ts actually re-places is asserted by
// the source check below, since the runtime is not loaded in this page.
// px(): `playing` comes from getComputedStyle and is the string "64px", while
// pill.width is a number off getBoundingClientRect. Subtracting them raw yields
// NaN, and NaN >= 24 is false -- an assertion that fails for the wrong reason is
// only marginally better than one that passes for the wrong reason.
check('  ...by enough to matter', withSound.pill.width - px(playing.width) >= 24, true);
check(
    'the runtime re-places the mark when the speaker appears',
    /sound = next;[\s\S]{0,600}?place\(\);/.test(source),
    true,
);
check('  ...and the disc was square without it', playing.width === playing.height, true);

// --- readable over arbitrary video ------------------------------------------
const luminance = (rgb) => {
    const [r, g, b] = rgb
        .match(/\d+(\.\d+)?/g)
        .slice(0, 3)
        .map(Number)
        .map((v) => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
};
// The disc is translucent and sits over arbitrary video, so what the triangle is
// actually read against is the disc's fill composited over whatever is behind
// it. Worst case for light ink is the brightest possible backdrop, so composite
// over white. Measured from the element's own computed fill rather than a
// literal copy of the colour, which would have to be kept in sync by hand.
const over = (rgba, backdrop) => {
    const parts = rgba.match(/\d+(\.\d+)?/g).map(Number);
    const alpha = parts.length > 3 ? parts[3] : 1;
    return `rgb(${parts
        .slice(0, 3)
        .map((c) => c * alpha + backdrop * (1 - alpha))
        .join(', ')})`;
};
check(
    'the triangle clears 3:1 against the worst backdrop',
    contrast(chip.color, over(chip['background-color'], 255)) >= 3,
    true,
);

// --- the progress bar -------------------------------------------------------
// Every expected value here is READ OUT OF THE APP'S OWN STYLESHEET rather than
// chosen, because the request was for the bar YouTube draws:
//   .zIOpyc{background-color:rgba(255,255,255,0.3);height:.25rem;overflow:hidden;...}
//   .OlEbwe{background-color:#e1002d;transform:scaleX(0);transition:transform .25s linear;
//           transform-origin:left;...}
// A drift away from those is a drift away from looking like the thing it is
// meant to look like, which no amount of "it still renders" would catch.
const APP_TRACK = 'rgba(255, 255, 255, 0.3)';
const APP_FILL = 'rgb(225, 0, 45)';

const barIdle = await styles('#tizentube-preview-progress', [
    'visibility',
    'opacity',
    'position',
    'pointer-events',
    'background-color',
    'height',
    'overflow-x',
]);
// The negative control, same as the badge's: a rule that never matches must draw
// nothing rather than park a grey line across the screen.
check('with no state the bar is hidden', barIdle.visibility, 'hidden');
check('  ...and fully transparent', px(barIdle.opacity), 0);
check('the bar is out of flow', barIdle.position, 'fixed');
check('  ...and cannot take a press', barIdle['pointer-events'], 'none');
check("  ...with the app's own track colour", barIdle['background-color'], APP_TRACK);
check("  ...and the app's own thickness", px(barIdle.height), 4);
check('  ...clipping its fill', barIdle['overflow-x'], 'hidden');

const barGeometry = await page.evaluate(async () => {
    const node = document.getElementById('tizentube-preview-progress');
    const fill = node.querySelector('.tt-pp-fill');
    node.style.setProperty('--tt-pp-x', '400px');
    node.style.setProperty('--tt-pp-y', '620px');
    node.style.setProperty('--tt-pp-w', '300px');
    node.setAttribute('data-state', 'playing');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    node.getAnimations().forEach((a) => a.finish());
    const read = () => {
        const b = node.getBoundingClientRect();
        const f = fill.getBoundingClientRect();
        return {
            bar: { left: b.left, bottom: b.bottom, width: b.width, height: b.height },
            fill: { left: f.left, width: f.width },
        };
    };
    const empty = read();
    // transform-origin: left is the whole reason this is not a width. Half a
    // bar has to start at the same place the empty one does and be half as
    // wide -- a centred origin would grow it out of both ends of the tile.
    fill.style.transitionDuration = '0ms';
    fill.style.transform = 'scaleX(0.5)';
    await new Promise((r) => requestAnimationFrame(r));
    const half = read();
    const cs = getComputedStyle(fill);
    return {
        empty,
        half,
        fillColour: cs.backgroundColor,
        origin: cs.transformOrigin,
        visibility: getComputedStyle(node).visibility,
        opacity: getComputedStyle(node).opacity,
    };
});
check('playing shows the bar', barGeometry.visibility, 'visible');
check('  ...at full opacity', px(barGeometry.opacity), 1);
check('  ...as wide as the box it was given', barGeometry.empty.bar.width, 300);
check("  ...at that box's left edge", barGeometry.empty.bar.left, 400);
// The y it is handed is the box's BOTTOM edge, and the element sits ON it. That
// is what keeps previewState.barBox ignorant of the thickness declared here.
check('  ...with its own bottom on the edge it was given', barGeometry.empty.bar.bottom, 620);
check("  ...and the app's fill colour", barGeometry.fillColour, APP_FILL);
check('an empty bar paints nothing', barGeometry.empty.fill.width, 0);
check('a half bar is half as wide', barGeometry.half.fill.width, 150);
check('  ...growing from the left edge, not the middle', barGeometry.half.fill.left, 400);
check('  ...because the origin is the left edge', barGeometry.origin.split(' ')[0], '0px');

const barStalled = await page.evaluate(async () => {
    const node = document.getElementById('tizentube-preview-progress');
    node.setAttribute('data-state', 'stalled');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    node.getAnimations().forEach((a) => a.finish());
    const cs = getComputedStyle(node);
    return { visibility: cs.visibility, opacity: cs.opacity, filter: cs.filter };
});
check('a stalled bar stays visible', barStalled.visibility, 'visible');
check('  ...but reads as dimmed', dimmed(barStalled.filter), true);
check('  ...by the same filter, for the same reason', px(barStalled.opacity), 1);

// --- the values the runtime depends on ---------------------------------------
// Four declarations the mod's own comments call load-bearing, none of which had
// an assertion: each could be deleted with the whole suite still green.
const loadBearing = await page.evaluate(() => {
    const bar = document.getElementById('tizentube-preview-progress');
    const fill = bar.querySelector('.tt-pp-fill');
    const badge = document.getElementById('tizentube-preview-indicator');
    // The geometry probe above suppressed the transition inline to measure a
    // half-filled bar, exactly as armBar does on the device. Clear that first,
    // or this reads the probe's override rather than the stylesheet.
    fill.style.transitionDuration = '';
    const cs = getComputedStyle(fill);
    return {
        // previewIndicator.ts writes the fill's transform in ~4Hz steps off
        // timeupdate and relies on this to draw the crawl between them. Without
        // it the bar jumps a quarter-second at a time.
        transitionProperty: cs.transitionProperty,
        transitionDuration: cs.transitionDuration,
        transitionTiming: cs.transitionTimingFunction,
        barZ: getComputedStyle(bar).zIndex,
        badgeZ: getComputedStyle(badge).zIndex,
        // The ring this file removed; the shadow is what replaced it as the
        // thing separating a dark disc from a bright thumbnail.
        badgeShadow: getComputedStyle(badge).boxShadow,
        badgeBorder: getComputedStyle(badge).borderTopWidth,
    };
});
check('the fill transitions its transform', loadBearing.transitionProperty, 'transform');
check("  ...over the app's own quarter second", loadBearing.transitionDuration, '0.25s');
check('  ...linearly, so the crawl is even', loadBearing.transitionTiming, 'linear');
// Both overlays sit above the app's player surface, which the mod itself only
// ever raises to 10 (pictureInPicture.ts).
check('the bar is above the player', Number(loadBearing.barZ) >= 900, true);
check('  ...and so is the badge', Number(loadBearing.badgeZ) >= 900, true);
check('the badge has a shadow to separate it', loadBearing.badgeShadow !== 'none', true);
check('  ...and no ring any more', px(loadBearing.badgeBorder), 0);

// --- right-to-left ----------------------------------------------------------
// The element inherits the app's direction. clock.css records this trap; the
// judges caught it in three separate proposals.
const rtl = await page.evaluate(() => {
    const node = document.getElementById('tizentube-preview-indicator');
    node.style.setProperty('--tt-pi-x', '400px');
    node.style.setProperty('--tt-pi-y', '200px');
    const box = () => {
        const r = node.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
    };
    const glyphBox = () => {
        const r = node.querySelector('span').getBoundingClientRect();
        return [Math.round(r.left - node.getBoundingClientRect().left), r.width, r.height];
    };
    document.documentElement.dir = 'ltr';
    const ltr = { chip: box(), glyph: glyphBox() };
    document.documentElement.dir = 'rtl';
    const right = { chip: box(), glyph: glyphBox() };
    document.documentElement.dir = 'ltr';
    return { ltr, rtl: right };
});
check(
    'the mark lands in the same place under rtl',
    JSON.stringify(rtl.rtl.chip),
    JSON.stringify(rtl.ltr.chip),
);

// The sound pill has TWO children, and a flex row follows `direction` -- so
// under rtl they swap and the speaker leads the triangle. This is the same trap
// as the one above, one level in, and it only became reachable when the second
// glyph was added.
const rtlSound = await page.evaluate(async () => {
    const node = document.getElementById('tizentube-preview-indicator');
    node.setAttribute('data-state', 'playing');
    node.setAttribute('data-sound', 'on');
    await new Promise((r) => requestAnimationFrame(r));
    const order = () => {
        const g = document.querySelector('#tizentube-preview-indicator > .tt-pi-glyph');
        const p = document.querySelector('#tizentube-preview-indicator > .tt-pi-sound');
        return g.getBoundingClientRect().left < p.getBoundingClientRect().left
            ? 'glyph-first'
            : 'sound-first';
    };
    document.documentElement.dir = 'ltr';
    const ltr = order();
    document.documentElement.dir = 'rtl';
    const right = order();
    document.documentElement.dir = 'ltr';
    node.removeAttribute('data-sound');
    return { ltr, rtl: right };
});
check('the triangle leads the speaker', rtlSound.ltr, 'glyph-first');
check('  ...under rtl too', rtlSound.rtl, rtlSound.ltr);
check(
    '  ...and the triangle still points the same way',
    JSON.stringify(rtl.rtl.glyph),
    JSON.stringify(rtl.ltr.glyph),
);
check('  ...at the coordinates it was given', rtl.ltr.chip[0], 400);

// The bar is the same trap again, and the one with the most to lose from it: a
// fill that started from the wrong end would run the progress backwards across
// every tile for an Arabic account, which looks like a feature rather than a
// bug and so would never be reported as one.
const rtlBar = await page.evaluate(async () => {
    const node = document.getElementById('tizentube-preview-progress');
    const fill = node.querySelector('.tt-pp-fill');
    node.setAttribute('data-state', 'playing');
    fill.style.transitionDuration = '0ms';
    fill.style.transform = 'scaleX(0.5)';
    const read = () => {
        const b = node.getBoundingClientRect();
        const f = fill.getBoundingClientRect();
        return [b.left, b.bottom, b.width, f.left, f.width];
    };
    document.documentElement.dir = 'ltr';
    await new Promise((r) => requestAnimationFrame(r));
    const ltr = read();
    document.documentElement.dir = 'rtl';
    await new Promise((r) => requestAnimationFrame(r));
    const right = read();
    document.documentElement.dir = 'ltr';
    return { ltr, rtl: right };
});
check(
    'the bar lands in the same place under rtl',
    JSON.stringify(rtlBar.rtl),
    JSON.stringify(rtlBar.ltr),
);

// --- the fade-out is real ----------------------------------------------------
// Both elements have always CLAIMED a 160ms fade and never had one: `visibility`
// was flipped to hidden in the same frame the state attribute went away, so the
// opacity transition ran behind something that had stopped painting. Asserted as
// the thing that was false -- still painting, part-way down -- rather than as
// the presence of a transition property, which was there all along.
const fadeOut = await page.evaluate(async () => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const read = async (id) => {
        const node = document.getElementById(id);
        node.setAttribute('data-state', 'playing');
        await frames();
        node.getAnimations().forEach((a) => a.finish());
        node.removeAttribute('data-state');
        await frames();
        const cs = getComputedStyle(node);
        return { visibility: cs.visibility, opacity: Number(cs.opacity) };
    };
    return {
        badge: await read('tizentube-preview-indicator'),
        bar: await read('tizentube-preview-progress'),
    };
});
const fading = (r) => r.visibility === 'visible' && r.opacity < 1 && r.opacity > 0;
check('the badge is still painting while it fades', fading(fadeOut.badge), true);
check('  ...and so is the bar', fading(fadeOut.bar), true);

// --- the blocks are concatenated with no separator --------------------------
// styleSheet.ts joins named blocks by string concatenation, so one unbalanced
// brace swallows every block after it: the single failure that takes out all of
// TizenTube's styling at once, on a device with no console.
const clockCss = readRepo('mods', 'ui', 'clock.css');
const uiCss = readRepo('mods', 'ui', 'ui.css');
const ruleCount = await page.evaluate(
    async (sheets) => {
        const count = (text) => {
            const style = document.createElement('style');
            style.textContent = text;
            document.head.appendChild(style);
            const n = style.sheet ? style.sheet.cssRules.length : -1;
            style.remove();
            return n;
        };
        return {
            parts: sheets.map(count),
            joined: count(sheets.join('')),
        };
    },
    [clockCss, css, uiCss],
);
check(
    'each block parses on its own',
    ruleCount.parts.every((n) => n > 0),
    true,
);
check(
    'concatenating them loses no rules',
    ruleCount.joined,
    ruleCount.parts.reduce((a, b) => a + b, 0),
);

// --- reduced motion, emulated for real ---------------------------------------
// The spinner is the one thing in this file that animates forever, and an OLED
// holds on to whatever sits in the same screen position. Someone who has asked
// their television to stop animating things has to actually get that -- and the
// only way to know is to ask the engine, with the media feature switched on,
// whether the element has a running animation.
const reduced = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    reducedMotion: 'reduce',
});
await reduced.setContent(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0b0b0b}html{font-size:16px}</style>
<style id="tt">${css}</style></head><body>
  <div id="tizentube-preview-indicator" class="tt-dimmable" data-state="loading">${MARKS}</div>
</body></html>`);
const motion = await reduced.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.querySelector('#tizentube-preview-indicator > .tt-pi-glyph');
    const cs = getComputedStyle(el);
    return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        running: el.getAnimations().length,
        name: cs.animationName,
        // The ring itself must survive: the SHAPE is what distinguishes loading
        // from a solid triangle, and the motion only draws the eye. Stopping the
        // rotation must not leave the state indistinguishable.
        radius: cs.borderTopLeftRadius,
        width: el.getBoundingClientRect().width,
    };
});
check('reduced motion is actually emulated', motion.matches, true);
check('  ...and the spinner does not rotate', motion.running, 0);
check('  ...with no animation applied at all', motion.name, 'none');
check('  ...but the ring is still drawn', motion.width > 0 && motion.radius !== '0px', true);
await reduced.close();

await browser.close();
done();
