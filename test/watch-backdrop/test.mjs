// That the user's background colour never covers the video.
//
// THE BUG THIS EXISTS FOR. theme.ts paints #container with the user's chosen
// Main Content Colour and marks it !important. YouTube ships
// `.WEB_PAGE_TYPE_WATCH #container { background: none }` precisely so the video
// plane shows through on the watch page, and it ALSO writes
// `#container.style.backgroundColor = 'transparent'` inline when the player
// opens. An unscoped !important beats both of those -- a plain inline style
// loses to any important declaration -- so the container stayed an opaque fill
// over the video, and the picture vanished behind black whenever the player
// chrome came up.
//
// IT IS RUN IN A REAL BROWSER, against YouTube's own rules copied verbatim,
// because it is a cascade bug and nothing else can see it. Reading the source
// tells you the rule exists; only resolving it against the app's stylesheet and
// its inline write tells you who wins. A source-shape assertion here would have
// been green for the whole life of the defect.
import { chromium, chromiumExecutable, checker, skip, readRepo } from '../lib/repo.mjs';

const launcher = await chromium();
if (!launcher) skip('Playwright with Chromium is not installed.');

// YouTube's own #container rules, verbatim from the live main.css.
const APP_RULES = `
#container{background-color:#0f0f0f;position:absolute;height:45rem;width:80rem;
  top:0;bottom:0;left:0;right:0;overflow:hidden;margin:auto}
.WEB_PAGE_TYPE_WATCH #container{background:none}
.WEB_PAGE_TYPE_ACCOUNT_SELECTOR #container{background-color:#0f0f0f}`;

// The mod's block, extracted from theme.ts rather than retyped, so a change
// there is a change here. The template holds one interpolation; the colour it
// reads is the default.
const themeSrc = readRepo('mods', 'ui', 'theme.ts');
const block = themeSrc.match(/setStyleBlock\(\s*'theme',\s*`([\s\S]*?)`,?\s*\)/);
if (!block) throw new Error('cannot find the theme style block in theme.ts');
const THEME_RULES = block[1].replace(/\$\{[^}]*\}/g, '#0f0f0f');

const browser = await launcher.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const { check, done } = checker();

/** Resolve #container's background on one page type, before and after the
 *  app's own inline write. */
async function resolve(bodyClass) {
    await page.setContent(
        `<style>html{font-size:24px}${APP_RULES}\n${THEME_RULES}</style>` +
            `<body class="${bodyClass}"><div id="container"></div></body>`,
    );
    return page.evaluate(() => {
        const c = document.getElementById('container');
        const fromStylesheet = getComputedStyle(c).backgroundColor;
        // Exactly what the app does when the player opens.
        c.style.backgroundColor = 'transparent';
        return { fromStylesheet, afterInlineWrite: getComputedStyle(c).backgroundColor };
    });
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const THEMED = 'rgb(15, 15, 15)';

// --- the watch page: the video must show through ----------------------------
const watch = await resolve('WEB_PAGE_TYPE_WATCH landscape');
check('the watch page leaves the container transparent', watch.fromStylesheet, TRANSPARENT);
// The one that actually mattered. The app's inline write is a plain style and
// loses to any !important declaration, so if the mod's rule applies here at all
// the app cannot get its own transparency back.
check(
    "  ...and the app's own inline transparency is not overridden",
    watch.afterInlineWrite,
    TRANSPARENT,
);

// --- everywhere else: the setting still works -------------------------------
// The point of the !important is to beat that same inline write on the surfaces
// where the user's colour SHOULD win. Removing it to fix the watch page would
// trade one bug for another, so both halves are asserted.
for (const surface of [
    'WEB_PAGE_TYPE_BROWSE landscape',
    'WEB_PAGE_TYPE_SEARCH landscape',
    'WEB_PAGE_TYPE_ACCOUNT_SELECTOR',
    'WEB_PAGE_TYPE_SHORTS landscape',
]) {
    const r = await resolve(surface);
    check(`${surface.split(' ')[0]} still takes the theme colour`, r.fromStylesheet, THEMED);
    check('  ...and keeps it against the inline write', r.afterInlineWrite, THEMED);
}

// Before the app has said where it is, <body> carries no class at all. The
// negative gate matches, which is correct: the container should be themed until
// something says otherwise, and #container is display:none during boot anyway.
const booting = await resolve('');
check('an unclassed body is themed', booting.fromStylesheet, THEMED);

await browser.close();
done();
