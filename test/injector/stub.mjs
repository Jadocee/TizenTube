// Stubs for the standalone injector: a fake sdbd over adbhost, a fake CDP
// endpoint, and a packaged userscript. The important knob is how long
// addScriptToEvaluateOnNewDocument takes -- half a megabyte over CDP on a TV is
// not instant, and that upload window is exactly where the attach race lives.

export const trace = [];
export const knobs = {
    uploadMs: 50, // how long the script upload takes
    navigateMs: 10, // how long Page.navigate takes
    connectMs: 5, // how long CDP takes to hand back a client
    fetchOk: true, // whether the debugger port answers HTTP
    registerOk: true, // whether addScriptToEvaluateOnNewDocument succeeds
    userScript: 'console.log("tizentube")',
    debugPort: 7011, // what sdbd reports back
    sdbReplyMs: 10, // how long sdbd takes to answer
};

export const reset = () => {
    trace.length = 0;
    Object.assign(knobs, {
        uploadMs: 50,
        navigateMs: 10,
        connectMs: 5,
        fetchOk: true,
        registerOk: true,
        userScript: 'console.log("tizentube")',
        debugPort: 7011,
        sdbReplyMs: 10,
    });
};

const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

export const nodeFetch = (url) => {
    trace.push(`fetch:${url}`);
    // The daemon probe, answered as a developer-mode TV pointed at itself.
    if (String(url).includes('8001/api/v2')) {
        return Promise.resolve({
            json: () =>
                Promise.resolve({
                    device: { developerIP: '127.0.0.1', developerMode: '1', ip: '127.0.0.1' },
                }),
        });
    }
    return knobs.fetchOk
        ? Promise.resolve({ ok: true })
        : Promise.reject(new Error('ECONNREFUSED'));
};

export const userScript = {
    get: () => Promise.resolve(knobs.userScript),
};

/** The CDP client the injector drives. Every call is recorded, in order. */
function makeClient() {
    const listeners = {};
    return {
        on: (evt, fn) => {
            listeners[evt] ||= [];
            listeners[evt].push(fn);
        },
        Runtime: {
            enable: () => {
                trace.push('Runtime.enable');
                return Promise.resolve();
            },
            evaluate: () => {
                trace.push('Runtime.evaluate');
                return Promise.resolve();
            },
        },
        Page: {
            enable: () => {
                trace.push('Page.enable');
                return Promise.resolve();
            },
            setBypassCSP: () => {
                trace.push('Page.setBypassCSP');
                return Promise.resolve();
            },
            addScriptToEvaluateOnNewDocument: () => {
                trace.push('upload:start');
                if (!knobs.registerOk) return Promise.reject(new Error('not supported'));
                return later(knobs.uploadMs).then(() => {
                    trace.push('upload:done');
                });
            },
            addScriptToEvaluateOnLoad: () => {
                trace.push('upload:legacy');
                return later(knobs.uploadMs).then(() => {
                    trace.push('upload:done');
                });
            },
            navigate: () => {
                trace.push('navigate:start');
                return later(knobs.navigateMs).then(() => {
                    trace.push('navigate:done');
                });
            },
        },
    };
}

/** chrome-remote-interface's callback form: returns a bare EventEmitter. */
export default function CDP(_opts, cb) {
    const handlers = {};
    setTimeout(() => {
        trace.push('cdp:connected');
        cb(makeClient());
    }, knobs.connectMs);
    return {
        on: (evt, fn) => {
            handlers[evt] ||= [];
            handlers[evt].push(fn);
        },
        emit: (evt, a) => (handlers[evt] || []).forEach((f) => f(a)),
    };
}

/**
 * A fake sdbd. createConnection hands back something shaped like adbhost's
 * client; the harness drives its 'connect' event, and the shell stream answers
 * `shell:0 debug <app>` with a debug port the way sdbd does -- split across two
 * chunks, because it is not line-buffered.
 */
export const adbhost = {
    createConnection: () => {
        const streamHandlers = {};
        const client = {
            _stream: {
                on: (evt, fn) => {
                    streamHandlers[evt] ||= [];
                    streamHandlers[evt].push(fn);
                },
                end: () => {
                    trace.push('sdb:end');
                },
            },
            createStream: (cmd) => {
                trace.push(`sdb:${cmd}`);
                const h = {};
                const shell = {
                    on: (evt, fn) => {
                        h[evt] ||= [];
                        h[evt].push(fn);
                    },
                };
                // sdbd answers a moment later, in two chunks.
                setTimeout(() => {
                    (h.data || []).forEach((f) => f(Buffer.from('debug_por')));
                    (h.data || []).forEach((f) => f(Buffer.from(`t: ${knobs.debugPort}\n`)));
                }, knobs.sdbReplyMs);
                return shell;
            },
        };
        setTimeout(() => {
            trace.push('sdb:connected');
            (streamHandlers.connect || []).forEach((f) => f());
        }, 1);
        return client;
    },
};

/** Tizen's app info, which startDebugger reads for the package id. */
export const installTizenGlobal = () => {
    globalThis.tizen = { application: { getAppInfo: () => ({ packageId: 'xvvl3S1TT1' }) } };
};
