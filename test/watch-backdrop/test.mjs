// Whether anything the mod does puts a box over the video.
//
// THIS HARNESS WAS REWRITTEN BECAUSE THE ONE BEFORE IT COULD NOT FAIL. It built
// `<body class="..."><div id="container"></div></body>` -- no video, no player,
// no second element of any kind -- and asserted getComputedStyle(#container)
// .backgroundColor. That measures which colour WINS THE CASCADE. The question is
// whether a colour COVERS THE VIDEO, and those are different questions. It was
// green before the fix it was written for, green after, and would have been green
// under any diagnosis at all. It is what let a commit ship claiming to have fixed
// a black screen that it had not touched.
//
// The correction it was written for was itself wrong, and that is recorded below
// as an assertion rather than as a story: an opaque #container CANNOT occlude the
// player, because #container is the player's ancestor and an ancestor's background
// paints behind its descendants. Measured here so nobody re-fixes it.
//
// SO: RENDER IT AND LOOK AT THE PIXEL. Real Chromium, the app's own rules from
// app-rules.captured.css, the player subtree built the way main.js's idom template
// builds it, a <video> painted a colour nothing else in the page uses, a
// screenshot, and the centre pixel read back. A positive control proves the pixel
// test can see occlusion at all -- without it, "the video is visible" is
// indistinguishable from a broken measurement.
import { chromium, chromiumExecutable, checker, skip, readRepo } from '../lib/repo.mjs';

const launcher = await chromium();
if (!launcher) skip('Playwright with Chromium is not installed.');

// TWO captures, and the second is the one five fixes went without. main.css is
// not the whole stylesheet: the watch page ships its own in a lazy-loaded chunk,
// and the rule that was blacking out the video lives only there.
const APP_RULES = [
    readRepo('test', 'watch-backdrop', 'app-rules.captured.css'),
    readRepo('test', 'watch-backdrop', 'watch-chunk.captured.css'),
].join('\n');

// The mod's own blocks, read from source so a change there is a change here.
const themeSrc = readRepo('mods', 'ui', 'theme.ts');
const themeBlock = themeSrc.match(/setStyleBlock\(\s*'theme',\s*`([\s\S]*?)`,?\s*\)/);
if (!themeBlock) throw new Error('cannot find the theme style block in theme.ts');
const MOD_RULES = [
    themeBlock[1].replace(/\$\{[^}]*\}/g, '#0f0f0f'),
    readRepo('mods', 'ui', 'bubbles.css'),
    readRepo('mods', 'ui', 'clock.css'),
    readRepo('mods', 'ui', 'skipNotice.css'),
    readRepo('mods', 'ui', 'previewIndicator.css'),
].join('\n');

const VIDEO = 'rgb(0, 255, 0)'; // a colour nothing in either stylesheet uses
const browser = await launcher.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const { check, done } = checker();

/**
 * Build a watch page and report the colour at the centre of the video.
 *
 * The subtree is main.js's, not ours: template `alb` renders ytlr-player with
 * `e[c]=f, e.Vdm04=f, e.g511Kb=f` where f is true only when a scrim style is set
 * AND loadedPlaybackConfig.mode is 2 or 3 -- mode 2 being background playback,
 * which a home-page preview puts the player into. `scrim` below is that state.
 */
