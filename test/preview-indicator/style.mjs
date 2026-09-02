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
check('the triangle uses no logical borders', /border-inline|border-block/.test(code), false);

const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0b0b0b}html{font-size:16px}
  /* Stand-ins for whatever is on the page underneath. Their boxes are what the
     layout-neutrality check compares. */
  .fixture{width:300px;height:170px;display:inline-block;margin:8px}</style>
<style id="tt">${css}</style></head><body>
  <div class="fixture" id="f1"></div><div class="fixture" id="f2"></div>
  <div id="tizentube-preview-indicator" class="tt-dimmable"><span class="tt-pi-glyph"></span><span class="tt-pi-sound"></span></div>
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
    'tt-pi-sound',
    'data-state',
    'data-sound',
]) {
    if (!source.includes(hook)) {
        console.log(
            `FAIL  previewIndicator.ts no longer produces "${hook}"; this fixture is stale`,
        );
        process.exit(1);
    }
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
    const node = document.getElementById('tizentube-preview-indicator');
    node.remove();
    const without = { boxes: boxes(), scroll: document.documentElement.scrollHeight };
    document.body.appendChild(node);
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
const stalled = await styles('#tizentube-preview-indicator', ['visibility', 'opacity']);
check('stalled stays visible', stalled.visibility, 'visible');
check('  ...but reads as dimmed', px(stalled.opacity) < 1 && px(stalled.opacity) > 0, true);

// --- big enough to resolve across a room ------------------------------------
// A floor, not the on-set value: YouTube's TV app sizes its root font at a
// fraction of the viewport, which is larger than the 16px used here.
check(
    'the disc is at least 48px square at a 16px root',
    px(playing.width) >= 48 && playing.width === playing.height,
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
const triangle = await boxOf('#tizentube-preview-indicator > .tt-pi-glyph');
check('the triangle is actually drawn', triangle.width > 0 && triangle.height > 0, true);

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
    const r = el.getBoundingClientRect();
    return {
        width: r.width,
        height: r.height,
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
check('  ...as a ring', spinner.radius !== '0px', true);
check('  ...with a visible leading edge', spinner.colours > 1, true);
check('  ...and it is actually rotating', spinner.animations > 0, true);

// The triangle and the spinner are the same element in different states, so a
// rule that matched both would draw a rotating triangle.
check('the triangle is not also a spinner', spinner.width !== triangle.width, true);

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
    const cone = getComputedStyle(speaker, '::before');
    const wave = getComputedStyle(speaker, '::after');
    return {
        speaker: { width: sr.width, height: sr.height, display: getComputedStyle(speaker).display },
        pill: { width: nr.width, height: nr.height },
        coneBorder: cone.borderRightWidth,
        waveRadius: wave.borderTopLeftRadius,
        waveClip: wave.clipPath,
    };
});
check('the speaker appears', withSound.speaker.display !== 'none', true);
check(
    '  ...and is actually drawn',
    withSound.speaker.width > 0 && withSound.speaker.height > 0,
    true,
);
check('  ...with a cone', px(withSound.coneBorder) > 0, true);
check('  ...and a wave arc', withSound.waveRadius !== '0px', true);
check('  ...clipped to one side', withSound.waveClip !== 'none', true);

// The shape change is itself part of the signal: it reads at three metres before
// either glyph resolves.
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
  <div id="tizentube-preview-indicator" class="tt-dimmable" data-state="loading"><span class="tt-pi-glyph"></span><span class="tt-pi-sound"></span></div>
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
