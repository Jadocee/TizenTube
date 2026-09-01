// The decisions behind the long-press menu's two suppression rows.
//
// NO IMPORTS, deliberately: test/refresh.mjs lifts this verbatim and a Node
// harness runs it against fixtures copied out of real captured tvhtml5 payloads,
// so what ships is checked against bytes YouTube actually sent rather than
// shapes invented to suit the code.
//
// Two measurements from those captures shape everything here. Across 223
// TILE_STYLE_YTLR_DEFAULT tiles in two browse responses, every single one
// arrived with a server-supplied menu -- so the append path is the live path,
// not the fallback. And not one of them carried a feedbackToken, which is the
// only thing YouTube's own "Not interested" runs on and the one thing a client
// cannot mint for itself.

/** The app's own renderability filter drops any menuServiceItemRenderer whose
 *  serviceEndpoint is not one of six kinds. These are those six, resolved out of
 *  the shipped bundle. A row carrying anything else renders as nothing at all,
 *  with no error -- so this list is a hard constraint on any row the mod adds,
 *  and `playlistEditEndpoint` is the one the mod already rides for ADD_TO_QUEUE. */
export const RENDERABLE_SERVICE_ENDPOINTS = [
    'feedbackEndpoint',
    'playlistEditEndpoint',
    'likeEndpoint',
    'updateKidsBlacklistEndpoint',
    'authDeterminedCommand',
    'homeLocationConditionalCommand',
];

/** A channel handle as it appears in a tile's subtitle. Five of 175 tiles in one
 *  capture put a series name where the handle usually goes ("Marques Brownlee •
 *  Retro Tech: Flying Cars"), so the tail is validated rather than assumed.
 *
 *  UNICODE, not ASCII. 473 of the 20,982 entries on the real AiSList blocklist
 *  are non-ASCII once percent-decoded -- "@LangweiligeWährung",
 *  "@KanałPoznawczy", "@소소한작업실-z8d" -- and an ASCII class rejected every one
 *  of them, so aisListParse's careful decoding of both sides could never be
 *  reached for those channels and "Don't recommend <channel>" silently did not
 *  appear on their tiles. What actually separates a handle from a series name is
 *  the SPACE, which \p{L}\p{N} still excludes. \p{...} needs the u flag and has
 *  been in Chromium since 64; this build targets 120. */
const HANDLE = /^@[\p{L}\p{N}._-]{1,60}$/u;

/** How many entries either list keeps. A television session can walk past
 *  thousands of tiles; the settings list has to stay navigable on a D-pad. */
export const MAX_HIDDEN = 300;

export interface ChannelRef {
    /** The stable UC id, when the payload offered one. */
    id?: string;
    /** The @handle, which is stable enough to match on and far more common. */
    handle?: string;
    /** Display name. Stored so the settings list is readable. NEVER matched on. */
    name?: string;
}

export interface TileIdentity {
    videoId: string | null;
    channel: ChannelRef | null;
}

/**
 * Where this tile's renderable menu items actually live.
 *
 * The app prefers `tileRenderer.menu.menuRenderer` and falls back to the
 * showMenuCommand's, so a mod that only ever looks at the second one can append
 * to a list nothing renders. No captured tile carried the first form, but the
 * app checks it first, so this does too.
 */
export function menuItems(tile: any): any[] | null {
    const direct = tile?.menu?.menuRenderer?.items;
    if (Array.isArray(direct)) return direct;
    const viaCommand = tile?.onLongPressCommand?.showMenuCommand?.menu?.menuRenderer?.items;
    if (Array.isArray(viaCommand)) return viaCommand;
    return null;
}

/**
 * Does the server already offer its own feedback rows on this tile?
 *
 * When it does, the mod stands down entirely: YouTube's rows act on the account
 * and ours only act on this television, and two near-identical entries beside
 * each other is worse than one. Nothing observable here has ever carried one --
 * every capture available was signed out -- so this is the forward-compatibility
 * hinge rather than a live path, and the harness proves it against a fixture
 * carrying a fake token.
 */
export function hasFeedbackRow(items: any[] | null | undefined): boolean {
    if (!Array.isArray(items)) return false;
    for (const item of items) {
        const body = item?.menuServiceItemRenderer || item?.menuNavigationItemRenderer;
        const endpoint = body?.serviceEndpoint || body?.navigationEndpoint;
        if (endpoint?.feedbackEndpoint) return true;
        // A token can also sit directly on the endpoint the app posts.
        if (endpoint?.feedbackToken) return true;
    }
    return false;
}

/** The channel a server-supplied menu points at, via its own "Go to channel"
 *  row. This is the only place a real UC id appears on a tile -- and the app
 *  omits that row on a channel's own browse page, which is why 0 of 175 tiles
 *  in the channel capture yielded one. */
