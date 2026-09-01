// Parsing and matching for the AiSList channel lists.
//
// NO IMPORTS, deliberately -- not even `import type` -- so test/refresh.mjs lifts
// this verbatim and the harness runs it against real bytes from the published
// list.
//
// THE FORMAT, quoted from the file's own header:
//
//   ! Format: One channel per line
//   ! - @channelhandle (YouTube handle format)
//   ! - UCxxxxxxxxxxxxxxxx (YouTube channel ID format)
//   ! - Lines starting with ! are comments
//   ! - Empty lines are ignored
//
// MEASURED, because the header and the data disagree: both files are 100%
// @handles. Zero UC ids, in 20,982 blocklist entries and 924 warnlist entries.
// The UC form is still parsed, because the header says it may appear and a list
// that starts using it should not silently stop matching.
//
// The trap that is NOT in the header: 498 of those handles are percent-encoded
// or non-ASCII -- "@DerR%C3%A4cheresp", "@Kana%C5%82Poznawczy",
// "@소소한작업실-z8d". A tile's subtitle carries the DECODED form, so matching the
// raw strings would silently miss every one of them. Both sides are decoded and
// case-folded here, which is also right on its own terms: YouTube treats handles
// case-insensitively.

/** The engine's own JSON.parse, captured at module evaluation.
 *
 *  adblock.ts REPLACES the global with one that runs every parsed value through
 *  processResponse, and it imports this module, so this line runs first and gets
 *  the native one. It matters: deserialiseIndex is reached from isAiChannel,
 *  which is called per tile from inside that very patch. Parsing the 392 KB
 *  serialised index through the patched global re-entered processResponse with
 *  20,895 handles -- a six-rule prune over 125k nodes, synchronously, in the
 *  middle of a live home-page parse, pruning nothing. */
const nativeParse = JSON.parse;

/** A parsed list, ready to match against. */
export interface ChannelIndex {
    /** Case-folded, percent-decoded handles, including the leading @. */
    handles: Set<string>;
    /** Channel ids, which the format allows even though neither file uses one. */
    ids: Set<string>;
    /** What the file's own header said, for the settings screen. */
    lastModified: string | null;
    /** How many entries were read, as opposed to lines. */
    count: number;
}

export function emptyIndex(): ChannelIndex {
    return { handles: new Set(), ids: new Set(), lastModified: null, count: 0 };
}

/**
 * Normalises a handle for comparison.
 *
 * decodeURIComponent throws on a malformed sequence such as a bare "%" -- which
 * a community-edited list can certainly contain -- so a failure falls back to
 * the raw string rather than discarding the entry or aborting the parse.
 */
export function normaliseHandle(handle: unknown): string | null {
    if (typeof handle !== 'string') return null;
    let value = handle.trim();
    if (!value) return null;
    if (value.charAt(0) !== '@') return null;
    if (value.indexOf('%') !== -1) {
        try {
            value = decodeURIComponent(value);
        } catch (e) {
            // Leave it as-is; an entry that cannot be decoded can still match a
            // tile whose handle is written the same way.
        }
    }
    return value.toLowerCase();
}

/** The `! Last Modified: 2026-07-19` line, if the file carries one. */
export function readLastModified(text: string): string | null {
    if (typeof text !== 'string') return null;
    const match = text.match(/^!\s*Last Modified:\s*(.+)$/im);
    return match ? match[1].trim() : null;
}

/**
 * Parses a list file into an index.
 *
 * Total: any input that is not a string yields an empty index rather than
 * throwing, because this runs on the result of a network fetch.
 */
export function parseList(text: unknown): ChannelIndex {
    const index = emptyIndex();
    if (typeof text !== 'string' || !text) return index;
    index.lastModified = readLastModified(text);

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.charAt(0) === '!' || line.charAt(0) === '#') continue;
        if (line.charAt(0) === '@') {
            const handle = normaliseHandle(line);
            if (handle) {
                index.handles.add(handle);
                index.count++;
            }
            continue;
        }
        // The header advertises this form even though neither file uses it.
        if (line.lastIndexOf('UC', 0) === 0 && line.length >= 10 && line.indexOf(' ') === -1) {
            index.ids.add(line);
            index.count++;
        }
    }
    return index;
}

/**
 * Is this channel on the list?
 *
 * Two set lookups rather than a scan. The user's own hidden-channel list is a
 * handful of entries and a linear scan over it costs nothing; this one is
 * twenty thousand, called once per tile, and a scan would be a million string
 * comparisons for a single home payload.
 */
export function indexHasChannel(
    index: ChannelIndex | null | undefined,
    channel: { id?: string; handle?: string } | null | undefined,
): boolean {
    if (!index || !channel) return false;
    if (channel.id && index.ids.size && index.ids.has(channel.id)) return true;
    if (channel.handle && index.handles.size) {
        const handle = normaliseHandle(channel.handle);
        if (handle && index.handles.has(handle)) return true;
    }
    return false;
}

/** Serialises an index for storage. Sets do not survive JSON on their own. */
export function serialiseIndex(index: ChannelIndex): string {
    return JSON.stringify({
        h: Array.from(index.handles),
        i: Array.from(index.ids),
        m: index.lastModified,
    });
}

export function deserialiseIndex(text: unknown): ChannelIndex | null {
    if (typeof text !== 'string' || !text) return null;
    try {
        const raw = nativeParse(text);
        if (!raw || !Array.isArray(raw.h)) return null;
        const index = emptyIndex();
        for (const h of raw.h) if (typeof h === 'string') index.handles.add(h);
        if (Array.isArray(raw.i))
            for (const i of raw.i) if (typeof i === 'string') index.ids.add(i);
        index.lastModified = typeof raw.m === 'string' ? raw.m : null;
        index.count = index.handles.size + index.ids.size;
        return index;
    } catch (e) {
        return null;
    }
}
