// One DeArrow request per video, rather than one per tile.
//
// NO IMPORTS, deliberately -- test/refresh.mjs copies this verbatim and drives
// it with a counting fake fetch, which is the only way to prove a
// request-coalescing cache actually coalesces.
//
// deArrowify() called fetch() directly for every tile it walked, with no cache
// and no de-duplication. A home page of ten shelves is on the order of a hundred
// and fifty outbound requests fired at once on a television SoC, before the user
// has pressed anything -- and again for every continuation as they scroll, and
// twice over for a video that appears on two shelves. The responses are also
// per-video and effectively static for the length of a session, so almost all of
// that traffic was asking the same questions again.

/** How many videos to remember. A long session on a TV can walk through
 *  thousands of tiles, so this is bounded; ~1500 entries of a title and a
 *  thumbnail timestamp is a few hundred kilobytes at worst. */
export const CACHE_LIMIT = 1500;

export const BRANDING_URL = 'https://sponsor.ajay.app/api/branding?videoID=';

export interface Branding {
    titles?: { title: string; votes: number }[];
    thumbnails?: { timestamp?: number; votes: number }[];
}

// Insertion-ordered, so the oldest key is the first one Map iteration yields.
const inFlight = new Map<string, Promise<Branding | null>>();

/** Test seam. The harness swaps this for a counting stub; nothing else does. */
export function resetBrandingCache(): void {
    inFlight.clear();
}

export function brandingCacheSize(): number {
    return inFlight.size;
}

/**
 * The DeArrow branding for one video, fetched at most once.
 *
 * Returns the SAME promise for a repeated id, so twenty tiles asking at once
 * produce one request. A rejected or non-ok request is evicted rather than
 * cached, so a transient failure on the first shelf does not poison every later
 * one -- but the eviction happens after the promise settles, so the tiles that
 * were already waiting on it still share the single failure.
 */
export function fetchBranding(videoId: unknown): Promise<Branding | null> {
    if (typeof videoId !== 'string' || videoId === '') return Promise.resolve(null);

    const cached = inFlight.get(videoId);
    if (cached) return cached;

    const fetchImpl = (globalThis as any).fetch;
    if (typeof fetchImpl !== 'function') return Promise.resolve(null);

    const pending = fetchImpl(BRANDING_URL + encodeURIComponent(videoId))
        .then((res: any) => {
            // A 404 is the normal answer for a video nobody has submitted
            // branding for, and res.json() on one throws. Both are "no data".
            if (!res || res.ok === false) return null;
            return res.json();
        })
        .catch(() => {
            inFlight.delete(videoId);
            return null;
        }) as Promise<Branding | null>;

    // Evict before inserting, so the map never exceeds the limit even for one
    // tick. Map iteration is insertion order, so this is the oldest entry.
    if (inFlight.size >= CACHE_LIMIT) {
        const oldest = inFlight.keys().next();
        if (!oldest.done) inFlight.delete(oldest.value);
    }
    inFlight.set(videoId, pending);
    return pending;
}

/** The best-voted title, or null. Pure, so the harness covers it directly. */
export function bestTitle(data: Branding | null | undefined): string | null {
    const titles = data?.titles;
    if (!Array.isArray(titles) || titles.length === 0) return null;
    let best = null as { title: string; votes: number } | null;
    for (const candidate of titles) {
        if (!candidate || typeof candidate.title !== 'string') continue;
        if (!best || (candidate.votes ?? 0) > (best.votes ?? 0)) best = candidate;
    }
    return best ? best.title : null;
}

/** The best-voted thumbnail timestamp, or null when there is no usable one. */
export function bestThumbnailTime(data: Branding | null | undefined): number | null {
    const thumbnails = data?.thumbnails;
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
    let best = null as { timestamp?: number; votes: number } | null;
    for (const candidate of thumbnails) {
        if (!candidate) continue;
        if (!best || (candidate.votes ?? 0) > (best.votes ?? 0)) best = candidate;
    }
    // The original code read `.timestamp` off the winner and skipped when it was
    // absent -- an entry can win the vote and still carry no timestamp.
    return best && Number.isFinite(best.timestamp as number) ? (best.timestamp as number) : null;
}
