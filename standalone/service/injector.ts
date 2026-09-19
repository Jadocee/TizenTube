// The TizenBrew-way of TizenTube. Uses CDP and SDB to inject the userscript.

import * as adbhost from 'adbhost';
import CDP from 'chrome-remote-interface';
import nodeFetch from 'node-fetch';
import * as userScript from './userScript.js';

let isConnecting = false;
// Bumped on every attach attempt so a watchdog armed by an earlier one cannot
// clear a later one's flag.
let connectGeneration = 0;

/**
 * How far the debugger attach has got.
 *
 * THE BUG THIS EXISTS FOR. `isConnecting` is one bit, set in exactly one place
 * and cleared in nine, and a clean attach clears it with precisely the same
 * value as every failure. So the splash -- whose whole decision is
 * `canConnectToDaemon && !isConnecting` -- cannot tell "installed and on
 * YouTube" from "gave up". Worse, it does not merely mislead: a late clear looks
 * exactly like "idle, start an attach", so the relaunched splash fires
 * /tizentube/debugger and exits the app again, which starts another attach. That
 * is the boot loop the file's other comments describe, and one bit is why it
 * cannot be broken from the outside.
 *
 * A phase can be. The splash starts an attach only from `idle`, and on `failed`
 * it goes to the proxy instead -- which injects by a different route, so a
 * broken debugger costs the mod nothing.
 */
export type AttachPhase =
    /** Nothing has been asked of the debugger in this service's lifetime. */
    | 'idle'
    /** The route was hit; waiting for the app to exit so sdbd can relaunch it. */
    | 'launching'
    /** sdb/CDP handshake in flight. */
    | 'connecting'
    /** The userscript is being uploaded over CDP -- half a megabyte, on a TV. */
    | 'installing'
    /** Registered and sent to YouTube. Whether it RAN is a separate question. */
    | 'navigated'
    /** ...and the page answered a probe saying the mod is running in it. */
    | 'verified'
    /** The page said it was not, and it has been re-sent through the proxy. */
    | 'recovered'
    /** Gave up. Nothing was installed. */
    | 'failed';

export interface AttachReport {
    phase: AttachPhase;
    /** Which CDP command took, once one has. */
    method: string | null;
    /** One line, for a screen with no console attached. Never a stack. */
    error: string | null;
    /** Bumped per attempt, so a caller can tell a retry from a stall. */
    generation: number;
}

let attach: AttachReport = { phase: 'idle', method: null, error: null, generation: 0 };

/** The current attach, for whoever is reporting it over HTTP. */
export const attachState = (): AttachReport => ({ ...attach });

/**
 * Records a phase, and the one detail that goes with it.
 *
 * Deliberately not a state machine with guards: every caller is a failure path
 * in someone else's callback, and a guard that swallowed a transition would
 * leave the phase saying something that is no longer true -- which is the defect
 * this replaces, not an improvement on it.
 */
export function noteAttach(
    phase: AttachPhase,
    detail?: { method?: string | null; error?: string | null },
): void {
    attach = {
        phase,
        method: detail && detail.method !== undefined ? detail.method : attach.method,
        error: detail && detail.error !== undefined ? detail.error : attach.error,
        generation: phase === 'launching' ? attach.generation + 1 : attach.generation,
    };
}

/** Clears the per-attempt detail so a retry does not inherit the last error. */
function beginAttempt(): void {
    attach = { ...attach, method: null, error: null };
}

const fail = (error: string): void => {
    noteAttach('failed', { error });
};

/**
 * Where the proxy serves YouTube, with the same query the splash would have
 * used. 8099 is this service's express port; 8095 is the DIAL port, and the
 * mismatch is deliberate -- see watchUrl above.
 */
const proxyUrl = (args: string): string =>
    `http://localhost:8099/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8095%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}`;

/**
 * Asked of the page after it has loaded, to find out whether the userscript
 * actually RAN -- which is not the same question as whether CDP accepted it.
 *
 * `window.queuedVideos` is the first statement of mods/features/videoQueuing.ts,
 * at module scope with no condition on it, and videoQueuing is imported
 * unconditionally from the bundle entry. So it is set by the time the bundle has
 * finished evaluating, which is long before load. The name appears nowhere in
 * YouTube's own main.js, base.js or tv.html -- measured, not assumed -- so a
 * true answer cannot come from the app.
 *
 * test/injector/test.mjs pins the expression against the real built bundle, so
 * renaming the global fails the suite rather than silently turning every launch
 * into a recovery.
 */
export const BOOT_PROBE = 'typeof window.queuedVideos !== "undefined"';

