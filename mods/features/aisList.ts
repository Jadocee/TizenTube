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
    indexHasChannel,
    serialiseIndex,
    deserialiseIndex,
    emptyIndex,
    type ChannelIndex,
} from './aisListParse.js';

const BASE = 'https://raw.githubusercontent.com/Override92/AiSList/main/AiSList/';
export const SOURCES = {
    block: BASE + 'aislist_blocklist.txt',
    warn: BASE + 'aislist_warnlist.txt',
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
    fetchedAt?: number;
}

let blockIndex: ChannelIndex = emptyIndex();
let warnIndex: ChannelIndex = emptyIndex();
let loaded = false;
let refreshing = false;

function readStore(): Cached {
    try {
        const raw = window.localStorage.getItem(STORE);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
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
export function aisListStatus(): { block: number; warn: number; lastModified: string | null; fetchedAt: number } {
    loadCached();
    const cached = readStore();
    return {
        block: blockIndex.count || blockIndex.handles.size,
        warn: warnIndex.count || warnIndex.handles.size,
        lastModified: blockIndex.lastModified,
        fetchedAt: cached.fetchedAt || 0,
    };
}

async function fetchOne(url: string, etag: string | undefined): Promise<{ text: string | null; etag: string | null }> {
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
    const age = Date.now() - (cached.fetchedAt || 0);
    if (!force && age < TTL_MS && blockIndex.handles.size) return;

    refreshing = true;
    try {
        const etags = cached.etags || {};
        const next: Cached = { ...cached, etags: { ...etags } };

        const block = await fetchOne(SOURCES.block, etags[SOURCES.block]);
        if (block.text !== null) {
            blockIndex = parseList(block.text);
            next.block = serialiseIndex(blockIndex);
        }
        if (block.etag) next.etags![SOURCES.block] = block.etag;

        // Only fetched when it is actually in use -- there is no reason to spend
        // a request on a list the user has switched off.
        if (configRead('aisListIncludeWarnlist')) {
            const warn = await fetchOne(SOURCES.warn, etags[SOURCES.warn]);
            if (warn.text !== null) {
                warnIndex = parseList(warn.text);
                next.warn = serialiseIndex(warnIndex);
            }
            if (warn.etag) next.etags![SOURCES.warn] = warn.etag;
        }

        next.fetchedAt = Date.now();
        writeStore(next);
    } catch (e) {
        console.warn('[TizenTube] could not refresh the AiSList data', e);
    } finally {
        refreshing = false;
    }
}
