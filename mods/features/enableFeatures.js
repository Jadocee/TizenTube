// Enable features that aren't enabled by default due to YT seeing the TV as a low-end device
import { configRead, configChangeEmitter } from '../config.js';

configChangeEmitter.addEventListener('configChange', (event) => {
    // Every other listener in the mod filters by key; this one re-ran a full
    // scan of _yttv for unrelated toggles.
    if (event.detail.key !== 'enablePreviews') return;
    enableFeatures();
});

// Resolved once. _yttv is large, and finding the same Map again on every config
// change is a linear scan with an instanceof per entry for no new information.
let previewFlags = null;

function enableFeatures() {
    if (!previewFlags) {
        if (!window._yttv) return setTimeout(enableFeatures, 250);
        previewFlags = Object.values(window._yttv).find(a => a instanceof Map && a.has("ENABLE_PREVIEWS_WITH_SOUND"));
        if (!previewFlags) return;
    }

    // Enable preview mode
    previewFlags.set("ENABLE_PREVIEWS_WITH_SOUND", configRead('enablePreviews'));
}

if (document.readyState === 'complete') {
    enableFeatures();
} else window.addEventListener('load', enableFeatures);