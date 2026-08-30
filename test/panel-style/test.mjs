// The theme panel's stylesheet, checked against the things that actually matter
// on a television rather than against exact pixel values -- so a deliberate
// restyle passes, and a restyle that quietly drops a rule does not.
import { chromium as findChromium, chromiumExecutable, skip, readRepo } from '../lib/repo.mjs';
import { checker } from '../lib/repo.mjs';

const chromium = await findChromium();
if (!chromium) skip('Playwright is not installed; this harness needs a real browser');

const css = readRepo('mods', 'ui', 'ui.css');
const { check, done } = checker();

const PANEL = `
<h1>TizenTube 9 Theme</h1>
<p class="ytaf-ui-subtitle">Colors are applied as soon as you confirm them.</p>
<label class="ytaf-ui-row" for="__barColor">
  <span class="ytaf-ui-row-label">Navigation Bar Color</span>
  <span class="ytaf-ui-row-value">
    <span class="ytaf-ui-swatch" id="__barColorSwatch"></span>
    <input type="text" id="__barColor" value="#101b2d"/>
  </span>
</label>
<div class="ytaf-ui-hint">Press BACK to close</div>`;

// Rendered at a 16px root. YouTube's TV app sizes its root font at a fraction
// of the viewport, which is larger than this, so every rem-derived number below
// is the floor rather than what a set actually shows.
const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#0b0b0b;font-family:Roboto,Arial,sans-serif}html{font-size:16px}</style>
<style>${css}</style></head><body>
  <div class="ytaf-ui-container" tabindex="0">${PANEL}</div>
  <!-- the elements the YouTube-override rules target -->
  <div class="ytLrWatchDefaultShadow"></div>
  <div class="ytLrTileHeaderRendererShorts"></div>
  <div class="ytLrProgressBarPlayhead"></div>
  <div class="ytLrOverlayPanelHeaderRendererSubtitle"></div>
</body></html>`);

const px = (v) => parseFloat(v) || 0;
const styles = (sel, props) => page.evaluate(([s, p]) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(p.map((k) => [k, cs.getPropertyValue(k)]));
}, [sel, props]);

// --- the nesting actually parsed -------------------------------------------
// If the browser rejected the nested block every one of these is unstyled, so
// this is the canary for the whole file.
const row = await styles('.ytaf-ui-row', ['display', 'background-color', 'border-radius']);
// The row's fill is set inside the nested block, so a browser that rejected the
// nesting leaves it transparent and every other check below is meaningless.
check('nesting parsed (the row has its fill)',
      row !== null && row['background-color'] !== 'rgba(0, 0, 0, 0)', true);
check('label and value sit on one line', row.display, 'flex');

// --- rounded corners --------------------------------------------------------
const panel = await styles('.ytaf-ui-container', ['border-radius', 'position', 'z-index', 'color', 'background-color']);
check('panel has rounded corners', px(panel['border-radius']) >= 16, true);
check('rows have rounded corners', px(row['border-radius']) >= 12, true);
const input = await styles('.ytaf-ui-container input[type=text]', ['border-radius', 'font-size', 'color']);
check('inputs have rounded corners', px(input['border-radius']) >= 8, true);
const swatch = await styles('.ytaf-ui-swatch', ['border-radius', 'width', 'height']);
check('swatch has rounded corners', px(swatch['border-radius']) >= 8, true);
check('swatch is still square', swatch.width === swatch.height, true);

// --- readable from across a room -------------------------------------------
check('body text is at least 24px', px(input['font-size']) >= 24, true);
const label = await styles('.ytaf-ui-row-label', ['font-size']);
check('row labels are at least 24px', px(label['font-size']) >= 24, true);

const luminance = (rgb) => {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
};
// The panel paints over a dark app, and its own surface is translucent, so the
// realistic worst case is measuring against near-black.
const ratio = contrast(panel.color, 'rgb(18, 18, 18)');
check('panel text clears 3:1 for large text', ratio >= 3, true);

// --- focus has to be obvious ------------------------------------------------
await page.focus('#__barColor');
const focused = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    const rowCs = getComputedStyle(document.activeElement.closest('.ytaf-ui-row'));
    return { width: cs.outlineWidth, style: cs.outlineStyle, rowBg: rowCs.backgroundColor };
});
check('focused control draws an outline', focused.style !== 'none' && px(focused.width) >= 3, true);
check('the whole row lights up, not just the control', focused.rowBg !== row['background-color'], true);

// --- the YouTube overrides still land ---------------------------------------
const shadow = await styles('.ytLrWatchDefaultShadow', ['position', 'pointer-events', 'display']);
check('player shadow override applies', shadow.position === 'absolute' && shadow['pointer-events'] === 'none', true);
const shorts = await styles('.ytLrTileHeaderRendererShorts', ['background-image']);
check('shorts background override applies', shorts['background-image'], 'none');
const playhead = await styles('.ytLrProgressBarPlayhead', ['z-index']);
check('playhead z-index override applies', playhead['z-index'], '1');
const subtitle = await styles('.ytLrOverlayPanelHeaderRendererSubtitle', ['white-space']);
check('multiline subtitle override applies', subtitle['white-space'], 'pre-wrap');

// --- stays inside the title-safe area ---------------------------------------
const box = await page.evaluate(() => {
    const r = document.querySelector('.ytaf-ui-container').getBoundingClientRect();
    return { left: r.left, right: innerWidth - r.right, top: r.top, bottom: innerHeight - r.bottom };
});
const safe = Math.min(1920, 1080) * 0.05;
check('panel clears the title-safe inset on every edge',
      Math.min(box.left, box.right, box.top, box.bottom) >= safe, true);

await browser.close();
done();
