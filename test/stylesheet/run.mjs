import { chromium as findChromium, chromiumExecutable, skip } from '../lib/repo.mjs';

const chromium = await findChromium();
if (!chromium) skip('Playwright is not installed; this harness needs a real browser');
const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage();
const base = new URL('./', import.meta.url).href;

async function run(file) {
    await page.goto(base + file);
    return page.evaluate(() => ({
        ...window.__result,
        styleCount: window.__ttBlocks,
        sheetText: window.__ttSheetText,
    }));
}

const before = await run('old.html');
const after = await run('page.html');

let fail = 0;
const check = (d, got, want) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${d.padEnd(52)} ${JSON.stringify(got)}${ok ? '' : `  want ${JSON.stringify(want)}`}`,
    );
};

console.log('The test page enforces a nonce-only style-src, like the real app:');
check('CSP is actually enforced (a nonce-less <style> is blocked)', before.cspEnforced, true);

console.log("\nAS SHIPPED — appending into YouTube's own stylesheet:");
check('our own rules apply', before.ttUi, 'rgb(40, 50, 60)');
check("YouTube's text rule survives", before.fromText, 'rgb(10, 20, 30)');
check("YouTube's CSSOM rule is DESTROYED  <-- the bug", before.fromCssom !== 'rgb(1, 2, 3)', true);

console.log('\nWITH A STYLESHEET OF OUR OWN:');
check('our own rules apply', after.ttUi, 'rgb(40, 50, 60)');
check('theme block applies', after.ttTheme, 'rgb(70, 80, 90)');
check("YouTube's text rule survives", after.fromText, 'rgb(10, 20, 30)');
check("YouTube's CSSOM rule survives", after.fromCssom, 'rgb(1, 2, 3)');
check("YouTube's stylesheet is untouched", after.sheetText.includes('tt-ui'), false);
check(
    'a theme update replaces rather than stacks',
    (after.sheetText.match(/tt-theme/g) || []).length,
    0,
);

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
await browser.close();
process.exit(fail ? 1 : 0);