async function centrePixel({
    appQualityRoot = true,
    scrim = false,
    mod = true,
    shadow = true,
    extra = '',
}) {
    const body = [
        'WEB_PAGE_TYPE_WATCH',
        'landscape',
        'full-animation',
        appQualityRoot ? 'app-quality-root' : '',
    ]
        .filter(Boolean)
        .join(' ');
    // `scrim` is either false, or the scrim class to apply. Template `alb` sets
    // Vdm04 and g511Kb alongside whichever class Fkb maps the style to, so the
    // three always travel together.
    const scrimClass = scrim === true ? 'YW4uOd' : scrim;
    const playerClasses = [
        's3u3Oc',
        'iLKnN',
        'ExC9Fb',
        ...(scrimClass ? ['Vdm04', 'g511Kb', scrimClass] : []),
    ];
    // THE STYLESHEET ORDER IS THE APP'S, NOT THE CONVENIENT ONE. tv.html ships no
    // stylesheet: base.js registers _F_installCss, whose installer appends a
    // <style> to the END of <head> at runtime, after base.js has network-loaded.
    // The mod's element is created at body-ready, before that. So the mod's rules
    // come FIRST and lose every tie. An earlier version of this harness put them
    // in one <style> with the app's rules ahead of them -- the opposite of
    // reality -- and passed a fix that did nothing on a television.
    await page.setContent(
        `<style id="tt-mod">html{font-size:16px}${mod ? MOD_RULES : ''}</style>` +
            `<body class="${body}">` +
            '<div id="app-background"></div>' +
            '<div id="container">' +
            '<ytlr-player-container class="Gy3ftf">' +
            `<ytlr-player class="${playerClasses.join(' ')}">` +
            '<div class="aeeFdf"><div id="ytlr-player__player-container">' +
            `<video class="video-stream" style="width:100%;height:100%;background:${VIDEO}"></video>` +
            '</div></div></ytlr-player></ytlr-player-container></div>' +
            // THE WATCH CHROME, which no earlier version of this harness had, and
            // whose absence is why it stayed green through five failed fixes.
            // <ytlr-watch-page> wraps <ytlr-watch-default>, and the last child of
            // that container is the "shadow" div -- an opaque 80rem x 45rem panel
            // that the app hides with app-quality-root and nothing else.
            '<ytlr-watch-page class="YceUtc"><ytlr-watch-default class="G7qFFc">' +
            (shadow ? '<div class="XT6t8b"></div>' : '') +
            '</ytlr-watch-default></ytlr-watch-page>' +
            extra +
            '</body>',
    );
    // Exactly what _F_installCss does: append to the end of <head>, at runtime.
    await page.evaluate((css) => {
        const el = document.createElement('style');
        el.textContent = css;
        document.getElementsByTagName('HEAD')[0].appendChild(el);
    }, APP_RULES);

    const shot = await page.screenshot({ clip: { x: 636, y: 356, width: 8, height: 8 } });
    return page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(4, 4, 1, 1).data;
        return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
    }, shot.toString('base64'));
}

// --- the control, first -----------------------------------------------------
// An opaque div appended last, over everything. If this does not read as covered
// the measurement is broken and every pass below is meaningless.
check(
    'the pixel test can see an occluding element',
    await centrePixel({
        extra: '<div style="position:fixed;inset:0;z-index:99;background:#111"></div>',
    }),
    'rgb(17, 17, 17)',
);

// --- THE BUG, and it is the class removal itself ----------------------------
// The mod used to strip `app-quality-root` off <body> on every attribute change.
// The class is UNCONDITIONAL in the app -- main.js's page-class builder does
// `P.push("app-quality-root")` outside every branch -- so removing it puts the
// app into a CSS state that never occurs in the wild, losing 231 selectors from
// main.css and another 320 from the watch chunk.
//
// One of those is the whole symptom. Rendered here rather than argued.
check(
    'with the class, the chrome leaves the video alone',
    await centrePixel({ appQualityRoot: true }),
    VIDEO,
);
check(
    '  ...removing it paints the shadow panel over the video',
    await centrePixel({ appQualityRoot: false }),
    'rgb(11, 11, 11)',
);
// ISOLATED, so the assertion above names a cause rather than a coincidence: take
// that one element out of the tree and the video comes back with the class still
// removed. Nothing else in either stylesheet is doing it.
check(
    '  ...and it is .XT6t8b doing it, nothing else',
    await centrePixel({ appQualityRoot: false, shadow: false }),
    VIDEO,
);
// The colour is the app's, not ours: with the mod's own stylesheets out of the
// page entirely the panel still paints. This is not something the mod draws.
check(
    "  ...with or without the mod's own rules",
    await centrePixel({ appQualityRoot: false, mod: false }),
    'rgb(11, 11, 11)',
);

// --- the scrims, which were never the cause ---------------------------------
// Five fixes aimed here. Kept as assertions because they record what the app
// really does, and because the player scrim IS a real mechanism -- just not this
// symptom's. With the class present, every one of them leaves the video alone.
check('a scrimmed player shows the video', await centrePixel({ scrim: true }), VIDEO);
check(
    '  ...and removing the class arms that one too',
    await centrePixel({ scrim: true, appQualityRoot: false, shadow: false }),
    'rgb(3, 3, 3)',
);

