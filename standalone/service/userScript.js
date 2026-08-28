// Where the userscript comes from.
//
// The standalone app used to pull it from jsdelivr on every launch. That put a
// network round trip on the critical path, and a CDN outage or a TV with no
// network produced an app running with no mod in it at all — silently.
//
// It is now packaged into this service at build time, so the .wgt is
// self-contained and the script is available instantly and offline. The CDN is
// only consulted afterwards, in the background, and only to pick up a release
// newer than the packaged one.

const fetch = require('node-fetch');

const PACKAGE_NAME = '@foxreis/tizentube';
const USERSCRIPT_URL = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}/dist/userScript.js`;
const MANIFEST_URL = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}/package.json`;

// Set to false to pin the app to the packaged copy and never touch the network.
const ALLOW_CDN_UPDATES = true;

let packaged = null;
try {
    // Written by embed-userscript.js. Absent in a source checkout that has not
    // been built, in which case we fall back to downloading.
    packaged = require('./userScript.generated.js');
} catch (e) {
    console.warn('[TizenTube] No packaged userscript in this build; will download it instead.');
}

let source = packaged ? packaged.source : null;
let version = packaged ? packaged.version : null;
let pending = null;

function isNewer(candidate, current) {
    if (!current) return true;
    const a = String(candidate).split('.');
    const b = String(current).split('.');
    for (let i = 0; i < 3; i++) {
        const x = parseInt(a[i], 10) || 0;
        const y = parseInt(b[i], 10) || 0;
        if (x !== y) return x > y;
    }
    return false;
}

function download() {
    if (pending) return pending;

    pending = fetch(USERSCRIPT_URL)
        .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        })
        .then((text) => {
            if (text && text.length) source = text;
            pending = null;
            return source;
        })
        .catch((err) => {
            console.error('[TizenTube] Could not download the userscript:', err.message);
            pending = null;
            // Whatever we already have beats nothing.
            return source;
        });

    return pending;
}

/** The userscript, from the package if it is there and the network if it is not. */
function get() {
    if (source) return Promise.resolve(source);
    return download();
}

/**
 * Looks for a newer published release. Never blocks a page load: whatever it
 * finds is used from the next load onwards.
 */
function refresh() {
    if (!ALLOW_CDN_UPDATES) return Promise.resolve(false);

    return fetch(MANIFEST_URL)
        .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then((manifest) => {
            if (!manifest || !isNewer(manifest.version, version)) return false;
            console.log(`[TizenTube] Newer userscript published (${manifest.version} > ${version}); fetching.`);
            return download().then((text) => {
                if (!text) return false;
                version = manifest.version;
                return true;
            });
        })
        .catch((err) => {
            console.warn('[TizenTube] Update check failed:', err.message);
            return false;
        });
}

module.exports = {
    get,
    refresh,
    isPackaged: () => !!packaged,
    currentVersion: () => version
};
