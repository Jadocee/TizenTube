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

import fetch from 'node-fetch';

const PACKAGE_NAME = '@foxreis/tizentube';
const USERSCRIPT_URL = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}/dist/userScript.js`;
const MANIFEST_URL = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}/package.json`;

// Set to false to pin the app to the packaged copy and never touch the network.
const ALLOW_CDN_UPDATES = true;

interface PackagedUserScript { version: string; source: string }

let packaged: PackagedUserScript | null = null;
try {
    // Written by embed-userscript.js. Absent in a source checkout that has not
    // been built, in which case we fall back to downloading.
    packaged = require('./userScript.generated.js');
} catch (e) {
    console.warn('[TizenTube] No packaged userscript in this build; will download it instead.');
}

let source: string | null = packaged ? packaged.source : null;
let version: string | null = packaged ? packaged.version : null;
let pending: Promise<string | null> | null = null;

function isNewer(candidate: string, current: string | null): boolean {
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

// Whether the most recent download() call actually fetched, as opposed to
// falling back to the copy already in hand.
let lastDownloadWasFresh = false;

function download(): Promise<string | null> {
    if (pending) return pending;
    lastDownloadWasFresh = false;

    pending = fetch(USERSCRIPT_URL)
        .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        })
        .then((text: string) => {
            if (text && text.length) {
                source = text;
                lastDownloadWasFresh = true;
            }
            pending = null;
            return source;
        })
        .catch((err: Error) => {
            console.error('[TizenTube] Could not download the userscript:', err.message);
            pending = null;
            // Whatever we already have beats nothing.
            return source;
        });

    return pending;
}

/** The userscript, from the package if it is there and the network if it is not. */
function get(): Promise<string | null> {
    if (source) return Promise.resolve(source);
    return download();
}

/**
 * Looks for a newer published release. Never blocks a page load: whatever it
 * finds is used from the next load onwards.
 */
function refresh(): Promise<boolean> {
    if (!ALLOW_CDN_UPDATES) return Promise.resolve(false);

    return fetch(MANIFEST_URL)
        .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then((manifest: { version?: string } | null) => {
            if (!manifest || !manifest.version || !isNewer(manifest.version, version)) return false;
            console.log(`[TizenTube] Newer userscript published (${manifest.version} > ${version}); fetching.`);
            const published = manifest.version;
            return download().then((text) => {
                // download() falls back to the packaged copy on failure, and that
                // is non-empty -- so a truthy result alone did not mean the new
                // version had been fetched. This used to record a version that
                // was never downloaded while still serving the old script.
                if (!text || !lastDownloadWasFresh) return false;
                version = published;
                return true;
            });
        })
        .catch((err: Error) => {
            console.warn('[TizenTube] Update check failed:', err.message);
            return false;
        });
}

export { get, refresh };
export const isPackaged = (): boolean => !!packaged;
export const currentVersion = (): string | null => version;
