// AiSList: a community-maintained list of YouTube channels that primarily
// publish AI-generated content. https://github.com/Override92/AiSList
//
// THE LIST IS FETCHED, NEVER BUNDLED, AND THAT IS A LICENCE REQUIREMENT RATHER
// THAN A PREFERENCE. AiSList is CC BY-NC 4.0; TizenTube is GPLv3. The
// NonCommercial term is not among the additional terms GPLv3 section 7 permits,
// so shipping the data inside this repository or inside the signed .wgt would
// impose a further restriction on the combined work. Fetching it onto the
// television at runtime keeps the GPL'd code free of it -- and keeps the list
// current, which a copy frozen at build time would not be.
//
// It is also worth being explicit that this is DATA, not code. This repository
// deliberately severed its jsDelivr userscript self-updater as a supply-chain
// hazard, and the distinction matters: a channel list can only ever cause a tile
// to be hidden. Nothing here is executed. The setting still defaults off and
// names its source.
//
// Measured against the real published list: 20,982 entries, 100% @handles and
// zero channel ids despite the header advertising both. 498 of those handles are
// percent-encoded or non-ASCII, which is why aisListParse normalises both sides.

import { configRead } from '../config.js';
import {
    parseList,
    readLastModified,
    indexHasChannel,
    serialiseIndex,
    deserialiseIndex,
    emptyIndex,
    type ChannelIndex,
} from './aisListParse.js';

/** Native, for the same reason aisListParse captures one: readStore runs inside
 *  adblock.ts's JSON.parse patch on the per-tile path. */
const nativeParse = JSON.parse;

const BASE = 'https://raw.githubusercontent.com/Override92/AiSList/main/AiSList/';
export const SOURCES = {
    block: `${BASE}aislist_blocklist.txt`,
    warn: `${BASE}aislist_warnlist.txt`,
};

/** Its own storage key, NOT config. mods/config.ts keeps the whole config as one
 *  JSON blob and rewrites all of it on every configWrite, so 383 KB of channel
 *  handles in there would be rewritten every time any setting changed. */
const STORE = 'tizentube.aislist';

/** How long a cached copy is used before revalidating. The list moves by tens of
 *  entries a day; a television checking twice a day is plenty, and the ETag
 *  makes the check a 304 rather than another 358 KB. */
const TTL_MS = 12 * 60 * 60 * 1000;

interface Cached {
    block?: string;
    warn?: string;
    etags?: Record<string, string>;
    /** When the BLOCKLIST was last revalidated. Kept for the settings screen and
     *  for reading caches written before `at` existed. */
    fetchedAt?: number;
    /** Per source, keyed by URL. One shared timestamp meant turning the warnlist
     *  on inside the blocklist's 12-hour window fetched nothing at all, and a
     *  warnlist left cached from months ago was used as current. */
    at?: Record<string, number>;
}

let blockIndex: ChannelIndex = emptyIndex();
let warnIndex: ChannelIndex = emptyIndex();
let loaded = false;
let refreshing = false;

function readStore(): Cached {
    try {
        const raw = window.localStorage.getItem(STORE);
        return raw ? nativeParse(raw) : {};
    } catch (_e) {
        return {};
    }
}

function writeStore(next: Cached): void {
    try {
        window.localStorage.setItem(STORE, JSON.stringify(next));
    } catch (e) {
        // Over quota, or storage disabled. The list still works for this
        // session; it will simply be fetched again next launch.
        console.warn('[TizenTube] could not cache the AiSList data', e);
    }
}

/**
 * Loads whatever is cached, synchronously.
 *
 * Called before the first filter runs, so a television that already has the list
 * starts filtering on the first painted shelf rather than after a network round
 * trip. A cold start simply filters nothing until the fetch lands, which is the
 * right way round: showing a channel that should have been hidden is recoverable,
 * blocking the home page on a download is not.
 */
export function loadCached(): void {
    if (loaded) return;
    loaded = true;
    const cached = readStore();
    blockIndex = deserialiseIndex(cached.block) || emptyIndex();
    warnIndex = deserialiseIndex(cached.warn) || emptyIndex();
}

/** Is this channel on the lists the user has turned on? */
export function isAiChannel(channel: { id?: string; handle?: string } | null | undefined): boolean {
    if (!channel) return false;
    if (!configRead('enableAiSList')) return false;
    loadCached();
    if (indexHasChannel(blockIndex, channel)) return true;
    if (configRead('aisListIncludeWarnlist') && indexHasChannel(warnIndex, channel)) return true;
    return false;
}

/** What the settings screen shows, so the feature is not invisible. */
export function aisListStatus(): {
    block: number;
    warn: number;
    lastModified: string | null;
    fetchedAt: number;
} {
    loadCached();
    const cached = readStore();
    return {
        block: blockIndex.count || blockIndex.handles.size,
        warn: warnIndex.count || warnIndex.handles.size,
        lastModified: blockIndex.lastModified,
        fetchedAt: cached.fetchedAt || 0,
    };
}

