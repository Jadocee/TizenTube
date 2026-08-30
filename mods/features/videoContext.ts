// Which channel the video on screen belongs to.
//
// SponsorBlock needs this to honour a per-channel opt-out, and nothing else in
// the mod knew it. The player response carries it -- videoDetails.channelId and
// .author -- and adblock.ts's JSON.parse hook already sees every one of those
// responses go past, so this records what it sees rather than adding a second
// interception point.
//
// Keyed by video id, not just "the last one seen", because the two events race:
// the hashchange that tells SponsorBlock which video is playing can arrive
// either side of the player response that says whose it is. Looking up by id
// means the answer is right whichever order they land in.

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
 * Records the channel from anything that looks like a player response. Called
 * from inside adblock.ts's JSON.parse hook, which runs for every parse the page
 * does -- so this must stay cheap and must never throw.
 */
export function recordVideoContext(parsed: any): void {
    const details = parsed && parsed.videoDetails;
    if (!details || typeof details !== 'object') return;

    const id = details.channelId;
    const videoId = details.videoId;
    if (typeof id !== 'string' || !id) return;

    const ref: ChannelRef = {
        id,
        // author is the display name. Falling back to the id keeps the settings
        // list usable rather than showing an empty row.
        name: typeof details.author === 'string' && details.author ? details.author : id,
    };
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

/** The channel of a given video, or the last one seen if that video is unknown. */
export function channelOf(videoId?: string | null): ChannelRef | null {
    if (videoId) {
        const known = byVideoId.get(videoId);
        if (known) return known;
    }
    return latest;
}

/** Splits a stored "<id> <name>" entry. Ids never contain a space. */
export function parseChannelEntry(entry: string): ChannelRef {
    const space = entry.indexOf(' ');
    if (space < 0) return { id: entry, name: entry };
    return { id: entry.slice(0, space), name: entry.slice(space + 1) };
}

/** Builds the stored form of a channel. */
export const channelEntry = (channel: ChannelRef): string => `${channel.id} ${channel.name}`;

/** Is SponsorBlock turned off for this channel? */
export function isChannelDisabled(channel: ChannelRef | null): boolean {
    if (!channel) return false;
    const disabled = configRead('sponsorBlockDisabledChannels');
    if (!Array.isArray(disabled) || !disabled.length) return false;
    // Compared by id, not by the whole entry: a channel that has been renamed
    // since it was added must stay disabled.
    return disabled.some((entry) => parseChannelEntry(entry).id === channel.id);
}