/**
 * How long the probe waits for the page to load before giving up on verifying.
 *
 * Generous on purpose. A cold youtube.com/tv on a television is seconds of
 * script, and the cost of waiting too long is nothing -- the page is already in
 * front of the viewer and the flag was cleared before this started. The cost of
 * waiting too briefly would be a re-navigation of a page that was fine.
 */
export const VERIFY_TIMEOUT_MS = 20000;

const watchUrl = (args: string): string =>
    // 8095, not 8085: index.ts sets global.isTizenTube before requiring the DIAL
    // service, and service.ts binds 8095 in that case. standalone/index.html's
    // proxy branch already uses 8095 -- this path disagreed with it and pointed
    // the cast payload at a port nothing listens on inside the standalone app.
    // package.json's websiteURL stays 8085: that drives the TizenBrew module,
    // where isTizenTube is falsy and the DIAL server really does bind 8085.
    `https://youtube.com/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8095%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}`;

// Packaged into the build, so this resolves immediately. Only a source
// checkout that has not been built has to download it, and starting that here
// overlaps it with the debugger handshake instead of being serial with it.
userScript.get().catch(() => {});

/**
 * Registers the userscript so it runs before any of the page's own scripts, on
 * every document. Falls back through the older protocol commands, and reports
 * which one took so the caller knows whether it still needs to inject by hand.
 */
function registerOnNewDocument(client: CDPClient, source: string): Promise<string | null> {
    return client.Page.addScriptToEvaluateOnNewDocument({ source })
        .then(() => 'addScriptToEvaluateOnNewDocument')
        .catch(() =>
            client.Page.addScriptToEvaluateOnLoad({ scriptSource: source }).then(
                () => 'addScriptToEvaluateOnLoad',
            ),
        )
        .catch(() => null);
}

/**
 * Asks the page whether the mod is actually in it, and fixes it if not.
 *
 * WHY THIS IS NOT PARANOIA. Everything before this point proves that CDP
 * ACCEPTED the script, not that it ran. `addScriptToEvaluateOnNewDocument`
 * resolving means the browser stored it; the Runtime.evaluate fallback below
 * does not even mean that, because its promise is neither returned nor awaited
 * anywhere. The one thing that settles the question is asking the document.
 *
 * FAIL-SAFE IN ONE DIRECTION ONLY. A probe that errors, times out, or comes back
 * with anything other than a boolean changes nothing at all: the phase stays
 * `navigated`, which is exactly as much as was known before it ran. Only a
 * literal `false` -- the page loaded, the expression evaluated, and the mod is
 * not there -- re-navigates, and that costs one page load on a path that had
 * already failed silently. Erring the other way would make every television
 * whose CDP build answers evaluate differently look broken.
 *
 * Never rejects. It is called after `isConnecting` has been cleared, and a
 * rejection would fall into connectToDebugger's catch and navigate a second
 * time.
 */
function verifyInjection(client: CDPClient, args: string): Promise<void> {
    const loaded = new Promise<boolean>((resolve) => {
        // Page.enable() was awaited before the navigate, so the event is being
        // delivered. Subscribed through the generic `on`, which is the form this
        // file already uses -- see the note in types/modules.d.ts.
        client.on('Page.loadEventFired', () => resolve(true));
    });
    const expired = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), VERIFY_TIMEOUT_MS);
    });

    return Promise.race([loaded, expired])
        .then((ready: boolean) => {
            if (!ready) throw new Error('the page never fired load');
            return client.Runtime.evaluate({ expression: BOOT_PROBE, returnByValue: true });
        })
        .then((answer: RemoteResult | unknown) => {
            const value = (answer as RemoteResult | null)?.result?.value;
            if (value === true) {
                noteAttach('verified', { error: null });
                return;
            }
            if (value !== false) throw new Error('the probe answered with nothing');

            console.error(
                '[TizenTube] The registered userscript did not run; retrying through the proxy.',
            );
            // The proxy splices the script into <head> as a parser-blocking tag,
            // so it needs no CDP at all. A different route to the same result.
            return client.Page.navigate({ url: proxyUrl(args) }).then(() => {
                noteAttach('recovered', { error: 'the injected script did not run' });
            });
        })
        .catch((e: Error) => {
            // Unverified is not failed. The script was registered and the page was
            // sent; all that is missing is the confirmation.
            console.warn('[TizenTube] Could not verify the injection:', e && e.message);
        });
}