async function fetchOne(
    url: string,
    etag: string | undefined,
): Promise<{ text: string | null; etag: string | null }> {
    const headers: Record<string, string> = {};
    // A conditional request turns the recurring cost into a 304 rather than
    // another 358 KB download. raw.githubusercontent.com sends a strong ETag.
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetch(url, { headers });
    if (response.status === 304) return { text: null, etag: etag || null };
    if (!response.ok) throw new Error(`AiSList ${url} responded ${response.status}`);
    return { text: await response.text(), etag: response.headers.get('etag') };
}

/**
 * Revalidates the cached lists, at most once per TTL.
 *
 * Never throws to its caller and never blocks anything: a failure leaves
 * whatever was already cached in place, which is exactly what should happen when
 * a television has a flaky connection.
 */
export async function refresh(force = false): Promise<void> {
    if (refreshing) return;
    if (!configRead('enableAiSList')) return;
    loadCached();

    const cached = readStore();
    const now = Date.now();
    const wantWarn = configRead('aisListIncludeWarnlist');
    // Each list decides for itself. A single shared timestamp meant the answer
    // for the warnlist was really the answer for the blocklist: turn the
    // warnlist on an hour after a blocklist refresh and the early return below
    // fired, so it was never fetched -- for the whole session, and again on
    // every launch that landed inside the same 12-hour window.
    const stale = (url: string, index: ChannelIndex): boolean =>
        force || !index.handles.size || now - sourceFetchedAt(cached, url) >= TTL_MS;

    const blockStale = stale(SOURCES.block, blockIndex);
    const warnStale = wantWarn && stale(SOURCES.warn, warnIndex);
    if (!blockStale && !warnStale) return;

    refreshing = true;
    try {
        // Written after EACH source rather than once at the end. The two lists
        // are independent resources on a flaky connection, and a single
        // all-or-nothing write meant a 404 on the warnlist discarded the 357 KB
        // blocklist that had just been downloaded -- so it was re-downloaded and
        // re-discarded on every launch, forever, with no console to say so.
        if (blockStale) {
            await fetchInto(
                SOURCES.block,
                (text) => {
                    const parsed = parseList(text);
                    if (!looksLikeList(text, parsed)) return null;
                    blockIndex = parsed;
                    return serialiseIndex(blockIndex);
                },
                'block',
                now,
            );
        }
        if (warnStale) {
            await fetchInto(
                SOURCES.warn,
                (text) => {
                    const parsed = parseList(text);
                    if (!looksLikeList(text, parsed)) return null;
                    warnIndex = parsed;
                    return serialiseIndex(warnIndex);
                },
                'warn',
                now,
            );
        }
    } finally {
        refreshing = false;
    }
}

/** When this source was last revalidated. Falls back to the old single
 *  timestamp so a cache written by an earlier build is not treated as ancient
 *  and re-downloaded on first launch after an update. */
function sourceFetchedAt(cached: Cached, url: string): number {
    const per = cached.at && cached.at[url];
    if (typeof per === 'number') return per;
    return url === SOURCES.block ? cached.fetchedAt || 0 : 0;
}

/**
 * Fetches one source and persists just that one.
 *
 * Never throws. A failure leaves the other list's cache untouched and whatever
 * was already stored for this one in place, which is what should happen on a
 * television with a flaky connection.
 */
/**
 * Is this body actually one of the lists?
 *
 * A captive portal -- hotel wifi, a guest network, a TV that has not finished
 * its own sign-on -- answers EVERY request with 200 and a login page. parseList
 * finds no entries in HTML and returns an empty index, which then replaced a
 * working 20,982-entry list, got cached, and had its timestamp advanced: the
 * feature silently stopped hiding anything for the next twelve hours, on a
 * device with no console. A real list either has entries or carries the header
 * comment; a login page has neither.
 *
 * An upstream that genuinely publishes an empty list still empties the index,
 * which is correct -- it keeps its header.
 */
function looksLikeList(text: string, index: ChannelIndex): boolean {
    return index.count > 0 || readLastModified(text) !== null;
}

async function fetchInto(
    url: string,
    parse: (text: string) => string | null,
    slot: 'block' | 'warn',
    now: number,
): Promise<void> {
    try {
        // Re-read rather than closing over one snapshot: the block write has
        // already landed by the time the warn fetch resolves.
        const cached = readStore();
        const result = await fetchOne(url, (cached.etags || {})[url]);
        const next: Cached = {
            ...cached,
            etags: { ...(cached.etags || {}) },
            at: { ...(cached.at || {}) },
        };
        // null means 304: the stored copy is still current, so only its
        // timestamp moves. Re-parsing nothing is the point of the ETag.
        if (result.text !== null) {
            const parsed = parse(result.text);
            // Not a list. Leave the cache and the timestamp alone so the next
            // launch tries again rather than sitting on a login page for the
            // whole TTL.
            if (parsed === null) {
                console.warn(`[TizenTube] ${url} did not return a channel list`);
                return;
            }
            next[slot] = parsed;
        }
        if (result.etag) next.etags![url] = result.etag;
        next.at![url] = now;
        if (url === SOURCES.block) next.fetchedAt = now;
        writeStore(next);
    } catch (e) {
        console.warn(`[TizenTube] could not refresh ${url}`, e);
    }
}
