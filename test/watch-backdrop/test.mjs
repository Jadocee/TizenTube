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

const APP_RULES = readRepo('test', 'watch-backdrop', 'app-rules.captured.css');

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
async function centrePixel({ appQualityRoot = true, scrim = false, mod = true, extra = '' }) {
    const body = [
        'WEB_PAGE_TYPE_WATCH',
        'landscape',
        'full-animation',
        appQualityRoot ? 'app-quality-root' : '',
    ]
        .filter(Boolean)
        .join(' ');
    const playerClasses = [
        's3u3Oc',
        'iLKnN',
        'ExC9Fb',
        ...(scrim ? ['Vdm04', 'YW4uOd', 'g511Kb'] : []),
    ];
    await page.setContent(
        `<style>html{font-size:16px}${APP_RULES}${mod ? `\n${MOD_RULES}` : ''}</style>` +
            `<body class="${body}">` +
            '<div id="app-background"></div>' +
            '<div id="container">' +
            '<ytlr-player-container class="Gy3ftf">' +
            `<ytlr-player class="${playerClasses.join(' ')}">` +
            '<div class="aeeFdf"><div id="ytlr-player__player-container">' +
            `<video class="video-stream" style="width:100%;height:100%;background:${VIDEO}"></video>` +
            '</div></div></ytlr-player></ytlr-player-container></div>' +
            extra +
            '</body>',
    );
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

// --- the regression: app-quality-root ---------------------------------------
// ui.ts used to run a MutationObserver stripping this class off <body> on every
// attribute change. It reads as a cosmetic flag and is not one: the app uses it
// to turn OFF its own legacy scrim fills, including
// `.Vdm04.YW4uOd:before{background:#030303;height:100%;width:100%}` at z-index 1
// on ytlr-player -- over the video, under the chrome.
check(
    'with the class, a scrimmed player shows the video',
    await centrePixel({ scrim: true }),
    VIDEO,
);
check(
    '  ...without it, the scrim covers the video',
    await centrePixel({ scrim: true, appQualityRoot: false }),
    'rgb(3, 3, 3)',
);
check(
    '  ...and with no scrim the class makes no difference',
    await centrePixel({ scrim: false, appQualityRoot: false }),
    VIDEO,
);

// The assertion that actually guards the fix. The rendering above explains WHY
// this matters; this is what fails if anyone reinstates the observer.
const uiSrc = readRepo('mods', 'ui', 'ui.ts');
const stripped = uiSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
check(
    'the mod never removes app-quality-root',
    /remove\(\s*['"]app-quality-root['"]\s*\)/.test(stripped),
    false,
);
check('  ...by any spelling', /app-quality-root/.test(stripped.replace(/classList/g, '')), false);

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
