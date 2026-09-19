// Drives standalone/index.html's launch state machine, with the real source
// lifted out of the page.
//
// WHAT THIS SCREEN IS NOW. It used to be a launcher: start the service, ask one
// question about the sdb daemon, hand the television over. Neither exit checked
// anything about the mod -- the proxy branch assigned location.href after
// reading a single boolean, and the debugger branch fired a request it never
// waited for and exited the app on the next line. The service answers 200 with
// a one-line console.error stub when it has no userscript to serve, so "YouTube
// boots and TizenTube is simply not in it, and nothing on screen says so" was
// one falsy value away on every launch.
//
// It is a gate now, and these are the things that must stay true of it.
import { readFileSync } from 'node:fs';
import { readRepo, checker } from '../lib/repo.mjs';
const html = process.env.SPLASH_HTML
    ? readFileSync(process.env.SPLASH_HTML, 'utf8')
    : readRepo('standalone', 'index.html');

// From the counters (which the poll loop closes over) to the launch call, so the
// lifted function has the state it actually uses.
const body = html.slice(
    html.indexOf('let statusEl = null;'),
    html.indexOf('tizen.application.launchAppControl'),
);
if (!body.includes('/tizentube/ready')) {
    console.log('FAIL: could not lift the poll loop');
    process.exit(1);
}

const { check, done } = checker();

/**
 * Just enough DOM for the two functions that touch it.
 *
 * NOT `undefined`. Both are written `if (!document.body) return;` so they are
 * safe before the body exists, and that guard is real -- this script runs from
 * <head>. But a sandbox with no `document` at all makes the guard itself throw,
 * which tested the wrong thing and hid whatever the screen was saying.
 */
function fakeDocument() {
    const tagline = { textContent: '' };
    const fill = { style: {} };
    const status = { style: { cssText: '' }, textContent: '' };
    const stage = { appendChild: () => {} };
    return {
        body: {},
        createElement: () => status,
        querySelector: (sel) => {
            if (sel === '.tagline') return tagline;
            if (sel === '.progress-fill') return fill;
            if (sel === '.stage') return stage;
            return null;
        },
        read: () => ({
            tagline: tagline.textContent,
            fill: fill.style.transform || '',
            status: status.textContent,
        }),
    };
}

/**
 * One launch, against a service that answers /tizentube/ready with `state`.
 *
 * `state` may be a function of the poll count, so a harness can make readiness
 * arrive late -- which is the whole point of the gate.
 */
function run(state, ms = 400) {
    return new Promise((resolve) => {
        const outcome = {
            debugger: 0,
            navigated: null,
            exited: false,
            reloaded: 0,
            polls: 0,
            timers: 0,
        };
        const doc = fakeDocument();
        const sandbox = {
            fetch: (url) => {
                if (String(url).includes('/tizentube/ready')) {
                    outcome.polls++;
                    const answer = typeof state === 'function' ? state(outcome.polls) : state;
                    return Promise.resolve({ json: () => Promise.resolve(answer) });
                }
                if (String(url).includes('/debugger')) outcome.debugger++;
                return Promise.resolve({ json: () => Promise.resolve({}) });
            },
            tizen: {
                application: {
                    getCurrentApplication: () => ({
                        getRequestedAppControl: () => ({ appControl: { data: [] } }),
                        exit: () => {
                            outcome.exited = true;
                        },
                        appInfo: { packageId: 'TESTPKG' },
                    }),
                },
            },
            location: {
                set href(v) {
                    outcome.navigated = v;
                },
                get href() {
                    return outcome.navigated;
                },
            },
            window: {
                location: {
                    reload: () => {
                        outcome.reloaded++;
                    },
                },
            },
            document: doc,
            setTimeout: (fn, d) => {
                outcome.timers++;
                return setTimeout(fn, Math.min(d, 20));
            },
            clearTimeout,
            AbortController,
            console,
        };
        const fn = new Function(...Object.keys(sandbox), `${body}; return useInjectorOrProxy;`);
        fn(...Object.values(sandbox))();
        setTimeout(() => resolve({ ...outcome, screen: doc.read() }), ms);
    });
}

