// The per-tile and per-shelf decisions the home page depends on, as pure
// functions.
//
// NO IMPORTS, deliberately, for the same reason as previewState.ts:
// test/refresh.mjs copies this file verbatim and a Node harness runs it as-is.
// These run inside JSON.parse for every response the app parses, so every one
// of them is total -- junk in returns a sane value rather than throwing, since a
// throw here is swallowed by adblock.ts's catch and silently costs the whole
// pass for that payload.

/** The style value the app gives an ordinary video tile. Channel tiles, Shorts
 *  tiles and the various promo shapes carry something else. */
export const TILE_STYLE_DEFAULT = 'TILE_STYLE_YTLR_DEFAULT';

/** What addPreviews asks for when the user has not chosen otherwise. */
export const DEFAULT_PREVIEW_DURATION_MS = 40000;
/** The app's own wait before a focused tile starts playing. */
export const DEFAULT_PREVIEW_DELAY_MS = 3000;

export interface Thumbnail {
    url?: string;
    width?: number;
    height?: number;
}

/**
 * The largest thumbnail YouTube actually supplied for this tile.
 *
 * This replaces synthesising `https://i.ytimg.com/vi/<id>/sddefault.jpg`, which
 * had three problems at once. sddefault is 640x480 -- a 4:3 frame, so a 16:9
 * video comes back letterboxed on a tile that is not. The synthesised entry
 * declared `width: 640, height: 480`, so the renderer was told that wrong aspect
 * as fact. And the query string was carried over from a DIFFERENT variant's URL:
 * an `sqp` parameter is signed for the image it was issued for, so re-attaching
 * hqdefault's to sddefault can fail validation and render nothing at all.
 *
 * Every URL returned here is one YouTube served in the payload, so it cannot
 * 404 and cannot fail a signature check. When the payload carries only one
 * entry this returns that entry and the setting is a no-op -- which is the right
 * failure: a thumbnail that is merely no larger beats a broken one.
 */
export function bestThumbnail(thumbnails: Thumbnail[] | null | undefined): Thumbnail | null {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
    let best: Thumbnail | null = null;
    let bestWidth = -1;
    for (const candidate of thumbnails) {
        if (!candidate || typeof candidate.url !== 'string' || !candidate.url) continue;
        // An entry with no declared width still beats nothing, but loses to any
        // entry that declares one.
        const width = Number.isFinite(candidate.width as number) ? (candidate.width as number) : 0;
        if (width > bestWidth) {
            best = candidate;
            bestWidth = width;
        }
    }
    return best;
}

/**
 * Whether this item is a video tile that we should attach an inline preview to.
 *
 * `onSelectCommand.watchEndpoint` is this file's notion of "this tile is a
 * video", the same test addLongPress already applies. It matters here because a
 * startInlinePlaybackCommand whose playbackEndpoint is a channel's
 * browseEndpoint cannot start playback: attaching one spends a focus command on
 * a tile to no effect, and -- now that there is an indicator -- would claim a
 * channel tile is playing when nothing is.
 */
export function previewableTile(item: any): boolean {
    const tile = item && item.tileRenderer;
    if (!tile) return false;
    // YouTube's own focus behaviour wins. Both of these mean the app already has
    // plans for this tile's focus, and overwriting them is how you break a
    // surface you have never seen.
    if (tile.onFocusCommand?.playbackEndpoint) return false;
    if (tile.onFocusCommand?.commandExecutorCommand) return false;
    // Idempotence: a payload that reaches both JSON.parse and Response.json, or
    // a shelf cloned into a second surface, must not be processed twice.
    if (tile.onFocusCommand?.startInlinePlaybackCommand) return false;
    if (!tile.onSelectCommand?.watchEndpoint) return false;
    return true;
}

export interface PreviewOptions {
    durationMs?: number;
    muted?: boolean;
    delayMs?: number;
}

/**
 * The onFocusCommand that makes a focused tile play.
 *
 * `endpoint` must already be a clone: the caller owns it outright, and sharing
 * one endpoint object between the select and focus commands would let the app
 * mutate both at once.
 */
