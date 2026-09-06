// The eight modules resolveCommand.ts imports, replaced by the smallest thing
// that lets the real dispatch run and be observed.
export const store = {};
export const writes = [];
export function configRead(k) {
    return store[k];
}
export function configWrite(k, v) {
    writes.push({ key: k, value: v });
    store[k] = v;
}
export function isConfigKey(k) {
    return k in store;
}

export const customActions = [];
export function noteCommand() {}
export function enablePip() {}
export function speedSettings() {}
export function showToast() {}
export function buttonItem() {
    return {};
}
export function addEntry() {}
export function parseEntry() {
    return {};
}
export default function checkForUpdates() {}
export function t(k) {
    return k;
}

// The settings redraws live in their own module: resolveCommand.ts imports a
// default from both updater.js and settings.js, and one module cannot have two.
export { redraws } from './settingsStub.mjs';