// --- every scrim the app can put on the player, rendered ---------------------
// THIS REPLACED A LIST COMPARISON, because the list was compared on the wrong
// property twice. The first version cleared every app-quality-root rule that
// removed a fill, which stripped content scrims and put promo text on bare
// artwork at 1.04:1. The second kept only rules whose base was a FLAT opaque
// fill -- and shipped, leaving fifteen gradient player scrims armed. Nine of
// those cover the video, several going fully opaque across most of the frame,
// and that reached a television as "a black screen with a gradient at the
// bottom". Flat-versus-gradient was never the question; on-the-player was.
//
// So the question is asked of the renderer instead of of a selector. Fkb --
// captured from the app's own bundle -- names every scrim style and its class.
// Each one is put on ytlr-player the way template `alb` does, and the video has
// to still be there. A style YouTube adds later arrives in this list when the
// capture is refreshed, and gets rendered whether or not anyone noticed it.
const SCRIM_MAP = JSON.parse(readRepo('test', 'watch-backdrop', 'scrim-classes.captured.json'));
const scrimClasses = [...new Set(Object.values(SCRIM_MAP.styles).flat())];
const coversInStock = new Set(SCRIM_MAP.coversInStock);

check('the captured map names scrim classes', scrimClasses.length > 15, true);

for (const cls of scrimClasses) {
    const stock = await centrePixel({ scrim: cls, mod: false });
    const withMod = await centrePixel({ scrim: cls });
    if (coversInStock.has(cls)) {
        // The app hides the video here by itself: app-quality-root only recolours
        // this one rather than clearing it. Asserted so that if the app ever stops
        // doing it, this entry stops being an excuse and has to be removed.
        check(`${cls}: the app covers the video here itself`, stock !== VIDEO, true);
        continue;
    }
    check(`${cls}: stock shows the video`, stock, VIDEO);
    check(`  ...and so does the mod`, withMod, VIDEO);
}

// --- the mod must leave the class alone -------------------------------------
// The inverse of what this file used to assert. It required the removal and the
// compensating stylesheet, and it was green for the whole life of the bug.
const uiSrc = readRepo('mods', 'ui', 'ui.ts');
const uiCode = uiSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
check(
    'the mod no longer removes app-quality-root',
    /remove\(\s*['"]app-quality-root['"]\s*\)/.test(uiCode),
    false,
);
check(
    '  ...and ships no stylesheet compensating for having removed it',
    /quality-scrims|qualityScrims/.test(uiCode),
    false,
);
// The polarity that justified the removal, checked against the app's own rules
// rather than against memory. The claim was that the class makes the transport
// buttons near-black; it is what makes them transparent, and taking it away is
// what turned them black and unselectable.
const buttonFill = await page.evaluate(async (css) => {
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
    // Put the page back exactly as it was. The checks after this one read the
    // live page, and leaving the class off left the shadow panel painting --
    // which failed the #container assertion below for a reason that had nothing
    // to do with #container.
    const original = document.body.className;
    const read = (withClass) => {
        document.body.className = withClass ? 'app-quality-root' : '';
        const d = document.createElement('div');
        d.className = 'IipoN';
        document.body.appendChild(d);
        const c = getComputedStyle(d).backgroundColor;
        d.remove();
        return c;
    };
    const out = { withClass: read(true), without: read(false) };
    document.body.className = original;
    return out;
}, APP_RULES);
check('the class makes the transport button transparent', buttonFill.withClass, 'rgba(0, 0, 0, 0)');
check('  ...and removing it is what turns it near-black', buttonFill.without, 'rgb(6, 6, 6)');

// --- the correction: #container was never the culprit -----------------------
// A previous commit scoped theme.ts's fill away from the watch page to fix this
// symptom. The fill cannot produce it: #container is the player's ancestor, so
// its background paints behind everything inside it. Asserted so the next person
// to see a black screen does not spend the day there again.
const opaqueContainer = await page.evaluate(() => {
    const c = document.getElementById('container');
    c.style.setProperty('background-color', '#0f0f0f', 'important');
    return getComputedStyle(c).backgroundColor;
});
check('an opaque #container really is opaque', opaqueContainer, 'rgb(15, 15, 15)');
const shotAfter = await page.screenshot({ clip: { x: 636, y: 356, width: 8, height: 8 } });
const pixelAfter = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(4, 4, 1, 1).data;
    return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
}, shotAfter.toString('base64'));
check('  ...and still does not cover the video', pixelAfter, VIDEO);

// --- the mod's own stylesheets ----------------------------------------------
// All six are scoped to the mod's own elements or to WEB_PAGE_TYPE_BROWSE. This
// is the measured version of that claim rather than the read-the-source version.
check('the mod adds nothing over the video', await centrePixel({ mod: true }), VIDEO);
check('  ...same as without it', await centrePixel({ mod: false }), VIDEO);

await browser.close();
done();
