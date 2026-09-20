// Which channel the video on screen belongs to.
//
// SponsorBlock needs this to honour a per-channel opt-out, and nothing else in
// the mod knew it. adblock.ts's JSON.parse hook already sees every InnerTube
// response go past, so this records what it sees rather than adding a second
// interception point.
//
// Keyed by video id, not just "the last one seen", because the two events race:
// the hashchange that tells SponsorBlock which video is playing can arrive
// either side of the response that says whose it is. Looking up by id means the
// answer is right whichever order they land in.
//
// THE DISPLAY NAME IS NOT IN THE PLAYER RESPONSE ON THIS CLIENT. The header of
// this file used to say it was -- "videoDetails.channelId and .author" -- and
// the code fell back to the channel id when `author` was missing. It is always
// missing here. Measured against a captured TVHTML5 /player response:
// videoDetails carries videoId, lengthSeconds, channelId, isOwnerViewing,
// isCrawlable, thumbnail, allowRatings, isPrivate, isUnpluggedCorpus,
// isLiveContent and isTvfilmVideo, and no author; the same request body with
// clientName swapped to WEB answers with `author`. So every entry this module
// produced was named after its own id, and "<id> <id>" is what the settings
// list showed -- the reported "letters and numbers for a channel name".
//
// The shipped TV app does not read videoDetails.author either. It takes the
// uploader's name from the WATCH-NEXT response, at
// singleColumnWatchNextResults -> ... -> videoMetadataRenderer.owner
// .videoOwnerRenderer, and that payload comes through the same hook. So this
// reads the same place the app does, rather than inventing a walk.

import { configRead } from '../config.js';

export interface ChannelRef {
    id: string;
    name: string;
}

/** Bounded: a long session should not accumulate an entry per video watched. */
const MAX_REMEMBERED = 64;
const byVideoId = new Map<string, ChannelRef>();
let latest: ChannelRef | null = null;

/**
 * Display names learned for a channel id, from whichever payload carried one.
 *
 * The two responses that name a channel arrive in either order and carry
 * different halves of the answer: /player has the id and no name, /next has
 * both. Without this, a player response landing second would overwrite a name
 * the watch-next response had already supplied, and which of the two the user
 * got would depend on network ordering.
 *
 * Bounded the same way, and for the same reason, as byVideoId.
 */
const namesById = new Map<string, string>();

/** The best name known for a channel id, or '' when none has been seen. */
export function nameForChannel(id: string): string {
    return namesById.get(id) || '';
}

/**
 * Text out of any of the shapes InnerTube uses for a string.
 *
 * Mirrors the app's own reader rather than guessing: it accepts a bare string,
 * an attributed `.content`, a `.simpleText`, and concatenated `.runs[].text`.
 * All four are live -- the captured watch-next owner uses simpleText while the
 * video title beside it uses runs, in the same renderer.
 */
function textOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const node = value as { content?: unknown; simpleText?: unknown; runs?: unknown };
    if (typeof node.content === 'string') return node.content;
    if (typeof node.simpleText === 'string') return node.simpleText;
    if (Array.isArray(node.runs)) {
        let out = '';
        for (const run of node.runs) {
            if (run && typeof run.text === 'string') out += run.text;
        }
        return out;
    }
    return '';
}

/**
 * Records one sighting, merging the name against everything seen before.
 *
 * `name` is deliberately allowed to be empty. It used to default to the channel
 * id, which made "we do not know this channel's name" indistinguishable from
 * "this channel is called UC4QobU6STFB0P71PMvOGN5A" at every later read.
 */
function remember(videoId: unknown, id: string, name: string): void {
    if (!id) return;
    if (name) namesById.set(id, name);
    while (namesById.size > MAX_REMEMBERED) {
        const oldest = namesById.keys().next();
        if (oldest.done) break;
        namesById.delete(oldest.value);
    }

    const ref: ChannelRef = { id, name: name || namesById.get(id) || '' };
    latest = ref;

    if (typeof videoId === 'string' && videoId) {
        // Re-insert so the most recently seen entry is last, which makes the
        // eviction below least-recently-seen rather than arbitrary.
        byVideoId.delete(videoId);
        byVideoId.set(videoId, ref);
        while (byVideoId.size > MAX_REMEMBERED) {
            const oldest = byVideoId.keys().next();
            if (oldest.done) break;
            byVideoId.delete(oldest.value);
        }
    }
}

/** A /player response: the id, and on other clients the name. */
function fromPlayer(details: unknown): void {
    if (!details || typeof details !== 'object') return;
    const node = details as { channelId?: unknown; videoId?: unknown; author?: unknown };
    if (typeof node.channelId !== 'string' || !node.channelId) return;
    // Preferred when present rather than deleted outright. Every response that
    // could be observed was a degraded one, so "TVHTML5 never sends author"
    // cannot be excluded for a playable video -- and reading it when it is there
    // costs nothing now that its absence no longer invents a name.
    const author = typeof node.author === 'string' ? node.author : '';
    remember(node.videoId, node.channelId, author);
}

/**
 * A /next response, which is where this client's display name actually lives.
 *
 * Both levels are looped rather than indexed at [0], because that is what the
 * app's own extractor does: it walks contents[b].itemSectionRenderer.contents[d]
 * and takes the first videoMetadataRenderer it finds. Indexing [0] works on the
 * captures and would break on the first payload that puts a different section
 * in front.
 */
