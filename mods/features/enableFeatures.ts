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
// The Map is one of _yttv's own, so its value type is whatever YouTube stores.
let previewFlags: Map<string, any> | null = null;

let attempts = 0;

function enableFeatures() {
    if (!previewFlags) {
        previewFlags = window._yttv
            ? Object.values(window._yttv).find(a => a instanceof Map && a.has("ENABLE_PREVIEWS_WITH_SOUND"))
            : null;
        if (!previewFlags) {
            // The retry used to cover only the outer `!window._yttv` test, but
            // _yttv is published early and filled in progressively as YouTube
            // registers its modules -- so "the registry exists" and "the flag
            // Map is in it" are two different moments, and a miss here means
            // "not yet", not "never". Without this the flag was only ever
            // applied if the user happened to toggle the setting by hand.
            // Capped the same way pictureInPicture.ts caps its poll.
            if (++attempts <= 240) setTimeout(enableFeatures, 250);
            return;
        }
    }

    // Enable preview mode
    previewFlags.set("ENABLE_PREVIEWS_WITH_SOUND", configRead('enablePreviews'));
}

if (document.readyState === 'complete') {
    enableFeatures();
} else window.addEventListener('load', enableFeatures);