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

/* --- compact shelves ------------------------------------------------------

   YouTube'S OWN SMALLER-TILE MODE, not one of ours. The TV app reads
   `shelfRenderer.tvhtml5Style.effects.shrink` and turns it into an `isShrunk`
   prop that reaches the tile size resolver, the thumbnail box, the virtual
   list's item pitch AND the shelf row height. One flag moves all four, computed
   by the app, so the painted geometry and the layout arithmetic cannot drift
   apart -- which is the failure that sinks every approach that sets sizes from
   CSS. The tile box is an inline rem style the app rewrites on every render,
   and the same numbers feed the horizontal list's `positions` array: a
   stylesheet can win the painted box and can never reach the arithmetic, so it
   buys smaller cards sitting in unchanged slots, with holes between them and
   focus stepping the old pitch.

   Measured on the live app at 1920x1080: the default tile goes 22 x 20.5rem to
   16 x 17.125rem, its thumbnail 22 x 12.375rem to 16 x 9rem, the shelf row
   21.625rem to 18.375rem, and a row fits one more card.

   THE PREDICATE IS THE WHOLE FEATURE. The app honours the flag for the ROW
   whatever the shelf contains, but two item kinds ignore it for their own size:
   a `lockupViewModel` (its size function never receives isShrunk) and any
   `tileRenderer` carrying `styling` (which returns from the style table before
   the isShrunk branch is reached). Either way the card keeps 21.625rem of
   height inside an 18.375rem row and roughly 78px is sliced off the bottom of
   every one of them -- the channel name and the view count. Search is already
   100% lockupViewModel and home is drifting the same way, so this is a live
   trap that gets worse with time rather than a theoretical one.

   The metadata block does NOT shrink with the thumbnail: its reserved height
   stays 7.125rem while the title box narrows by 27%, so titles ellipsize
   sooner. That is the honest cost of the setting and it is why the setting
   exists. */

/** Exactly the tile styles the app's shrink branch has a smaller size for.
 *  Anything else keeps its full height and would be clipped by the shorter row
 *  -- a GAME poster is 18.813rem and a Shorts tile 21.25rem, against a shrunk
 *  row of 18.375rem. */
export const SHRINKABLE_TILE_STYLES = [
    'TILE_STYLE_YTLR_DEFAULT',
    'TILE_STYLE_YTLR_CAROUSEL_FULL_METADATA',
    'TILE_STYLE_YTLR_ROUND',
    'TILE_STYLE_YTLR_SQUARE',
];

/**
 * Whether every card in this shelf will shrink along with its row.
 *
 * Deliberately conservative: a shelf this returns false for simply keeps
 * YouTube's stock layout, which is a visibly inconsistent grid but never a
 * clipped one. The opposite error cuts the bottom off every card in the row.
 */
export function shelfCanShrink(shelf: any): boolean {
    if (!shelf || typeof shelf !== 'object') return false;
    // Never fight the app's own enlarge mode; it is asking for the opposite.
    if (shelf.tvhtml5Style?.effects?.enlarge) return false;
    // A typed shelf can shrink its row without shrinking its cards, because the
    // tile-sizing path short-circuits on several of those types before it
    // reaches the shrink branch. Untyped is the ordinary browse shelf.
    const type = shelf.tvhtml5ShelfRendererType;
    if (type && type !== 'TVHTML5_SHELF_RENDERER_TYPE_UNKNOWN') return false;

    const items = shelf.content?.horizontalListRenderer?.items;
    // An empty shelf has nothing to be inconsistent with, but it is also about
    // to be spliced by shelfIsEmpty; either way there is nothing to shrink.
    if (!Array.isArray(items) || items.length === 0) return false;

    for (const item of items) {
        const tile = item?.tileRenderer;
        // A lockupViewModel, a grid button, an ad slot: the row shrinks, the
        // item does not.
        if (!tile) return false;
        // `styling` short-circuits the size table before the shrink branch.
        if (tile.styling) return false;
        if (!SHRINKABLE_TILE_STYLES.includes(tile.style)) return false;
    }
    return true;
}

/** Sets the app's own flag. Idempotent, and additive -- anything else already
 *  on tvhtml5Style.effects is preserved, because the app reads siblings of
 *  `shrink` from the same object. */
export function shrinkShelf(shelf: any): void {
    if (!shelf || typeof shelf !== 'object') return;
    if (!shelf.tvhtml5Style || typeof shelf.tvhtml5Style !== 'object') shelf.tvhtml5Style = {};
    const style = shelf.tvhtml5Style;
    if (!style.effects || typeof style.effects !== 'object') style.effects = {};
    style.effects.shrink = true;
}

/* --- who DeArrow can be asked about ---------------------------------------

   DeArrow holds community titles and thumbnails for VIDEOS. Asking it about a
   channel, a playlist, a shelf button or a Shorts reel is a request that can
   only ever 404 -- and adblock.ts fires one per tile, so on a home screen that
   is a steady trickle of outbound requests from a television, each one
   answering a question nobody asked.

   The same predicate is what keeps the thumbnail substitution off tiles whose
   `contentId` is not a video id at all, where the synthesised URL would be
   nonsense rather than merely absent. */

/** A YouTube video id: eleven characters of base64url. Checked rather than
 *  assumed, because `contentId` carries channel ids and playlist ids on the
 *  same field for other tile kinds. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function deArrowableTile(item: any): boolean {
    const tile = item && item.tileRenderer;
    if (!tile) return false;
    // A watchEndpoint is the app's own statement that selecting this plays a
    // video. previewableTile uses the same test for the same reason.
    if (!tile.onSelectCommand?.watchEndpoint) return false;
    // A reel is a video, but DeArrow does not brand Shorts and the tile's
    // thumbnail is a different shape.
    if (tile.onSelectCommand?.reelWatchEndpoint) return false;
    if (tile.tvhtml5ShelfRendererType === 'TVHTML5_TILE_RENDERER_TYPE_SHORTS') return false;
    return typeof tile.contentId === 'string' && VIDEO_ID.test(tile.contentId);
}
