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

// Applied separately: whether it is present is the question two assertions ask.
const SCRIMS = readRepo('mods', 'ui', 'qualityScrims.css');

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
    scrims = false,
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
    const playerClasses = [
        's3u3Oc',
        'iLKnN',
        'ExC9Fb',
        ...(scrim ? ['Vdm04', 'YW4uOd', 'g511Kb'] : []),
    ];
    await page.setContent(
        `<style>html{font-size:16px}${APP_RULES}${mod ? `\n${MOD_RULES}` : ''}` +
            `${scrims ? `\n${SCRIMS}` : ''}</style>` +
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
    '  ...removing it alone covers the video',
    await centrePixel({ scrim: true, appQualityRoot: false }),
    'rgb(3, 3, 3)',
);
check(
    '  ...which is what qualityScrims.css exists to prevent',
    await centrePixel({ scrim: true, appQualityRoot: false, scrims: true }),
    VIDEO,
);
check(
    '  ...and with no scrim the class makes no difference',
    await centrePixel({ scrim: false, appQualityRoot: false }),
    VIDEO,
);

// --- the tripwire: the suppression list must not go stale -------------------
// qualityScrims.css is a restatement of what app-quality-root turns off. If the
// app gains a scrim style and the captured stylesheet is refreshed, this fails
// until the new suppression is carried across -- which is the only thing between
// a new scrim and a black picture on a television.
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
const REMOVER = /^(background|background-image)\s*:\s*none$|^background-color\s*:\s*transparent$/i;
const expected = [];
for (const m of stripComments(APP_RULES).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (!selector.includes('.app-quality-root')) continue;
    const branches = selector.split(',').map((b) => b.trim());
    if (!branches.every((b) => b.startsWith('.app-quality-root '))) continue;
    const kept = m[2]
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && REMOVER.test(d));
    if (!kept.length) continue;
    expected.push(branches.map((b) => b.slice('.app-quality-root '.length)).join(','));
}
check('the captured sheet yields suppressions to check', expected.length > 20, true);

// Both the extraction above and the generator that wrote qualityScrims.css assume
// the class always appears as a LEADING `.app-quality-root ` with a descendant
// combinator after it. A compound form (`.app-quality-root.X`) or the class in a
// later position would be skipped by both, silently -- the tripwire would agree
// the list is complete because it built its expectations the same wrong way. So
// the assumption is asserted rather than relied on.
const odd = [...stripComments(APP_RULES).matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .flatMap((m) => m[1].split(','))
    .map((b) => b.trim())
    .filter((b) => b.includes('app-quality-root') && !b.startsWith('.app-quality-root '));
check('  ...and every one is a leading descendant selector', odd, []);
// Compared as parsed selectors, not as substrings of the file. Stripping all
// whitespace to match would conflate `.a .b` with `.a.b` -- a descendant
// combinator and a compound selector -- and could report a missing suppression
// as present because some unrelated rule happened to spell it the other way.
const norm = (sel) =>
    sel
        .trim()
        .replace(/\s*,\s*/g, ',')
        .replace(/\s+/g, ' ');
const ours = new Set(
    [...stripComments(SCRIMS).matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => norm(m[1])),
);
const missing = [...new Set(expected.map(norm))].filter((sel) => !ours.has(sel));
check('  ...and qualityScrims.css carries every one', missing, []);

// Subtractive only. A rule here that PAINTS would be the bug this file exists to
// prevent, reintroduced by the fix for it.
const paints = [...stripComments(SCRIMS).matchAll(/\{([^{}]*)\}/g)]
    .flatMap((m) => m[1].split(';'))
    .map((d) => d.trim())
    .filter((d) => d && !REMOVER.test(d));
check('  ...and nothing in it paints', paints, []);

// --- the removal stays, because the buttons need it -------------------------
// Putting the class back turns the transport controls either side of play/pause
// near-black and unselectable. That is why the fix is a suppression block and not
// simply leaving the class alone.
const uiSrc = readRepo('mods', 'ui', 'ui.ts');
const uiCode = uiSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
check(
    'the mod still removes app-quality-root',
    /remove\(\s*['"]app-quality-root['"]\s*\)/.test(uiCode),
    true,
);
check(
    '  ...and injects the suppressions when it does',
    /setStyleBlock\(\s*'quality-scrims'/.test(uiCode),
    true,
);
// Order matters: a frame with the class gone and the block not yet applied is a
// frame of black video.
check(
    '  ...before it starts removing',
    uiCode.indexOf("setStyleBlock('quality-scrims'") < uiCode.indexOf('MutationObserver'),
    true,
);

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