function fromWatchNext(parsed: any): void {
    const results = parsed?.contents?.singleColumnWatchNextResults?.results?.results?.contents;
    if (!Array.isArray(results)) return;
    for (const section of results) {
        const items = section?.itemSectionRenderer?.contents;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            const meta = item?.videoMetadataRenderer;
            const owner = meta?.owner?.videoOwnerRenderer;
            if (!owner) continue;
            const id = owner.navigationEndpoint?.browseEndpoint?.browseId;
            if (typeof id !== 'string' || !id) continue;
            remember(meta.videoId, id, textOf(owner.title));
        }
    }
}

/**
 * A Shorts body, which nests its player response and names the channel in the
 * reel header instead.
 *
 * Without this a Short recorded no channel at all -- the root has no
 * videoDetails, so the function returned immediately -- which left both the
 * per-channel SponsorBlock opt-out and the per-channel caption preference inert
 * on every Short. That is a different defect from the one reported and it is
 * fixed here because it is the same three lines.
 *
 * The header gives a handle rather than a display name. A handle is a name a
 * person recognises, which is the whole requirement here, and tileMenu already
 * stores handle-keyed entries elsewhere.
 */
function fromReel(parsed: any): void {
    const reel = parsed?.overlay?.reelPlayerOverlayRenderer;
    if (!reel) return;
    const header = reel.reelPlayerHeaderSupportedRenderers?.reelPlayerHeaderRenderer;
    if (!header) return;
    const id = header.channelNavigationEndpoint?.browseEndpoint?.browseId;
    if (typeof id !== 'string' || !id) return;
    remember(header.videoId, id, textOf(header.channelTitleText));
}

/**
 * Records the channel from anything that looks like a response carrying one.
 * Called from inside adblock.ts's JSON.parse hook, which runs for every parse
 * the page does -- so this must stay cheap and must never throw. Each branch
 * below is one property read away from returning.
 */
export function recordVideoContext(parsed: any): void {
    if (!parsed || typeof parsed !== 'object') return;
    fromPlayer(parsed.videoDetails);
    // A reel body carries the player response one level down.
    if (parsed.playerResponse) fromPlayer(parsed.playerResponse.videoDetails);
    fromWatchNext(parsed);
    fromReel(parsed);
}

/** The channel of a given video, or the last one seen if that video is unknown.
 *
 *  The fallback is deliberate and load-bearing for its two callers: the settings
 *  screen's "now playing" row asks with no id at all, and SponsorBlock re-reads
 *  at skip time when the player is unambiguously on one video. It is the WRONG
 *  answer for anything deciding something about a NAMED video that may not have
 *  been seen yet -- see channelForVideo. */
export function channelOf(videoId?: string | null): ChannelRef | null {
    if (videoId) {
        const known = byVideoId.get(videoId);
        if (known) return known;
    }
    return latest;
}

/**
 * The channel of exactly this video, or null.
 *
 * No fallback to the last channel seen. A caller that is waiting for a video's
 * channel to arrive needs "not yet" and "here it is" to be distinguishable;
 * channelOf answers the second question with the previous video's channel, which
 * reads as an arrival and ends the wait with the wrong answer.
 */
export function channelForVideo(videoId?: string | null): ChannelRef | null {
    if (!videoId) return null;
    return byVideoId.get(videoId) || null;
}

/**
 * Splits a stored "<id> <name>" entry. Ids never contain a space.
 *
 * An entry with no space carries no name, and says so. It used to answer with
 * the id in the name slot, which is the same conflation the recorder above no
 * longer makes: a caller cannot repair a name it has been told it already has.
 */
export function parseChannelEntry(entry: string): ChannelRef {
    const space = entry.indexOf(' ');
    if (space < 0) return { id: entry, name: '' };
    return { id: entry.slice(0, space), name: entry.slice(space + 1) };
}

/** Builds the stored form of a channel. */
export const channelEntry = (channel: ChannelRef): string => `${channel.id} ${channel.name}`;

/**
 * What to put on screen for a stored channel.
 *
 * THREE CASES, AND THE MIDDLE ONE IS THE REPAIR. A name stored before this
 * module could find one reads "<id> <id>", so an entry whose name IS its id is
 * treated as nameless and a name learned since is preferred -- which is what
 * turns an existing list of UC ids back into channel names the next time each
 * one is watched. The stored string is NOT rewritten: it is the value the
 * settings toggle adds and removes by, so changing it would leave the row
 * unable to untick itself.
 *
 * Falling back to the id is deliberate and is the honest answer. A row with an
 * empty title cannot be selected with a D-pad by anyone.
 */
export function displayName(channel: ChannelRef): string {
    if (channel.name && channel.name !== channel.id) return channel.name;
    return nameForChannel(channel.id) || channel.id;
}

/** Is SponsorBlock turned off for this channel? */
export function isChannelDisabled(channel: ChannelRef | null): boolean {
    if (!channel) return false;
    const disabled = configRead('sponsorBlockDisabledChannels');
    if (!Array.isArray(disabled) || !disabled.length) return false;
    // Compared by id, not by the whole entry: a channel that has been renamed
    // since it was added must stay disabled.
    return disabled.some((entry) => parseChannelEntry(entry).id === channel.id);
}
