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
import { startDebugger, readIsConnecting } from './mod.generated.mts';

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
    stub.trace.indexOf('Page.setBypassCSP') < stub.trace.indexOf('navigate:start'),
    true,
);
check(
    'the script is registered before navigating',
    stub.trace.indexOf('upload:done') < stub.trace.indexOf('navigate:start'),
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

done();