function connectToDebugger(host: string, port: number, args: string, attempt: number = 0): void {
    nodeFetch(`http://${host}:${port}`)
        .then(() => {
            const notifier = CDP({ host, port, local: true }, (client: CDPClient) => {
                // isConnecting is deliberately NOT cleared here. Connecting is not
                // attaching: the userscript still has to be read and uploaded --
                // half a megabyte over CDP -- and the page still has to be
                // navigated. Clearing it on connect told the splash the attach was
                // finished while all of that was outstanding, and the splash's
                // "daemon reachable, idle" branch fires /tizentube/debugger and then
                // exits the app.
                //
                // That is a loop, not a one-off: `sdb shell debug` relaunches the
                // app, so the relaunched splash polls, sees the flag already
                // cleared, and exits the app out from under the attach that is
                // still uploading -- which starts another one. Nothing on the
                // device breaks the cycle, which is exactly why recovering from it
                // took a reboot.
                //
                // The 45s generation-checked watchdog in startDebugger is the
                // backstop, so a chain that never settles still cannot latch the
                // flag forever and leave the splash waiting.
                Promise.all([client.Runtime.enable(), client.Page.enable()])
                    // Before navigating, so the very first document is covered.
                    .then(() => client.Page.setBypassCSP({ enabled: true }).catch(() => {}))
                    .then(() => userScript.get())
                    .then((source: string | null) => {
                        if (!source) throw new Error('empty userscript');
                        noteAttach('installing');
                        return registerOnNewDocument(client, source).then((method) => {
                            if (!method) {
                                // Last resort on protocol versions without either
                                // command: inject into each context as it appears.
                                // This is the losing side of the race the two
                                // commands above exist to avoid.
                                client.on('Runtime.executionContextCreated', (m) => {
                                    client.Runtime.evaluate({
                                        expression: source,
                                        contextId: m.context.id,
                                    });
                                });
                            }
                            // Recorded either way, including the fallback. A report
                            // that called the losing side of the race a clean
                            // attach is what made the difference invisible.
                            noteAttach('installing', {
                                method: method || 'Runtime.executionContextCreated',
                            });
                            return client.Page.navigate({ url: watchUrl(args) });
                        });
                    })
                    // The attach is over only here: the script is registered for
                    // every future document and the page has been sent to YouTube.
                    .then(() => {
                        noteAttach('navigated');
                        isConnecting = false;
                        // After the flag, deliberately. Verification is a question
                        // about a page that has already been handed over, and
                        // holding isConnecting across it would reintroduce exactly
                        // the stall this file's other comments are about.
                        return verifyInjection(client, args);
                    })
                    .catch((e: Error) => {
                        const message = (e && e.message) || 'unknown error';
                        console.error('[TizenTube] Could not install the userscript:', message);
                        // Still show YouTube rather than leaving a blank app, and
                        // only report the attach finished once that has been sent.
                        //
                        // THROUGH THE PROXY, WHEN THERE IS A SCRIPT TO SERVE. This
                        // used to send the page to https://youtube.com with nothing
                        // installed -- a coded path to "the app runs, the mod is
                        // simply not in it, and nothing says so". The proxy reaches
                        // the same place by splicing the userscript into <head> as a
                        // parser-blocking tag, which needs no CDP and cannot lose
                        // the race. Only when the failure WAS the userscript is
                        // plain YouTube the better answer, because the proxy would
                        // then serve the same missing script behind a second page
                        // load.
                        const viaProxy = message !== 'empty userscript';
                        fail(message);
                        client.Page.navigate({ url: viaProxy ? proxyUrl(args) : watchUrl(args) })
                            .catch(() => {})
                            .then(() => {
                                if (viaProxy) noteAttach('recovered', { error: message });
                                isConnecting = false;
                            });
                    });
            });

            // chrome-remote-interface's callback form returns a bare EventEmitter and
            // ends every failure in emit('error'). With no listener, that emit THROWS,
            // from inside a .catch on a promise nobody holds -- an unhandled rejection
            // that either kills the service or vanishes silently, and either way the
            // client callback above never runs and isConnecting stays latched.
            // 'No inspectable targets' is a real case here: the app was relaunched
            // microseconds ago and may not have registered a target yet.
            notifier.on('error', (e: Error) => {
                console.error('[TizenTube] CDP attach failed:', e && e.message);
                if (attempt >= 300) {
                    fail(`the debugger never accepted a connection (${(e && e.message) || '?'})`);
                    isConnecting = false;
                    return;
                }
                setTimeout(() => connectToDebugger(host, port, args, attempt + 1), 100);
            });
        })
        .catch(() => {
            // The debugger port takes a moment to come up. Bounded at ~30s, rather
            // than retrying every 100ms for the life of the service.
            if (attempt >= 300) {
                fail(`the debugger port ${port} never came up`);
                isConnecting = false;
                console.error('[TizenTube] Debugger never became reachable on port', port);
                return;
            }
            setTimeout(() => connectToDebugger(host, port, args, attempt + 1), 100);
        });
}

