// The TizenBrew-way of TizenTube. Uses CDP and SDB to inject the userscript.

import * as adbhost from 'adbhost';
import CDP from 'chrome-remote-interface';
import nodeFetch from 'node-fetch';
import * as userScript from './userScript.js';

let isConnecting = false;
const isTizen3: boolean = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version').startsWith('3.0');

const watchUrl = (args: string): string =>
    `https://youtube.com/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8085%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}`;

// Packaged into the build, so this resolves immediately. Only a source
// checkout that has not been built has to download it, and starting that here
// overlaps it with the debugger handshake instead of being serial with it.
userScript.get().catch(() => { });

/**
 * Registers the userscript so it runs before any of the page's own scripts, on
 * every document. Falls back through the older protocol commands, and reports
 * which one took so the caller knows whether it still needs to inject by hand.
 */
function registerOnNewDocument(client: CDPClient, source: string): Promise<string | null> {
    return client.Page.addScriptToEvaluateOnNewDocument({ source })
        .then(() => 'addScriptToEvaluateOnNewDocument')
        .catch(() => client.Page.addScriptToEvaluateOnLoad({ scriptSource: source })
            .then(() => 'addScriptToEvaluateOnLoad'))
        .catch(() => null);
}

function connectToDebugger(host: string, port: number, args: string, attempt: number = 0): void {
    nodeFetch(`http://${host}:${port}`).then(() => {
        CDP({ host, port, local: true }, (client: CDPClient) => {
            isConnecting = false;

            Promise.all([client.Runtime.enable(), client.Page.enable()])
                // Before navigating, so the very first document is covered.
                .then(() => client.Page.setBypassCSP({ enabled: true }).catch(() => { }))
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
                                client.Runtime.evaluate({ expression: source, contextId: m.context.id });
                            });
                        }
                        return client.Page.navigate({ url: watchUrl(args) });
                    });
                })
                .catch((e: Error) => {
                    console.error('[TizenTube] Could not install the userscript:', e && e.message);
                    // Still show YouTube rather than leaving a blank app.
                    client.Page.navigate({ url: watchUrl(args) }).catch(() => { });
                });
        })
    }).catch(() => {
        // The debugger port takes a moment to come up. Bounded at ~30s, rather
        // than retrying every 100ms for the life of the service.
        if (attempt >= 300) {
            isConnecting = false;
            console.error('[TizenTube] Debugger never became reachable on port', port);
            return;
        }
        setTimeout(() => connectToDebugger(host, port, args, attempt + 1), 100);
    })
}

export interface DaemonState {
    canConnectToDaemon: boolean;
    ip: string;
    isConnecting: boolean;
}

function canConnectToDaemon(): Promise<DaemonState> {
    return nodeFetch('http://127.0.0.1:8001/api/v2/').then(res => res.json())
        .then((json: any) => {
            return { canConnectToDaemon: (json.device.developerIP === '127.0.0.1' || json.device.developerIP === '1.0.0.127') && json.device.developerMode === '1', ip: json.device.ip, isConnecting }
        }).catch(() => {
            // Retried on a timer. Recursing straight from the catch made this a
            // hot loop hammering the daemon as fast as the network stack allowed
            // whenever it was unreachable.
            return new Promise<DaemonState>((resolve) => {
                setTimeout(() => resolve(canConnectToDaemon()), 500);
            });
        });
}

function startDebugger(args: string): Promise<boolean> {
    return canConnectToDaemon().then(res => {
        if (!res.canConnectToDaemon) return false;
        const client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });

        client._stream.on('connect', () => {
            const packageId = tizen.application.getAppInfo().packageId;
            isConnecting = true;
            const shellCmd = client.createStream(`shell:0 debug ${packageId}.TizenTubeStandalone${isTizen3 ? ' 0' : ''}`);
            shellCmd.on('data', (data: Buffer) => {
                const dataString = data.toString();
                if (dataString.includes('debug')) {
                    const port = Number(dataString.substr(dataString.indexOf(':') + 1, 6).replace(' ', ''));
                    connectToDebugger(res.ip, port, args);
                    setTimeout(() => client._stream.end(), 1000);
                }
            });
        });

        return true;
    });
}

export { startDebugger, canConnectToDaemon };
