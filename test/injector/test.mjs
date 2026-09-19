// The standalone injector's attach, and the one invariant the splash depends on.
//
// standalone/index.html polls getState. On {canConnectToDaemon:true,
// isConnecting:false} it fires /tizentube/debugger and calls exit(). The service
// answers that by running `sdb shell debug <app>`, which RELAUNCHES the app --
// so the splash of the relaunched app polls again while the attach it just
// triggered is still running.
//
// That makes isConnecting load-bearing. If it reads false while the attach is
// still uploading the userscript, the relaunched splash takes the exit branch
// and kills the CDP target mid-attach, which starts another attach, which does
// the same thing. The app never gets the userscript and nothing on the device
// breaks the cycle -- it took a reboot.
//
// So: isConnecting must stay true from the attach starting until the script is
// registered AND the page has been navigated.
import { checker } from '../lib/repo.mjs';
import * as stub from './stub.mjs';
import {
    startDebugger,
    readIsConnecting,
    attachState,
    BOOT_PROBE,
    VERIFY_TIMEOUT_MS,
} from './mod.generated.mts';
import { readRepo } from '../lib/repo.mjs';

stub.installTizenGlobal();

const { check, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one attach the way the /tizentube/debugger route does -- through
 * startDebugger, which is what raises isConnecting -- sampling the flag every
 * 5ms against the call trace.
 */
async function attach(configure = () => {}) {
    stub.reset();
    configure(stub.knobs);
    const samples = [];
    startDebugger('');
    for (let i = 0; i < 120; i++) {
        samples.push({ at: stub.trace.length, connecting: readIsConnecting() });
        await sleep(5);
        if (stub.trace.includes('navigate:done') && !readIsConnecting()) break;
    }
    return samples;
}

/** Was isConnecting ever false while the trace sat between two markers? */
const falseBetween = (samples, from, to) => {
    const i = stub.trace.indexOf(from),
        j = stub.trace.indexOf(to);
    if (i < 0 || j < 0) return 'marker missing';
    return samples.some((s) => s.at > i && s.at <= j && !s.connecting);
};

// --- the happy path ---------------------------------------------------------
let samples = await attach();
check('the script is uploaded', stub.trace.includes('upload:done'), true);
check('the page is navigated', stub.trace.includes('navigate:done'), true);
check(
    'CSP is bypassed before navigating',
    stub.trace.indexOf('Page.setBypassCSP') < stub.traceIndex('navigate:start'),
    true,
);
check(
    'the script is registered before navigating',
    stub.trace.indexOf('upload:done') < stub.traceIndex('navigate:start'),
    true,
);

// The regression itself. Clearing on connect made this false for the whole
// upload, which is the longest part of the attach.
check(
    'stays connecting across the upload',
    falseBetween(samples, 'cdp:connected', 'upload:done'),
    false,
);
check(
    'stays connecting until the page is navigated',
    falseBetween(samples, 'upload:start', 'navigate:done'),
    false,
);
check('reports finished once navigated', readIsConnecting(), false);

// --- a slow upload, which is the realistic case on a TV ---------------------
samples = await attach((k) => {
    k.uploadMs = 220;
});
check(
    'a slow upload never reads as idle',
    falseBetween(samples, 'cdp:connected', 'navigate:done'),
    false,
);
check('a slow upload still finishes', readIsConnecting(), false);

// --- the fallback path: neither register command exists ---------------------
samples = await attach((k) => {
    k.registerOk = false;
});
check('falls back to the legacy register command', stub.trace.includes('upload:legacy'), true);
check('the fallback path still navigates', stub.trace.includes('navigate:done'), true);
check(
    'the fallback path never reads as idle early',
    falseBetween(samples, 'cdp:connected', 'navigate:done'),
    false,
);
check('the fallback path clears the flag', readIsConnecting(), false);

// --- an empty userscript: the attach fails, but must not latch --------------
samples = await attach((k) => {
    k.userScript = null;
});
check('an empty userscript still shows YouTube', stub.trace.includes('navigate:done'), true);
check('an empty userscript does not latch the flag', readIsConnecting(), false);

// ===========================================================================
// THE PHASE, which is what the boot screen reads.
//
// isConnecting is one bit, set in one place and cleared in nine, and a clean
// attach clears it with the same value as every failure. So the boot screen --
// whose whole decision was `canConnectToDaemon && !isConnecting` -- could not
// tell "installed and on YouTube" from "gave up", and a late clear looked
// exactly like "idle, start an attach": ask, exit, relaunch, ask again, with
// nothing on the device able to break the cycle.
// ===========================================================================

/** Runs an attach and lets the post-navigation probe settle. */
async function settled(configure = () => {}) {
    await attach(configure);
    await sleep(120);
    return attachState();
}

console.log('\nThe phase the boot screen reads:\n');

let state = await settled();
check('a clean attach ends verified', state.phase, 'verified');
check('  ...naming the command that took', state.method, 'addScriptToEvaluateOnNewDocument');
check('  ...with no error attached', state.error, null);
check('  ...and it really asked the page', stub.trace.includes('probe'), true);
check(
    '  ...after the page loaded, not before',
    stub.trace.indexOf('navigate:done') < stub.trace.indexOf('probe'),
    true,
);

// The losing side of the race used to report as a clean attach. It is still
// allowed -- it is better than nothing -- but it must say which it was.
state = await settled((k) => {
    k.registerOk = false;
});
check('the legacy command is named when it takes', state.method, 'addScriptToEvaluateOnLoad');

// --- the probe --------------------------------------------------------------
// The one answer allowed to change anything is a literal false.
state = await settled((k) => {
    k.bootProbe = false;
});
check('a page without the mod is recovered', state.phase, 'recovered');
check('  ...by a second navigation', stub.navigations().length, 2);
check(
    '  ...to the proxy, which injects without a debugger',
    stub.navigations()[1].includes('localhost:8099/tv'),
    true,
);
check(
    '  ...and the first one was still YouTube',
    stub.navigations()[0].includes('youtube.com'),
    true,
);

// A CDP build that does not honour returnByValue must not turn every launch
// into a recovery: unverified is not failed.
state = await settled((k) => {
    k.bootProbe = undefined;
});
check('an unanswerable probe changes nothing', state.phase, 'navigated');
check('  ...and does not navigate twice', stub.navigations().length, 1);

// Nor may a probe the page refuses to answer.
state = await settled((k) => {
    k.probeOk = false;
});
check('a probe that errors changes nothing', state.phase, 'navigated');
check('  ...and does not navigate twice either', stub.navigations().length, 1);

// The page is never asked before it has loaded -- asking the outgoing document
// would answer about the wrong page, and on the debugger path the outgoing
// document is this very launch screen.
state = await settled((k) => {
    k.loadEventMs = 999999;
});
check('an unloaded page is not probed', stub.trace.includes('probe'), false);
check('  ...and is left as navigated meanwhile', state.phase, 'navigated');

// The give-up budget is a real number, not an accident. Twenty seconds is a
// cold youtube.com/tv on a television with room to spare, and the cost of
// waiting too long is nothing: the page is already in front of the viewer and
// isConnecting was cleared before the probe started.
check('the verify budget is twenty seconds', VERIFY_TIMEOUT_MS, 20000);

// --- failures ---------------------------------------------------------------
// A CDP failure that is NOT the userscript: the proxy has a copy of the script
// and needs no debugger, so it is a second route rather than a dead end. This
// used to navigate to youtube.com with nothing installed, deliberately.
state = await settled((k) => {
    k.enableOk = false;
});
check('a CDP failure recovers through the proxy', state.phase, 'recovered');
check(
    '  ...rather than plain YouTube with nothing installed',
    stub.navigations()[0].includes('localhost:8099/tv'),
    true,
);
check('  ...and records why', typeof state.error === 'string' && state.error.length > 0, true);

// ...but when the USERSCRIPT is what failed, the proxy would serve the same
// missing script behind a second page load, so plain YouTube is the better
// answer and the phase must say the attach failed.
state = await settled((k) => {
    k.userScript = null;
});
check('an empty userscript is reported as failed', state.phase, 'failed');
check(
    '  ...and does not bounce through the proxy',
    stub.navigations()[0].includes('youtube.com'),
    true,
);
check('  ...naming the reason', state.error, 'empty userscript');

// --- the probe's tripwire ---------------------------------------------------
// BOOT_PROBE names a global in mods/. If that global is renamed or its module
// stops being imported, the probe answers false on every launch and every
// attach turns into a needless proxy recovery -- quietly. These two assertions
// are the only thing standing between this file and that.
const identifier = (BOOT_PROBE.match(/window\.([A-Za-z0-9_$]+)/) || [])[1];
check('the probe names a window global', typeof identifier === 'string', true);
const queuing = readRepo('mods', 'features', 'videoQueuing.ts');
check(
    `mods/ still sets window.${identifier} at module scope`,
    new RegExp(`^window\\.${identifier}\\s*=`, 'm').test(queuing),
    true,
);
check(
    '  ...and the entry still imports the module that does',
    readRepo('mods', 'userScript.ts').includes("import './features/videoQueuing.js';"),
    true,
);

done();