// The shapes /tizentube/ready answers with.
const READY = { ready: true, bytes: 609139, version: '0.1.22', packaged: true };
const MISSING = { ready: false, bytes: 0, version: null, packaged: false };
const NO_DAEMON = { canConnectToDaemon: false, ip: '', isConnecting: false, probed: true };
const DAEMON = { canConnectToDaemon: true, ip: '127.0.0.1', isConnecting: false, probed: true };
const IDLE = { phase: 'idle', method: null, error: null, generation: 0 };

const isProxy = (url) => typeof url === 'string' && url.includes('localhost:8099/tv');

// --- THE GATE ---------------------------------------------------------------
// The defect this screen was rewritten for. With no userscript to inject,
// neither route may be taken: the proxy would serve the console.error stub and
// the debugger would relaunch the app straight into the same failure.
console.log('With no userscript to inject:\n');
const gated = await run({ userScript: MISSING, daemon: DAEMON, attach: IDLE }, 250);
check('does not navigate', gated.navigated, null);
check('  ...does not exit', gated.exited, false);
check('  ...does not start a debugger attach', gated.debugger, 0);
check('  ...keeps asking', gated.polls > 3, true);
check('  ...and says what it is waiting for', gated.screen.tagline, 'Loading TizenTube');

// It must end SOMEWHERE. A television parked on a launch screen is worse than
// one showing YouTube unmodded, so the budget expires into the proxy -- and
// never into the debugger, which would relaunch into the same missing script.
const gaveUp = await run({ userScript: MISSING, daemon: DAEMON, attach: IDLE }, 2500);
check('gives up eventually rather than hanging', isProxy(gaveUp.navigated), true);
check('  ...without ever exiting the app', gaveUp.exited, false);
check('  ...and having said why', gaveUp.screen.status.includes('could not be loaded'), true);

// ...and a userscript that arrives late is waited for, not given up on.
const late = await run(
    (n) => ({ userScript: n < 4 ? MISSING : READY, daemon: NO_DAEMON, attach: IDLE }),
    400,
);
check('a late userscript is waited for', isProxy(late.navigated), true);
check('  ...rather than handed over unmodded', late.polls >= 4, true);

// --- the four states the service can report ---------------------------------
console.log('\nWith a userscript ready:\n');
const proxy = await run({ userScript: READY, daemon: NO_DAEMON, attach: IDLE }, 250);
check('no daemon -> the proxy', isProxy(proxy.navigated), true);
check('  ...and never the debugger', proxy.debugger, 0);
check('  ...reaching the last stage', proxy.screen.tagline, 'Opening YouTube');
check('  ...with the bar full', proxy.screen.fill, 'scaleX(1)');

const attach = await run({ userScript: READY, daemon: DAEMON, attach: IDLE }, 250);
check('daemon reachable, idle -> starts the debugger', attach.debugger, 1);
check('  ...exactly once', attach.debugger, 1);
check('  ...and exits the splash', attach.exited, true);
check('  ...without navigating first', attach.navigated, null);

const inFlight = await run(
    { userScript: READY, daemon: DAEMON, attach: { ...IDLE, phase: 'connecting' } },
    250,
);
console.log('\n  <-- an attach already in flight:');
check('does not hang', inFlight.polls > 1, true);
check('  ...does not exit', inFlight.exited, false);
check('  ...does not navigate', inFlight.navigated, null);
check('  ...does not start a second attach', inFlight.debugger, 0);
check('  ...and names the phase', inFlight.screen.status.includes('Connecting'), true);

// isConnecting is the older signal for the same thing. It is still honoured, so
// a service that predates the phase field cannot make this screen exit into an
// attach that is already running.
const connecting = await run(
    { userScript: READY, daemon: { ...DAEMON, isConnecting: true }, attach: IDLE },
    250,
);
check('isConnecting alone also holds it', connecting.exited, false);
check('  ...and does not start an attach', connecting.debugger, 0);

// --- THE BOOT LOOP ----------------------------------------------------------
// `isConnecting` was one bit: a clean attach and every failure cleared it
// identically, so a failed attach looked exactly like "idle, start one". The
// relaunched screen asked for another, exited, and went round again, and nothing
// on the device could break the cycle. A phase can say which it was.
console.log('\nAfter an attach that failed:\n');
const failed = await run(
    {
        userScript: READY,
        daemon: DAEMON,
        attach: { phase: 'failed', method: null, error: 'sdbd rejected it', generation: 1 },
    },
    2500,
);
check('does NOT ask for another attach', failed.debugger, 0);
check('  ...does not exit the app again', failed.exited, false);
check('  ...falls back to the proxy, which needs no debugger', isProxy(failed.navigated), true);
check('  ...and says so', failed.screen.status.includes('proxy'), true);

