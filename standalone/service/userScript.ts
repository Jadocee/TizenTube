// Where the userscript comes from.
//
// The standalone app used to pull it from jsdelivr on every launch. That put a
// network round trip on the critical path, and a CDN outage or a TV with no
// network produced an app running with no mod in it at all — silently.
//
// It is packaged into this service at build time, so the .wgt is self-contained
// and the script is available instantly and offline. No network is consulted at
// all: see UPDATE_SOURCE below for why the CDN check is off rather than merely
// repointed.

import fetch from 'node-fetch';

/**
 * Where a newer userscript may be fetched from, or null to run only the copy
 * packaged into this build.
 *
 * It is null, and that is the whole point of this block.
 *
 * This used to be @foxreis/tizentube on jsdelivr, which is UPSTREAM's npm
 * package -- a different project. The mechanism works by version number alone:
 * refresh() reads the published package.json, and if its version is higher than
 * the packaged one it downloads that project's dist/userScript.js and serves it
 * in place of this one. Both sat at 1.14.8, so nothing had happened yet, but the
 * first upstream release above that would have silently replaced this fork's
 * userscript on every installed TV -- swapping in a build that targets a
 * different platform floor and does not contain any of this fork's fixes. A
 * self-updater pointed at somebody else's package is a supply chain, not a
 * feature.
 *
 * TizenTube 9 now publishes @jadocee/tizentube-9, so a legitimate source finally
 * exists -- but this stays null, deliberately. That package is the TizenBrew
 * module, a separate delivery route with its own version line; wiring the .wgt's
 * updater to it would mean a TV silently swapping in a build it was not shipped
 * with, on a version comparison alone. The .wgt is self-contained: the script is
 * embedded at build time and updating means installing a new package. Turning
 * this on is a decision to take on its own merits, not a consequence of the
 * package existing.
 *
 * To turn updates back on, set this to a source THIS fork controls -- its own
 * npm package, or its own GitHub release assets -- and nothing else. The shape
 * is deliberately a pair of URLs rather than a package name, so pointing it at a
 * release asset does not require rewriting the fetch logic.
 */
const UPDATE_SOURCE: { manifest: string; userScript: string } | null = null;

const ALLOW_CDN_UPDATES = UPDATE_SOURCE !== null;

interface PackagedUserScript {
    version: string;
    source: string;
}

let packaged: PackagedUserScript | null = null;
try {
    // Written by embed-userscript.js. Absent in a source checkout that has not
    // been built, in which case we fall back to downloading.
    packaged = require('./userScript.generated.js');
} catch (_e) {
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

    if (!UPDATE_SOURCE) return Promise.resolve(source);

    pending = fetch(UPDATE_SOURCE.userScript)
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

    return fetch(UPDATE_SOURCE!.manifest)
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .then((manifest: { version?: string } | null) => {
            if (!manifest || !manifest.version || !isNewer(manifest.version, version)) return false;
            console.log(
                `[TizenTube] Newer userscript published (${manifest.version} > ${version}); fetching.`,
            );
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