export interface DaemonState {
    canConnectToDaemon: boolean;
    ip: string;
    isConnecting: boolean;
}

function canConnectToDaemon(attempt: number = 0): Promise<DaemonState> {
    return nodeFetch('http://127.0.0.1:8001/api/v2/')
        .then((res) => res.json())
        .then((json: any) => {
            // Validated before reading: a payload without `device` used to throw
            // into the catch below, which retried forever rather than reporting a
            // result.
            const device = json && json.device;
            if (!device) throw new Error('no device in /api/v2/ payload');
            return {
                canConnectToDaemon:
                    (device.developerIP === '127.0.0.1' || device.developerIP === '1.0.0.127') &&
                    device.developerMode === '1',
                ip: device.ip,
                isConnecting,
            };
        })
        .catch(() => {
            // Retried on a timer. Recursing straight from the catch made this a
            // hot loop hammering the daemon as fast as the network stack allowed
            // whenever it was unreachable.
            //
            // Bounded at ~10s, because /tizentube/getState awaits this promise:
            // retrying forever meant that endpoint never responded at all, and the
            // splash waits on it. Reporting "no daemon" instead lets the page fall
            // back to the 8099 proxy, which needs no sdb.
            if (attempt >= 20) {
                console.error('[TizenTube] sdb daemon never answered; reporting no daemon');
                return { canConnectToDaemon: false, ip: '', isConnecting };
            }
            return new Promise<DaemonState>((resolve) => {
                setTimeout(() => resolve(canConnectToDaemon(attempt + 1)), 500);
            });
        });
}

function startDebugger(args: string): Promise<boolean> {
    beginAttempt();
    return canConnectToDaemon().then((res) => {
        if (!res.canConnectToDaemon) {
            // Reachable: the splash decided to attach from a getState taken
            // earlier, and developer mode can be switched off between the two.
            fail('developer mode is off, or the sdb daemon stopped answering');
            return false;
        }
        const client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });

        // adbhost attaches no 'error' handler of its own, and an unhandled 'error'
        // on a net.Socket is thrown by EventEmitter -- from an I/O callback, with
        // nothing above it to catch.
        client._stream.on('error', (e: Error) => {
            fail(`the sdb connection failed (${(e && e.message) || '?'})`);
            isConnecting = false;
            console.error('[TizenTube] sdb connection failed:', e && e.message);
        });

        client._stream.on('connect', () => {
            const packageId = tizen.application.getAppInfo().packageId;
            const gen = ++connectGeneration;
            isConnecting = true;
            noteAttach('connecting');
            // Nothing clears this on the paths where sdbd never replies with a
            // port, and the splash polls getState until something does. Longer
            // than connectToDebugger's own ~30s budget so it cannot pre-empt a
            // live attach, and generation-checked so it only ever clears its own.
            setTimeout(() => {
                if (connectGeneration === gen) {
                    // Only when nothing later got anywhere. The watchdog outlives
                    // a successful attach by design, and overwriting a `navigated`
                    // or `verified` phase with `failed` 45 seconds after the fact
                    // would tell the next launch to avoid a route that works.
                    if (attach.phase === 'connecting' || attach.phase === 'installing') {
                        fail('the debugger attach timed out');
                    }
                    isConnecting = false;
                    console.error('[TizenTube] debugger attach timed out');
                }
            }, 45000);

            // The trailing ' 0' argument was for Tizen 3.0, which config.xml's
            // required_version="9.0" now excludes outright.
            const shellCmd = client.createStream(`shell:0 debug ${packageId}.TizenTubeStandalone`);
            shellCmd.on('error', () => {
                fail('sdbd rejected the debug launch');
                isConnecting = false;
            });

            // Accumulated, because 'data' is not line-buffered: sdbd's reply can
            // arrive split across chunks ('debug_por' then 't:34567'), and only the
            // first would have matched. Anchored on the colon AFTER 'debug' rather
            // than the first colon in the chunk, and range-checked -- the old
            // fixed-width substr produced NaN whenever any of that varied.
            let buf = '';
            shellCmd.on('data', (data: Buffer) => {
                buf += data.toString();
                const m = /debug[^:]*:\s*(\d{1,5})/.exec(buf);
                if (!m) return;
                const port = Number(m[1]);
                buf = '';
                if (!port || port > 65535) {
                    fail('sdbd did not report a usable debug port');
                    isConnecting = false;
                    console.error('[TizenTube] Could not parse the debug port from sdbd');
                    return;
                }
                connectToDebugger(res.ip, port, args);
                setTimeout(() => client._stream.end(), 1000);
            });
        });

        return true;
    });
}

export { startDebugger, canConnectToDaemon };