export function channelIdFromMenu(items: any[] | null | undefined): string | null {
    if (!Array.isArray(items)) return null;
    for (const item of items) {
        const id = item?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId;
        if (typeof id === 'string' && id.startsWith('UC')) return id;
    }
    return null;
}

/** The handle out of a subtitle such as "Brawl Stars • @BrawlStars".
 *
 *  A subtitle with NO bullet is not a miss. A channel's own round tile carries
 *  the bare handle as its whole subtitle -- all six in one channel-page capture
 *  are exactly "@TheStudio", "@AutoFocus", "@Waveform" and so on -- and
 *  requiring the bullet meant AiSList dropped such a channel's videos while
 *  leaving the channel itself sitting in the Channels shelf. */
export function handleFromSubtitle(subtitle: unknown): string | null {
    if (typeof subtitle !== 'string') return null;
    // The bullet is U+2022 with spaces around it. Split on the LAST one: a
    // channel name may itself contain a bullet.
    const at = subtitle.lastIndexOf('•');
    const tail = (at < 0 ? subtitle : subtitle.slice(at + 1)).trim();
    return HANDLE.test(tail) ? tail : null;
}

/** The channel display name: whatever precedes the bullet, else line 0. */
export function nameFromTile(tile: any): string | null {
    const subtitle = tile?.onLongPressCommand?.showMenuCommand?.subtitle?.simpleText;
    if (typeof subtitle === 'string') {
        const at = subtitle.lastIndexOf('•');
        const head = (at < 0 ? subtitle : subtitle.slice(0, at)).trim();
        if (head) return head;
    }
    const line = tile?.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text;
    if (typeof line?.simpleText === 'string' && line.simpleText) return line.simpleText;
    const run = line?.runs?.[0]?.text;
    return typeof run === 'string' && run ? run : null;
}

/**
 * The channel a tile's own metadata links to.
 *
 * The third identity source, and the only one a watch-page tile has. Measured on
 * a real watchNext capture: all 33 pivot tiles in the up-next rail arrive with
 * NO menu and NO showMenuCommand, so the other two sources return null for every
 * one of them -- yet 32 of the 33 carry the channel right here, in the
 * navigationEndpoint of the metadata line the display name is read from.
 *
 * Both halves are taken. canonicalBaseUrl is percent-encoded in the payload
 * ("/@%D9%86%D8%AF%D9%8A%D8%B1-%D8%AA%D8%B1%D8%B3"), and since the published
 * AiSList is 100% handles and zero ids, the browseId alone would match nothing
 * on it -- the handle is the half that does the work there, and the id is the
 * half that matches what the user hid from a home tile.
 */
export function channelFromMetadata(tile: any): ChannelRef | null {
    const lines = tile?.metadata?.tileMetadataRenderer?.lines;
    if (!Array.isArray(lines)) return null;
    for (const line of lines) {
        const items = line?.lineRenderer?.items;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            const runs = item?.lineItemRenderer?.text?.runs;
            if (!Array.isArray(runs)) continue;
            for (const run of runs) {
                const browse = run?.navigationEndpoint?.browseEndpoint;
                const id = browse?.browseId;
                if (typeof id !== 'string' || !id.startsWith('UC')) continue;
                const ref: ChannelRef = { id };
                const handle = handleFromCanonicalUrl(browse?.canonicalBaseUrl);
                if (handle) ref.handle = handle;
                if (typeof run.text === 'string' && run.text) ref.name = run.text;
                return ref;
            }
        }
    }
    return null;
}

/** "/@%D9%86%D8%AF%D9%8A%D8%B1-%D8%AA%D8%B1%D8%B3" -> "@ندير-ترس". A malformed
 *  escape falls back to the raw tail rather than discarding the handle, the same
 *  way aisListParse handles one. */
export function handleFromCanonicalUrl(url: unknown): string | null {
    if (typeof url !== 'string') return null;
    const at = url.indexOf('/@');
    if (at < 0) return null;
    let tail = url.slice(at + 1);
    if (tail.indexOf('%') !== -1) {
        try {
            tail = decodeURIComponent(tail);
        } catch (e) {
            // Leave it encoded; it can still match a list entry written the
            // same way.
        }
    }
    return HANDLE.test(tail) ? tail : null;
}

