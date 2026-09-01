// The TizenBrew-way of TizenTube. Uses CDP and SDB to inject the userscript.

import * as adbhost from 'adbhost';
import CDP from 'chrome-remote-interface';
import nodeFetch from 'node-fetch';
import * as userScript from './userScript.js';

let isConnecting = false;
// Bumped on every attach attempt so a watchdog armed by an earlier one cannot
// clear a later one's flag.
let connectGeneration = 0;

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
                            return client.Page.navigate({ url: watchUrl(args) });
                        });
                    })
                    // The attach is over only here: the script is registered for
                    // every future document and the page has been sent to YouTube.
                    .then(() => {
                        isConnecting = false;
                    })
                    .catch((e: Error) => {
                        console.error(
                            '[TizenTube] Could not install the userscript:',
                            e && e.message,
                        );
                        // Still show YouTube rather than leaving a blank app, and
                        // only report the attach finished once that has been sent.
                        client.Page.navigate({ url: watchUrl(args) })
                            .catch(() => {})
                            .then(() => {
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
    return canConnectToDaemon().then((res) => {
        if (!res.canConnectToDaemon) return false;
        const client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });

        // adbhost attaches no 'error' handler of its own, and an unhandled 'error'
        // on a net.Socket is thrown by EventEmitter -- from an I/O callback, with
        // nothing above it to catch.
        client._stream.on('error', (e: Error) => {
            isConnecting = false;
            console.error('[TizenTube] sdb connection failed:', e && e.message);
        });

        client._stream.on('connect', () => {
            const packageId = tizen.application.getAppInfo().packageId;
            const gen = ++connectGeneration;
            isConnecting = true;
            // Nothing clears this on the paths where sdbd never replies with a
            // port, and the splash polls getState until something does. Longer
            // than connectToDebugger's own ~30s budget so it cannot pre-empt a
            // live attach, and generation-checked so it only ever clears its own.
            setTimeout(() => {
                if (connectGeneration === gen) {
                    isConnecting = false;
                    console.error('[TizenTube] debugger attach timed out');
                }
            }, 45000);

            // The trailing ' 0' argument was for Tizen 3.0, which config.xml's
            // required_version="9.0" now excludes outright.
            const shellCmd = client.createStream(`shell:0 debug ${packageId}.TizenTubeStandalone`);
            shellCmd.on('error', () => {
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
