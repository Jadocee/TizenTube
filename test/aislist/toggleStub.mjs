// aisListRefresh.ts's two dependencies. The point of the harness is WHEN
// refresh is called, so refresh is a counter and config is a real emitter.
export const store = { enableAiSList: false, aisListIncludeWarnlist: false };
export const configRead = (k) => store[k];

export const calls = [];
export const refresh = async (force) => {
    calls.push(force);
};

const listeners = [];
export const configChangeEmitter = {
    addEventListener: (type, cb) => {
        if (type === 'configChange') listeners.push(cb);
    },
    removeEventListener: () => {},
    dispatchEvent: (event) => listeners.forEach((cb) => cb(event)),
};
/** What mods/config.ts's configWrite does, minus the persistence. */
export const configWrite = (key, value) => {
    store[key] = value;
    configChangeEmitter.dispatchEvent({ type: 'configChange', detail: { key, value } });
};