export function startInlinePlayback(endpoint: any, options?: PreviewOptions | null): any {
    const asked =
        options && Number.isFinite(options.durationMs as number)
            ? (options.durationMs as number)
            : NaN;
    // A zero or negative duration would ask the app to play for no time at all,
    // and NaN would put NaN in the payload. Both fall back to the default.
    const durationMs = Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_PREVIEW_DURATION_MS;
    const askedDelay =
        options && Number.isFinite(options.delayMs as number) ? (options.delayMs as number) : NaN;
    const delayMs =
        Number.isFinite(askedDelay) && askedDelay >= 0 ? askedDelay : DEFAULT_PREVIEW_DELAY_MS;
    return {
        startInlinePlaybackCommand: {
            blockAdoption: true,
            caption: false,
            delayMs,
            durationMs,
            muted: !!(options && options.muted),
            restartPlaybackBeforeSeconds: 10,
            resumeVideo: true,
            playbackEndpoint: endpoint,
        },
    };
}

/**
 * The surface name matching the vocabulary the settings list offers: search,
 * home, music, gaming, subscriptions, library, more.
 *
 * Extracted from hideVideo's inline derivation and given the one case it was
 * missing. An empty hash is the home page -- it is what the app has on a cold
 * launch, and after a `launchToOnStartup` navigation lands somewhere without
 * one -- but it fell through every branch and yielded '', which matches nothing
 * in the list. So "hide watched videos on the home page" did nothing until the
 * user had navigated somewhere and come back.
 */
export function pageNameFromHash(rawHash: string | null | undefined): string {
    if (typeof rawHash !== 'string') return '';
    const hash = rawHash.startsWith('#') ? rawHash.substring(1) : rawHash;
    if (hash === '' || hash === '/') return 'home';
    if (hash.startsWith('/search')) return 'search';
    return (
        hash
            .split('?')[1]
            ?.split('&')[0]
            ?.split('=')[1]
            ?.replace('FE', '')
            ?.replace('topics_', '') ?? ''
    );
}

/**
 * Whether a shelf has been filtered down to nothing.
 *
 * The Shorts branch in processShelves splices only shelves the app TYPED as
 * Shorts. A mixed shelf whose items happen to all be reels, or one whose tiles
 * hideVideo removed as watched, ends up empty and stays on the page: a heading
 * such as "Continue watching" with a blank strip under it, which reads as a
 * failed load rather than as a filter doing its job.
 */
/** The badge style the app's own TV renderer maps to MEMBERS_ONLY. Taken from
 *  YtlrMetadataBadgeRenderer's style map in the shipped bundle, which is the
 *  renderer a tile's badges go through. */
export const MEMBERS_ONLY_BADGE = 'BADGE_STYLE_TYPE_MEMBERS_ONLY';

/**
 * Whether this tile is a members-only video.
 *
 * A TV tile keeps its badges INSIDE its metadata lines, not in a top-level
 * `badges` array as the web client does:
 *
 *   metadata.tileMetadataRenderer.lines[].lineRenderer.items[]
 *     .lineItemRenderer.badge.metadataBadgeRenderer.style
 *
 * That path is where all 259 badges across the captured browse responses sit --
 * the "4K", "CC" and "8K" labels -- so it is where a members-only badge sits
 * too. The style constant itself is the app's own; no captured tile carried one,
 * because every capture is signed out and members-only videos are uncommon in a
 * signed-out topic feed. If YouTube ever moves the badge elsewhere this returns
 * false and the filter simply stops hiding anything, which is the right way for
 * it to fail.
 */
export function hasMembersOnlyBadge(tile: any): boolean {
    const lines = tile?.metadata?.tileMetadataRenderer?.lines;
    if (!Array.isArray(lines)) return false;
    for (const line of lines) {
        const items = line?.lineRenderer?.items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            const style = item?.lineItemRenderer?.badge?.metadataBadgeRenderer?.style;
            if (style === MEMBERS_ONLY_BADGE) return true;
        }
    }
    return false;
}

export function shelfIsEmpty(shelf: any): boolean {
    const items = shelf?.shelfRenderer?.content?.horizontalListRenderer?.items;
    // No list at all is not "empty" -- it is a shelf shape this does not
    // understand, and dropping those would remove surfaces nobody asked to hide.
    if (!Array.isArray(items)) return false;
    return items.length === 0;
}
