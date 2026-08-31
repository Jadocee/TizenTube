// What the caption preference should be for the video that just started.
//
// NO IMPORTS, deliberately -- not even `import type` -- so test/refresh.mjs can
// lift this file verbatim and a Node harness runs the shipping code.
//
// HOW CAPTIONS ARE ACTUALLY TOGGLED, from the shipped bundle. There is exactly
// one live command, `selectSubtitlesTrackCommand`, handled by CaptionsService
// (chunks/003.js). Its handler reads three fields and falls through to a fourth
// case:
//
//   if (subtitlesTrackMetadata)      pick that specific track
//   else if (useDefaultTrack)        ... toggleSubtitlesOn()
//   else if (translationLanguage)    auto-translate into that language
//   else                             a.sl({}), a.IB(!1)      <- OFF
//
// So "off" is not a special signal or a null track: it is an EMPTY payload, and
// "on with whatever track the video defaults to" is `useDefaultTrack`. Both
// directions are first class, which is what makes remembering a preference
// possible at all rather than only ever being able to switch captions on.
//
// The app persists caption STYLING -- font, colour, size, opacity all arrive as
// setClientSettingEndpoint items in the same service -- but nothing persists the
// on/off state across videos. That absence is the whole reason this exists.

/** Leave captions alone, force them on, or force them off. */
export type CaptionPreference = 'leave' | 'on' | 'off';

/** The command that turns captions on with the video's default track. */
export function captionsOnCommand(): any {
    return { selectSubtitlesTrackCommand: { useDefaultTrack: true } };
}

/** The command that turns captions off. An empty payload is the off case -- see
 *  the handler quoted above. */
export function captionsOffCommand(): any {
    return { selectSubtitlesTrackCommand: {} };
}

/** The command for a preference, or null when there is nothing to do. */
export function commandFor(preference: CaptionPreference): any {
    if (preference === 'on') return captionsOnCommand();
    if (preference === 'off') return captionsOffCommand();
    return null;
}

/**
 * Splits a stored "<key> <display name>" entry. The key is a channel id or an
 * @handle; neither can contain a space, so the first one separates them. Same
 * form sponsorBlockDisabledChannels and hiddenChannels already use.
 */
export function parseEntry(entry: string): { key: string; name: string } {
    if (typeof entry !== 'string') return { key: '', name: '' };
    const space = entry.indexOf(' ');
    if (space < 0) return { key: entry, name: entry };
    return { key: entry.slice(0, space), name: entry.slice(space + 1) };
}

/** Does this channel appear in a stored list? Matched on id or handle only,
 *  never on a display name -- two channels share a name far more often than
 *  they share either of those. */
export function listHasChannel(entries: unknown, channel: { id?: string; handle?: string } | null | undefined): boolean {
    if (!channel || !Array.isArray(entries) || entries.length === 0) return false;
    for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const key = parseEntry(entry).key;
        if (!key) continue;
        if (channel.id && key === channel.id) return true;
        if (channel.handle && key.toLowerCase() === channel.handle.toLowerCase()) return true;
    }
    return false;
}

export interface PreferenceInput {
    /** What to do when no per-channel entry matches. */
    globalDefault: CaptionPreference;
    /** Channels the user asked to always have captions on. */
    onChannels?: unknown;
    /** ...and always off. */
    offChannels?: unknown;
    channel?: { id?: string; handle?: string } | null;
}

/**
 * The preference to apply for one video.
 *
 * A per-channel entry beats the global default, which is the point of having
 * both. A channel somehow present in BOTH lists resolves to 'on' rather than
 * being left to list order: the two lists are independent arrays and nothing
 * stops a determined user putting a channel in each, so the tie needs an answer
 * that does not depend on which one is read first.
 */
export function preferenceFor(input: PreferenceInput | null | undefined): CaptionPreference {
    if (!input) return 'leave';
    const channel = input.channel;
    if (channel) {
        if (listHasChannel(input.onChannels, channel)) return 'on';
        if (listHasChannel(input.offChannels, channel)) return 'off';
    }
    const fallback = input.globalDefault;
    return fallback === 'on' || fallback === 'off' ? fallback : 'leave';
}

/**
 * Whether this video should be acted on at all.
 *
 * Applied once per video id. A preference that re-asserted itself would fight
 * anyone who turns captions off ten seconds in -- and on a television, a setting
 * that undoes what you just did by hand is worse than no setting.
 */
export function shouldApply(videoId: unknown, alreadyApplied: unknown): boolean {
    if (typeof videoId !== 'string' || !videoId) return false;
    return videoId !== alreadyApplied;
}