/** Everything the mod can learn about a tile without a network request. */
export function tileIdentity(tile: any): TileIdentity {
    const items = menuItems(tile);
    const videoId = typeof tile?.contentId === 'string' && tile.contentId ? tile.contentId : null;
    const menuId = channelIdFromMenu(items);
    const subtitleHandle = handleFromSubtitle(tile?.onLongPressCommand?.showMenuCommand?.subtitle?.simpleText);
    // Only consulted when the cheaper two came up short, so the ordinary home
    // tile -- which has both -- does not pay for the walk.
    const meta = menuId && subtitleHandle ? null : channelFromMetadata(tile);
    const id = menuId || meta?.id || null;
    const handle = subtitleHandle || meta?.handle || null;
    const name = nameFromTile(tile) || meta?.name || null;
    const channel: ChannelRef | null = id || handle ? {
        ...(id ? { id } : {}),
        ...(handle ? { handle } : {}),
        ...(name ? { name } : {}),
    } : null;
    return { videoId, channel };
}

/**
 * The stored form: "<key> <display name>", the same shape
 * sponsorBlockDisabledChannels already uses.
 *
 * The key is the UC id when there is one and the handle otherwise. Neither can
 * contain a space, so the first space splits the two unambiguously and the name
 * survives for the settings list.
 */
export function channelKey(channel: ChannelRef | null | undefined): string | null {
    if (!channel) return null;
    if (typeof channel.id === 'string' && channel.id) return channel.id;
    if (typeof channel.handle === 'string' && channel.handle) return channel.handle;
    return null;
}

export function channelEntry(channel: ChannelRef | null | undefined): string | null {
    const key = channelKey(channel);
    if (!key) return null;
    const name = typeof channel!.name === 'string' && channel!.name ? channel!.name : key;
    return `${key} ${name}`;
}

export function parseEntry(entry: string): { key: string; name: string } {
    if (typeof entry !== 'string') return { key: '', name: '' };
    const space = entry.indexOf(' ');
    if (space < 0) return { key: entry, name: entry };
    return { key: entry.slice(0, space), name: entry.slice(space + 1) };
}

/**
 * Is this channel on the list?
 *
 * Matched on id or handle only. A DISPLAY NAME IS NEVER A MATCHING KEY: two
 * channels can share one, and hiding every channel called "News" because the
 * user hid one of them is precisely the failure this shape exists to avoid.
 */
export function isChannelHidden(channel: ChannelRef | null | undefined, entries: unknown): boolean {
    if (!channel || !Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const { key } = parseEntry(entry);
        if (!key) continue;
        if (channel.id && key === channel.id) return true;
        if (channel.handle && key === channel.handle) return true;
    }
    return false;
}

export function isVideoHidden(videoId: unknown, entries: unknown): boolean {
    if (typeof videoId !== 'string' || !videoId) return false;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
        if (typeof entry === 'string' && parseEntry(entry).key === videoId) return true;
    }
    return false;
}

/** Adds an entry, keeping the list bounded and free of duplicates. Returns the
 *  same array reference when nothing changed, so a caller can skip the write. */
export function addEntry(entries: unknown, entry: string | null | undefined): string[] {
    const list = Array.isArray(entries) ? entries.filter((e) => typeof e === 'string') as string[] : [];
    if (typeof entry !== 'string' || !entry) return list;
    const key = parseEntry(entry).key;
    if (!key) return list;
    if (list.some((e) => parseEntry(e).key === key)) return list;
    const next = list.concat(entry);
    // Oldest first, so a long session evicts what was hidden longest ago rather
    // than what was hidden most recently.
    return next.length > MAX_HIDDEN ? next.slice(next.length - MAX_HIDDEN) : next;
}

/**
 * Should this tile be filtered out of a shelf entirely?
 *
 * Applied before the menu work, so a hidden tile never pays for a synthesised
 * menu, an inline-preview command or a DeArrow request.
 */
export function tileIsHidden(tile: any, hiddenVideos: unknown, hiddenChannels: unknown): boolean {
    if (!tile) return false;
    const identity = tileIdentity(tile);
    if (isVideoHidden(identity.videoId, hiddenVideos)) return true;
    return isChannelHidden(identity.channel, hiddenChannels);
}

/**
 * Which suppression rows this tile can honestly offer.
 *
 * The channel row is omitted when the tile names no channel by id or handle: a
 * row that cannot identify what it would hide is a row that would do nothing, or
 * worse, the wrong thing.
 */
export function offeredRows(tile: any, enabled: boolean): { video: boolean; channel: boolean } {
    if (!enabled || !tile) return { video: false, channel: false };
    // The server's own feedback rows beat ours: theirs act on the account.
    if (hasFeedbackRow(menuItems(tile))) return { video: false, channel: false };
    const identity = tileIdentity(tile);
    if (!identity.videoId) return { video: false, channel: false };
    return { video: true, channel: channelKey(identity.channel) !== null };
}
