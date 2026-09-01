// Applies the remembered caption preference when a video starts.
//
// The decisions live in captionPrefs.ts, which a Node harness runs directly.
// What is here is the part that has to touch the app: noticing that a new video
// started, waiting for its channel to be known, and issuing the one command.
//
// Two things shape the whole design.
//
// It applies ONCE PER VIDEO and never re-asserts. Someone who turns captions off
// ten seconds in has made a decision, and a preference that undid it would be
// worse than no preference at all -- on a television there is no quick way to
// fight a setting that keeps winning.
//
// It is sequenced behind the CHANNEL, not behind playback. The preference is per
// channel, videoContext.ts learns the channel from the player response, and that
// response is also what starts playback -- so the channel can arrive slightly
// after the video does. Rather than racing, this polls briefly for the channel
// and applies the global default if it never turns up, which is the answer that
// is right for a video whose channel simply cannot be determined.

import { configRead } from '../config.js';
import resolveCommand from '../resolveCommand.js';
import { channelForVideo } from './videoContext.js';
import { commandFor, preferenceFor, shouldApply, type CaptionPreference } from './captionPrefs.js';

/** How long to wait for the channel before falling back to the global default.
 *  The player response usually lands within a few hundred milliseconds; this is
 *  generous rather than tight because the cost of waiting is nothing at all. */
const CHANNEL_WAIT_MS = 4000;
const POLL_MS = 250;

let appliedTo: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** The video id in the current route, or null when this is not a watch page. */
function currentVideoId(): string | null {
    try {
        const hash = location.hash || '';
        const match = hash.match(/[?&]v=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
        return null;
    }
}

function apply(preference: CaptionPreference): void {
    const command = commandFor(preference);
    if (!command) return;
    try {
        // selectSubtitlesTrackCommand with useDefaultTrack turns captions on;
        // with an empty payload the app's own handler runs `a.sl({}), a.IB(!1)`,
        // which is off. Both are the app's commands, not a player API this mod
        // reaches into.
        resolveCommand(command);
    } catch (e) {
        console.warn('[TizenTube] could not apply the caption preference', e);
    }
}

function settle(videoId: string, waitedMs: number): void {
    timer = null;
    // The route moved on while we were waiting.
    if (currentVideoId() !== videoId) return;
    if (!shouldApply(videoId, appliedTo)) return;

    // channelForVideo, NOT channelOf: the latter falls back to the last channel
    // seen, which from the second video of a session onward is never null. That
    // ended the wait below on its first tick with the PREVIOUS video's channel
    // and applied that channel's preference to this video -- the exact race this
    // file exists to avoid, made unreachable by the fallback.
    const channel = channelForVideo(videoId);
    if (!channel && waitedMs < CHANNEL_WAIT_MS) {
        timer = setTimeout(() => settle(videoId, waitedMs + POLL_MS), POLL_MS);
        return;
    }

    const preference = preferenceFor({
        globalDefault: configRead('captionsDefault') as CaptionPreference,
        onChannels: configRead('captionsOnChannels'),
        offChannels: configRead('captionsOffChannels'),
        channel,
    });

    // Marked applied even when the answer is 'leave', so a later poll on the
    // same video cannot decide differently once the channel arrives late.
    appliedTo = videoId;
    apply(preference);
}

function onRouteChange(): void {
    const videoId = currentVideoId();
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }
    if (!videoId) {
        // Left the player. The next video is a fresh decision.
        appliedTo = null;
        return;
    }
    if (!shouldApply(videoId, appliedTo)) return;
    timer = setTimeout(() => settle(videoId, 0), POLL_MS);
}

window.addEventListener('hashchange', onRouteChange);
// The app can already be on a watch route when the mod loads, on the standalone
// build's late-injection path.
onRouteChange();
