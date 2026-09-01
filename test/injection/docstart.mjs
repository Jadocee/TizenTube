import { chromium as findChromium, chromiumExecutable, skip, readRepo } from '../lib/repo.mjs';

const chromium = await findChromium();
if (!chromium) skip('Playwright is not installed; this harness needs a real browser');
import { readFileSync } from 'fs';
const bundle = readRepo('dist', 'userScript.js');

const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

// The script first in <head>, exactly where the proxy now puts it, with a body
// that only exists after it has run — and a slow tail so the parser is still
// working when the module bodies execute.
await page.route('**/tv*', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><head><script src="/tizentube/userScript.js"></script>
<title>YouTube</title></head><body><div id="container"></div>
<video></video></body></html>`,
    }),
);
await page.route('**/tizentube/userScript.js', (route) =>
    route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: bundle,
    }),
);

await page.goto('https://www.youtube.com/tv', { waitUntil: 'load' });

const early = await page.evaluate(() => ({
    ranBeforeBody: !!window.__ttSawNoBody,
    hasQueue: !!window.queuedVideos,
    pipFlag: typeof window.isPipPlaying,
    jsonPatched: JSON.parse.toString().indexOf('native code') === -1,
}));

// Give the deferred work (whenBodyReady, the 250ms polls) time to land.
await page.waitForTimeout(3000);

const late = await page.evaluate(() => ({
    styleEls: document.querySelectorAll('style').length,
    ttStyle: [...document.querySelectorAll('style')].some((s) =>
        s.textContent.includes('ytaf-ui-container'),
    ),
    panel: !!document.querySelector('.ytaf-ui-container'),
}));

let fail = 0;
const check = (d, got, want) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${d.padEnd(56)} ${JSON.stringify(got)}${ok ? '' : '  want ' + JSON.stringify(want)}`,
    );
};

console.log('Bundle loaded as the first script in <head>, before <body> exists:\n');
check('no uncaught errors during document-start execution', errors.length, 0);
if (errors.length) errors.slice(0, 6).forEach((e) => console.log('        ' + e));
check('JSON.parse was replaced', early.jsonPatched, true);
check('queue global installed', early.hasQueue, true);
check('PiP global installed', early.pipFlag, 'boolean');
console.log('\nAfter the DOM exists and the deferred work has run:');
check('TizenTube stylesheet applied', late.ttStyle, true);
check('theme panel built', late.panel, true);

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
await browser.close();
process.exit(fail ? 1 : 0);
