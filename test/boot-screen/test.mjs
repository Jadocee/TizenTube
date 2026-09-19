// The boot screen, in a real browser, against a real HTTP service.
//
// WHY A BROWSER. The state machine next door in test/splash lifts two slices of
// the inline <script> and runs them under `new Function`. That covers the
// decisions and nothing else: not the markup, not the stylesheet, not whether
// the page throws on load, and not whether the cross-origin fetch the whole
// design rests on is actually allowed. Nothing in this repository loaded
// standalone/index.html in an engine before this file did.
//
// WHY CROSS-ORIGIN MATTERS. The widget page is served from the application's own
// origin and the service listens on http://localhost:8099, so every poll is a
// cross-origin request. It works because the service sets
// Access-Control-Allow-Origin, and because the readiness route is registered
// BELOW that middleware -- the userscript route above it is not, which is
// exactly why the boot screen asks a route about the script instead of
// fetching the script itself. Both servers here reproduce that arrangement, so
// moving the route above the middleware fails this harness.
import { createServer } from 'node:http';
import {
    chromium as findChromium,
    chromiumExecutable,
    skip,
    readRepo,
    checker,
} from '../lib/repo.mjs';

const chromium = await findChromium();
if (!chromium) skip('Playwright is not installed; this harness needs a real browser');

const PAGE = readRepo('standalone', 'index.html');
const SERVICE_PORT = 8099; // the port the page hardcodes

const { check, done } = checker();

/** What /tizentube/ready answers with. Swapped between scenarios. */
let answer = null;
/** Everything the page asked the service for, in order. */
let asked = [];

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

// The service. Same CORS headers as standalone/service/index.ts sets, and the
// same route ordering.
const service = createServer((req, res) => {
    asked.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.url.startsWith('/tizentube/ready')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(answer));
        return;
    }
    if (req.url.startsWith('/tizentube/debugger')) {
        res.statusCode = 202;
        res.end();
        return;
    }
    // Stands in for the proxied YouTube the page hands over to.
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>proxied</title><body>proxy</body>');
});

try {
    await listen(service, SERVICE_PORT);
} catch (_e) {
    skip(
        `port ${SERVICE_PORT} is already in use; this harness needs it to stand in for the service`,
    );
}

// The widget, on its own origin -- which is the point.
const widget = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE);
});
await listen(widget, 0);
const widgetUrl = `http://127.0.0.1:${widget.address().port}/index.html`;

const browser = await chromium.launch({ executablePath: chromiumExecutable() });

/**
 * Loads the boot screen with the service answering `state`, waits `ms`, and
 * reports what the screen did and said.
 *
 * `tizen` is installed before any of the page's own script runs, because the
 * page calls registerKey at the top of its first statement list -- an absent
 * global there would throw before anything under test had a chance to run, and
 * the harness would be measuring its own stub rather than the page.
 */
