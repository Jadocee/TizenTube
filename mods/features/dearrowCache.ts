// One DeArrow request per video, and an answer that is ready BEFORE the tile is
// drawn.
//
// NO IMPORTS, deliberately -- test/refresh.mjs copies this verbatim and drives
// it with a counting fake fetch, which is the only way to prove a
// request-coalescing cache actually coalesces.
//
// deArrowify() called fetch() directly for every tile it walked, with no cache
// and no de-duplication. A home page of ten shelves is on the order of a hundred
// and fifty outbound requests fired at once on a television SoC, before the user
// has pressed anything -- measured at 163 eligible tiles in one captured channel
// payload -- and again for every continuation as they scroll, and twice over for
// a video that appears on two shelves.
//
// WHY THE COMMUNITY TITLE ONLY SOMETIMES APPEARED, which is the defect this
// file was reorganised for. The title was written onto the tile from a .then(),
// which is necessarily AFTER the payload was returned from JSON.parse and the
// component drew it. The app's component base redraws only when something calls
// its Da() or K() -- `_.p.Da=function(){this.NC={pF:!0,Jv:this.state};mqa(this)}`
// -- and mqa patches the DOM synchronously. Nothing observes the payload object,
// so a late write schedules nothing. (The app does the same mutate-in-place and
// then calls Da() itself: `this.ga=function(b){a.props.data.selectedIndex=b;
// a.Da()}`. The write is fine; the missing half is the redraw.) The title
// therefore surfaced only when something unrelated redrew that tile -- focus
// moving onto it, the virtual list recycling it -- which is exactly what
// "sometimes" looks like from the sofa.
//
// Reaching the live component from here is possible in principle and fragile in
// practice, so the answer is made SYNCHRONOUS instead: once a video's branding
// has arrived it is kept, and the next parse that mentions that video applies it
// before returning, while the app is still deciding what to draw. Repeats are
// the common case on a television -- the same home feed, the same shelves,
// continuations of the same rails -- and what is kept is written to
// localStorage, so the second launch is warm from the first tile.

/** How many videos to remember. A long session on a TV can walk through
 *  thousands of tiles, so this is bounded; ~1500 entries of a title and a
 *  thumbnail timestamp is a few hundred kilobytes at worst. */
export const CACHE_LIMIT = 1500;

export const BRANDING_URL = 'https://sponsor.ajay.app/api/branding?videoID=';

/**
 * How many requests may be outstanding at once.
 *
 * One captured channel payload carries 163 DeArrow-eligible tiles, and the old
 * code put all 163 on the wire in one synchronous pass, from a television, over
 * whatever connection it has. The rest queue.
 */
export const MAX_CONCURRENT = 6;

/** Where the warm copy lives between launches. */
export const STORE_KEY = 'tizentube.dearrow';

/** How many answers to carry across launches. Smaller than CACHE_LIMIT: this
 *  one is serialised to localStorage on every arrival. */
export const STORE_LIMIT = 400;

/** One entry of either list, as the API returns it. */
export interface BrandingVote {
    votes?: number;
    /** A LOCKED entry is one a DeArrow moderator has pinned. It wins outright. */
    locked?: boolean;
    /** A vote to KEEP YOUTUBE'S OWN title or thumbnail. Not a submission. */
    original?: boolean;
}

export interface Branding {
    titles?: (BrandingVote & { title?: string })[];
    thumbnails?: (BrandingVote & { timestamp?: number })[];
}

// Insertion-ordered, so the oldest key is the first one Map iteration yields.
const inFlight = new Map<string, Promise<Branding | null>>();

/**
 * Answers that have ARRIVED, so a later parse can use them without waiting.
 *
 * Separate from inFlight, which holds promises: a promise cannot be read
 * synchronously, and reading it synchronously is the entire point. `undefined`
 * means nobody has asked yet, `null` means the answer was "nothing".
 */
const settled = new Map<string, Branding | null>();

/** Waiting to be sent, oldest first. */
const queue: (() => void)[] = [];
let running = 0;

/** Test seam. The harness swaps this for a counting stub; nothing else does. */
export function resetBrandingCache(): void {
    inFlight.clear();
    settled.clear();
    queue.length = 0;
    running = 0;
}

export function brandingCacheSize(): number {
    return inFlight.size;
}