// A phase that means the service has already navigated the page is a
// contradiction with this screen still being up, so it is bounded rather than
// waited out -- the in-flight phases are not, because they are legitimately
// slow and the service watchdogs them.
const stranded = await run(
    {
        userScript: READY,
        daemon: DAEMON,
        attach: {
            phase: 'verified',
            method: 'addScriptToEvaluateOnNewDocument',
            error: null,
            generation: 1,
        },
    },
    900,
);
check('a navigation that never took is not waited out', isProxy(stranded.navigated), true);
const installing = await run(
    { userScript: READY, daemon: DAEMON, attach: { ...IDLE, phase: 'installing' } },
    900,
);
check('  ...but a slow install still is', installing.navigated, null);
check('  ...and is named on screen', installing.screen.status.includes('Installing'), true);

// --- nobody has looked for the daemon yet -----------------------------------
// "No daemon" and "no answer yet" are different, and the route must not be
// chosen from the second: the probe takes about ten seconds when 8001 refuses.
console.log('\nBefore the daemon probe has finished:\n');
const unprobed = await run(
    { userScript: READY, daemon: { ...NO_DAEMON, probed: false }, attach: IDLE },
    250,
);
check('waits rather than guessing', unprobed.navigated, null);
check('  ...and does not exit', unprobed.exited, false);
const unprobedLong = await run(
    { userScript: READY, daemon: { ...NO_DAEMON, probed: false }, attach: IDLE },
    1200,
);
check('but is bounded -- the proxy needs no daemon', isProxy(unprobedLong.navigated), true);

// --- the service not answering yet: retry in place, never reload ------------
function runFailing(ms = 900) {
    return new Promise((resolve) => {
        const outcome = { reloaded: 0, polls: 0, navigated: null, exited: false };
        const doc = fakeDocument();
        const sandbox = {
            fetch: () => {
                outcome.polls++;
                return Promise.reject(new Error('ECONNREFUSED'));
            },
            tizen: {
                application: {
                    getCurrentApplication: () => ({
                        getRequestedAppControl: () => ({ appControl: { data: [] } }),
                        appInfo: { packageId: 'TESTPKG' },
                        exit: () => {
                            outcome.exited = true;
                        },
                    }),
                },
            },
            location: {
                set href(v) {
                    outcome.navigated = v;
                },
                get href() {
                    return outcome.navigated;
                },
            },
            window: {
                location: {
                    reload: () => {
                        outcome.reloaded++;
                    },
                },
            },
            setTimeout: (fn, d) => setTimeout(fn, Math.min(d, 20)),
            clearTimeout,
            AbortController,
            document: doc,
            console: { log() {}, warn() {}, error() {} },
        };
        const fn = new Function(...Object.keys(sandbox), `${body}; return useInjectorOrProxy;`);
        fn(...Object.values(sandbox))();
        setTimeout(() => resolve({ ...outcome, screen: doc.read() }), ms);
    });
}

console.log('\nWhen the service has not bound 8099 yet:');
const f = await runFailing();
check('retries rather than reloading the document', f.reloaded, 0);
check('keeps polling in place', f.polls > 3, true);
check('does not navigate away', f.navigated, null);
check('  ...and never exits into a debugger that is not there', f.exited, false);

// --- key registration must not be able to stop the launch -------------------
const prologue = html.slice(html.indexOf('const keys = ['), html.indexOf('let statusEl'));
// Anchored on a key the page really lists, so the assertion cannot pass by
// never throwing at all.
const VICTIM = 'ColorF2Yellow';
check('the key the next assertion rejects is really listed', prologue.includes(VICTIM), true);
let _launched = false;
const kb = {
    tizen: {
        tvinputdevice: {
            registerKey: (k) => {
                if (k === VICTIM) throw new Error('InvalidValuesError');
                _launched = true;
            },
        },
    },
    document: { body: null },
};
let threw = false;
try {
    new Function(...Object.keys(kb), prologue)(...Object.values(kb));
} catch (_e) {
    threw = true;
}
console.log('\nWhen a model rejects one of the twelve keys:');
check('registration does not abort the script', threw, false);
check('  ...and the others still register', _launched, true);

done();
