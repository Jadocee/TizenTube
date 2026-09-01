// What previewIndicator.ts reaches for outside itself. Deliberately thin: the
// module under test is the DOM shell, so everything it depends on is a spy and
// nothing here has behaviour of its own to get wrong.
export const store = { enablePreviewIndicator: true };
export const configRead = (k) => store[k];

const listeners = [];
export const configChangeEmitter = {
    addEventListener: (type, cb) => {
        if (type === 'configChange') listeners.push(cb);
    },
    removeEventListener: () => {},
    dispatchEvent: (e) => listeners.forEach((cb) => cb(e)),
};
export const configWrite = (key, value) => {
    store[key] = value;
    configChangeEmitter.dispatchEvent({ type: 'configChange', detail: { key, value } });
};

export const whenBodyReady = (cb) => cb();
export const setStyleBlock = () => {};
export const DEFAULT_PREVIEW_DURATION_MS = 40000;

/** playbackPreview's registration lists, exposed so the harness can fire them. */
export const startListeners = [];
export const stopListeners = [];
export const onPreviewStart = (fn) => startListeners.push(fn);
export const onPreviewStop = (fn) => stopListeners.push(fn);