async function boot(state, ms = 1500, options = {}) {
    answer = state;
    asked = [];
    const context = await browser.newContext(
        options.reducedMotion ? { reducedMotion: 'reduce' } : {},
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    await page.addInitScript(() => {
        window.__calls = { exit: 0 };
        window.tizen = {
            tvinputdevice: {
                registerKey: (name) => {
                    // A model that does not list a key throws, and the page has
                    // to survive it. Reproduced rather than assumed.
                    if (name === 'ColorF2Yellow') throw new Error('InvalidValuesError');
                },
            },
            // The page constructs one of these and hands it to launchAppControl.
            // Omitting it threw "tizen.ApplicationControl is not a constructor"
            // out of the page's top-level script -- which is precisely the class
            // of defect this harness exists to catch, so it is reproduced here
            // faithfully rather than routed around.
            ApplicationControl: function ApplicationControl(operation) {
                this.operation = operation;
            },
            application: {
                getCurrentApplication: () => ({
                    getRequestedAppControl: () => null,
                    appInfo: { packageId: 'TESTPKG' },
                    exit: () => {
                        window.__calls.exit++;
                    },
                }),
                // Accepting the request is not the same as the service being up,
                // which is why the page starts polling from the callback rather
                // than assuming. Asynchronous here for the same reason.
                launchAppControl: (_control, id, onSuccess, _onError) => {
                    window.__calls.launched = id;
                    setTimeout(() => onSuccess(), 0);
                },
            },
        };
    });
    await page.goto(widgetUrl);
    await page.waitForTimeout(ms);

    const url = page.url();
    const navigated = !url.startsWith(widgetUrl);
    let screen = { tagline: '', status: '', fill: '', sweepAnimation: '', taglineSize: 0 };
    let exits = 0;
    let launched = '';
    if (!navigated) {
        screen = await page.evaluate(() => {
            const tagline = document.querySelector('.tagline');
            const fill = document.querySelector('.progress-fill');
            const sweep = document.querySelector('.progress-sweep');
            const status = document.querySelector('.stage div');
            return {
                tagline: tagline ? tagline.textContent : '',
                status: status ? status.textContent : '',
                fill: fill ? getComputedStyle(fill).transform : '',
                sweepAnimation: sweep ? getComputedStyle(sweep).animationName : '',
                taglineSize: tagline ? parseFloat(getComputedStyle(tagline).fontSize) : 0,
            };
        });
        exits = await page.evaluate(() => window.__calls.exit);
        launched = await page.evaluate(() => window.__calls.launched || '');
    }
    await context.close();
    return { url, navigated, screen, exits, launched, errors, asked: [...asked] };
}

const READY = { ready: true, bytes: 609139, version: '0.1.22', packaged: true };
const MISSING = { ready: false, bytes: 0, version: null, packaged: false };
const NO_DAEMON = { canConnectToDaemon: false, ip: '', isConnecting: false, probed: true };
const DAEMON = { canConnectToDaemon: true, ip: '127.0.0.1', isConnecting: false, probed: true };
const IDLE = { phase: 'idle', method: null, error: null, generation: 0 };

// --- the page itself --------------------------------------------------------
const held = await boot({ userScript: MISSING, daemon: DAEMON, attach: IDLE });
check('the page loads without throwing', held.errors.join(' | '), '');
check('  ...even with a key this model rejects', held.errors.length, 0);
// The service is started before anything is polled, and it is the SERVICE id,
// not the application id -- getting that wrong leaves nothing listening on 8099
// and every later assertion here would be about a screen waiting forever.
check('  ...and it starts the service first', held.launched, 'TESTPKG.StandaloneService');
// The poll really goes over the wire, cross-origin, and is answered. If the
// readiness route ever moved above the CORS middleware this is what would fail.
check('it reaches the service across origins', held.asked.length > 0, true);
check(
    '  ...on the readiness route',
    held.asked.every((u) => u.startsWith('/tizentube/ready')),
    true,
);

// --- THE GATE ---------------------------------------------------------------
check('with no userscript it does not hand over', held.navigated, false);
check('  ...does not exit the app', held.exits, 0);
check(
    '  ...and never asks for a debugger attach',
    held.asked.some((u) => u.includes('debugger')),
    false,
);
check('  ...saying which stage it is on', held.screen.tagline, 'Loading TizenTube');
check('  ...and keeps asking', held.asked.length > 2, true);

// --- the bar means something ------------------------------------------------
// scaleX(0.46) is the userscript stage. Read from the computed matrix, so a
// stylesheet that stopped applying the transform fails here rather than looking
// right in the source.
check('the bar shows the stage it is on', /^matrix\(0\.46,/.test(held.screen.fill), true);

// --- handover ---------------------------------------------------------------
const proxied = await boot({ userScript: READY, daemon: NO_DAEMON, attach: IDLE });
check('with a userscript and no daemon it hands over', proxied.navigated, true);
check('  ...to the proxy', proxied.url.includes(`localhost:${SERVICE_PORT}/tv`), true);
check('  ...carrying the DIAL address', proxied.url.includes('dial%2Fapps%2FYouTube'), true);
check('  ...and threw nothing on the way', proxied.errors.length, 0);

const attaching = await boot({ userScript: READY, daemon: DAEMON, attach: IDLE });
check(
    'with a daemon it asks for a debugger attach',
    attaching.asked.some((u) => u.includes('/tizentube/debugger')),
    true,
);
check('  ...and exits so the app can be relaunched', attaching.exits, 1);
check('  ...exactly once', attaching.exits, 1);
check('  ...without navigating', attaching.navigated, false);

// --- the boot loop ----------------------------------------------------------
const afterFailure = await boot(
    {
        userScript: READY,
        daemon: DAEMON,
        attach: { phase: 'failed', method: null, error: 'sdbd rejected it', generation: 1 },
    },
    // Longer than the page's own pause for a message to be read. On a real
    // clock, unlike the lifted state machine next door, so this has to outlast
    // it or the assertion below would be about the pause rather than the route.
    5200,
);
check(
    'a failed attach is not retried into a loop',
    afterFailure.asked.some((u) => u.includes('debugger')),
    false,
);
check(
    '  ...and the proxy is used instead',
    afterFailure.url.includes(`localhost:${SERVICE_PORT}/tv`),
    true,
);

// --- readable at ten feet ---------------------------------------------------
// A launch screen that reports a problem nobody can read from the sofa is the
// same as one that says nothing.
check('the stage label is legible from a sofa', held.screen.taglineSize >= 22, true);

// --- motion is a preference -------------------------------------------------
const still = await boot({ userScript: MISSING, daemon: DAEMON, attach: IDLE }, 800, {
    reducedMotion: true,
});
check('reduced motion stops the sweep', still.screen.sweepAnimation, 'none');
check('  ...but keeps the stage, which is information', still.screen.tagline, 'Loading TizenTube');
check(
    '  ...and keeps the fill, for the same reason',
    /^matrix\(0\.46,/.test(still.screen.fill),
    true,
);

await browser.close();
service.close();
widget.close();
done();