/**
 * What is already known about this video, without waiting.
 *
 * This is the call that makes the community title appear at all: used from
 * inside the JSON.parse hook it answers before the payload is handed back, so
 * the title is part of what the component draws rather than something written
 * onto it afterwards.
 */
export function knownBranding(videoId: unknown): Branding | null | undefined {
    if (typeof videoId !== 'string' || videoId === '') return undefined;
    return settled.get(videoId);
}

/** Reads the warm copy. Never throws: localStorage is absent in the harness,
 *  disabled in some profiles, and full on some televisions. */
function loadStore(): void {
    try {
        const raw = (globalThis as any).localStorage?.getItem(STORE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        for (const id in parsed) {
            const row = parsed[id];
            if (!row || typeof row !== 'object') continue;
            const titles = typeof row.t === 'string' && row.t ? [{ title: row.t, votes: 1 }] : [];
            const thumbnails = Number.isFinite(row.s) ? [{ timestamp: row.s, votes: 1 }] : [];
            if (!titles.length && !thumbnails.length) continue;
            settled.set(id, { titles, thumbnails });
        }
    } catch (_e) {
        // A corrupt blob is not worth failing a launch over; it is rewritten on
        // the first arrival.
    }
}

let storeDirty = false;

/**
 * Writes the warm copy.
 *
 * ONLY WHAT WAS FOUND. A television walks past far more unbranded videos than
 * branded ones, and remembering every 404 would fill the blob with entries that
 * say nothing. The cost is that unbranded videos are asked about again next
 * launch, which is what the concurrency cap above is for.
 */
function saveStore(): void {
    if (!storeDirty) return;
    storeDirty = false;
    try {
        const store = (globalThis as any).localStorage;
        if (!store) return;
        const out: Record<string, { t?: string; s?: number }> = {};
        let kept = 0;
        // Iterated newest-last, so the slice below keeps the most recent.
        const ids = [...settled.keys()];
        for (let i = ids.length - 1; i >= 0 && kept < STORE_LIMIT; i--) {
            const data = settled.get(ids[i]);
            if (!data) continue;
            const row: { t?: string; s?: number } = {};
            const title = bestTitle(data);
            if (title) row.t = title;
            const time = bestThumbnailTime(data);
            if (time !== null) row.s = time;
            if (row.t === undefined && row.s === undefined) continue;
            out[ids[i]] = row;
            kept++;
        }
        store.setItem(STORE_KEY, JSON.stringify(out));
    } catch (_e) {
        // Quota, a disabled store, or a profile that blocks it. The in-memory
        // copy still works for the rest of this session.
    }
}

/** Records an arrival and schedules the warm copy to be rewritten. */
function remember(videoId: string, data: Branding | null): void {
    if (settled.size >= CACHE_LIMIT) {
        const oldest = settled.keys().next();
        if (!oldest.done) settled.delete(oldest.value);
    }
    settled.set(videoId, data);
    if (data) {
        storeDirty = true;
        saveStore();
    }
}

loadStore();

/** Starts whatever is waiting, up to the cap. */
function pump(): void {
    while (running < MAX_CONCURRENT && queue.length) {
        const next = queue.shift();
        if (next) {
            running++;
            next();
        }
    }
}

/**
 * The DeArrow branding for one video, fetched at most once.
 *
 * Returns the SAME promise for a repeated id, so twenty tiles asking at once
 * produce one request -- and at most MAX_CONCURRENT of those are ever on the
 * wire together.
 *
 * WHAT IS AND IS NOT EVICTED. A 404 is the normal answer for a video nobody has
 * submitted branding for; it is an ANSWER, and it is kept so the same video is
 * not asked about again every time it scrolls past. A 429 or a 5xx is not an
 * answer -- it means ask again later -- and the old code could not tell the two
 * apart, because `res.ok === false` returned null down the success path and only
 * the .catch evicted. So one rate-limited burst on the first shelf taught the
 * mod that those videos had no titles, for the rest of the session, and the
 * file's own comment claimed the opposite.
 */
export function fetchBranding(videoId: unknown): Promise<Branding | null> {
    if (typeof videoId !== 'string' || videoId === '') return Promise.resolve(null);

    const cached = inFlight.get(videoId);
    if (cached) return cached;

    const fetchImpl = (globalThis as any).fetch;
    if (typeof fetchImpl !== 'function') return Promise.resolve(null);

    const pending = new Promise<Branding | null>((resolve) => {
        queue.push(() => {
            fetchImpl(BRANDING_URL + encodeURIComponent(videoId))
                .then((res: any) => {
                    if (!res) return null;
                    if (res.ok === false) {
                        // res.json() on a 404 body throws in some builds, and
                        // the body is empty lists anyway. Both are "no data".
                        if (res.status === 404) return null;
                        throw new Error(`HTTP ${res.status}`);
                    }
                    return res.json();
                })
                .then((data: Branding | null) => {
                    remember(videoId, data || null);
                    resolve(data || null);
                })
                .catch(() => {
                    // Not an answer. Forgotten, so a later shelf asks again.
                    inFlight.delete(videoId);
                    resolve(null);
                })
                .then(() => {
                    running--;
                    pump();
                });
        });
    });

    // Evict before inserting, so the map never exceeds the limit even for one
    // tick. Map iteration is insertion order, so this is the oldest entry.
    if (inFlight.size >= CACHE_LIMIT) {
        const oldest = inFlight.keys().next();
        if (!oldest.done) inFlight.delete(oldest.value);
    }
    inFlight.set(videoId, pending);
    pump();
    return pending;
}

/**
 * The entry a list's votes settle on, or null.
 *
 * THREE RULES, AND THE FIRST ONE IS THE BUG THIS FIXES. `original: true` is a
 * vote to KEEP YOUTUBE'S OWN title or thumbnail -- it is not a submission, and
 * presenting it as one is wrong in a way that was invisible until it had to be
 * badged. It is common on popular videos: the live API's top entry for
 * jNQXAC9IVRw is `{"title":"Me at the zoo","original":true,"votes":10,
 * "locked":true}`, which the old code returned and the tile then displayed as a
 * community title identical to the one already there. `locked` is a moderator's
 * pin and outranks any number of votes. Everything else is decided on votes.
 */
function pickVote<T extends BrandingVote>(list: unknown, usable: (v: T) => boolean): T | null {
    if (!Array.isArray(list)) return null;
    let best: T | null = null;
    for (const candidate of list as T[]) {
        if (!candidate || typeof candidate !== 'object') continue;
        if (candidate.original === true) continue;
        if (!usable(candidate)) continue;
        if (!best) {
            best = candidate;
            continue;
        }
        if (best.locked === true && candidate.locked !== true) continue;
        if (candidate.locked === true && best.locked !== true) {
            best = candidate;
            continue;
        }
        if ((candidate.votes ?? 0) > (best.votes ?? 0)) best = candidate;
    }
    return best;
}

/**
 * The community title, or null when there is none.
 *
 * Null now genuinely means "YouTube's own title stands", which is what lets the
 * tile badge itself: a non-null answer is a submission by definition.
 */
export function bestTitle(data: Branding | null | undefined): string | null {
    const best = pickVote<BrandingVote & { title?: string }>(
        data?.titles,
        (v) => typeof v.title === 'string' && v.title !== '',
    );
    return best ? (best.title as string) : null;
}

/**
 * The community thumbnail timestamp, or null when there is no usable one.
 *
 * THE SAME BLINDNESS WAS WORSE HERE. The old version took the most-voted entry
 * and then required a finite timestamp -- but a vote for the ORIGINAL thumbnail
 * carries `timestamp: null`, and on a popular video it usually wins. dQw4w9WgXcQ
 * answers with `{"timestamp":null,"original":true,"votes":9}` ahead of a locked
 * community frame at `{"timestamp":3.92349,"original":false,"votes":2,
 * "locked":true}`, so the winner had no timestamp, this returned null, and
 * enableDeArrowThumbnails silently did nothing on exactly the videos anyone
 * would notice. Originals are skipped and a usable timestamp is now part of
 * being a candidate at all, rather than a test applied to the winner.
 */
export function bestThumbnailTime(data: Branding | null | undefined): number | null {
    const best = pickVote<BrandingVote & { timestamp?: number }>(data?.thumbnails, (v) =>
        Number.isFinite(v.timestamp as number),
    );
    return best ? (best.timestamp as number) : null;
}
