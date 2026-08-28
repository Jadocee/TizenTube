// The TizenBrew-way of TizenTube. Uses CDP and SDB to inject the userscript.

const adbhost = require('adbhost');
const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');


var isConnecting = false;
const isTizen3 = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version').startsWith('3.0');

const USERSCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js';

// Fetched once and reused. This used to be re-downloaded on every execution
// context, which put a network round trip between the page appearing and the
// mod running.
let userScript = null;

function fetchUserScript() {
    if (userScript) return Promise.resolve(userScript);
    return fetch(USERSCRIPT_URL)
        .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        })
        .then((text) => {
            if (text && text.length) userScript = text;
            return userScript;
        });
}

// Warmed at startup so the download overlaps the debugger handshake instead of
// being serial with it.
fetchUserScript().catch(() => { });

/**
 * Registers the userscript so it runs before any of the page's own scripts, on
 * every document. Falls back through the older protocol commands, and reports
 * which one took so the caller knows whether it still needs to inject by hand.
 */
function registerOnNewDocument(client, source) {
    return client.Page.addScriptToEvaluateOnNewDocument({ source })
        .then(() => 'addScriptToEvaluateOnNewDocument')
        .catch(() => client.Page.addScriptToEvaluateOnLoad({ scriptSource: source })
            .then(() => 'addScriptToEvaluateOnLoad'))
        .catch(() => null);
}

function connectToDebugger(host, port, args, attempt) {
    attempt = attempt || 0;

    fetch(`http://${host}:${port}`).then(_ => {
        CDP({ host, port, local: true }, client => {
            isConnecting = false;

            Promise.all([client.Runtime.enable(), client.Page.enable()])
                // Before navigating, so the very first document is covered.
                .then(() => client.Page.setBypassCSP({ enabled: true }).catch(() => { }))
                .then(() => fetchUserScript())
                .then((source) => {
                    if (!source) throw new Error('empty userscript');
                    return registerOnNewDocument(client, source).then((method) => {
                        if (!method) {
                            // Last resort on protocol versions without either
                            // command: inject into each context as it appears.
                            // This is the losing side of the race the two
                            // commands above exist to avoid.
                            client.on('Runtime.executionContextCreated', m => {
                                client.Runtime.evaluate({ expression: source, contextId: m.context.id });
                            });
                        }
                        return client.Page.navigate({
                            url: `https://youtube.com/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8085%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}`
                        });
                    });
                })
                .catch((e) => {
                    console.error('[TizenTube] Could not install the userscript:', e && e.message);
                    // Still show YouTube rather than leaving a blank app.
                    client.Page.navigate({
                        url: `https://youtube.com/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8085%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}`
                    }).catch(() => { });
                });
        })
    }).catch(e => {
        // The debugger port takes a moment to come up. Bounded at ~30s, rather
        // than retrying every 100ms for the life of the service.
        if (attempt >= 300) {
            isConnecting = false;
            console.error('[TizenTube] Debugger never became reachable on port', port);
            return;
        }
        return setTimeout(() => connectToDebugger(host, port, args, attempt + 1), 100);
    })
}

function canConnectToDaemon() {
    return fetch('http://127.0.0.1:8001/api/v2/').then(res => res.json())
        .then(json => {
            return { canConnectToDaemon: (json.device.developerIP === '127.0.0.1' || json.device.developerIP === '1.0.0.127') && json.device.developerMode === '1', ip: json.device.ip, isConnecting }
        }).catch(e => {
            // Retried on a timer. Recursing straight from the catch made this a
            // hot loop hammering the daemon as fast as the network stack allowed
            // whenever it was unreachable.
            return new Promise((resolve) => {
                setTimeout(() => resolve(canConnectToDaemon()), 500);
            });
        });
}

function startDebugger(args) {
    return canConnectToDaemon().then(res => {
        if (!res.canConnectToDaemon) return false;
        const client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });

        client._stream.on('connect', () => {
            const packageId = tizen.application.getAppInfo().packageId;
            isConnecting = true;
            const shellCmd = client.createStream(`shell:0 debug ${packageId}.TizenTubeStandalone${isTizen3 ? ' 0' : ''}`);
            shellCmd.on('data', (data) => {
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

module.exports = {
    startDebugger,
    canConnectToDaemon
};
