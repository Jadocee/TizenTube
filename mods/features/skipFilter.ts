// Which SponsorBlock segment gets skipped next.
//
// NO IMPORTS, deliberately -- test/refresh.mjs lifts this verbatim so the choice
// is asserted in Node rather than argued about.
//
// It exists because a reviewed change proposed dropping one conjunct here as
// redundant, the reviewers split on the guard it was bundled with, and the whole
// thing was deferred. Both halves are settled below, in code rather than prose.

/** How far back to look. A timeupdate can fire immediately before an already
 *  scheduled skip, so a segment fractionally behind the playhead is still the
 *  one meant, and skipping at a negative interval means "now". */
export const LOOKBACK_S = 0.3;

/** Inside this much of the end of the video, seeking to a segment's end is
 *  treated as seeking to the end of the video. */
export const END_OF_VIDEO_S = 1;

/** Only the part of a segment this file needs. Generic at the call sites below
 *  so the caller's richer type flows through untouched -- narrowing it here
 *  would strip category and UUID off everything downstream. */
export interface HasSegment {
    segment: [number, number];
}

/**
 * The segments still ahead of the playhead, soonest first.
 *
 * BOTH CONJUNCTS ARE KEPT, and the second is not the dead weight it looks like.
 * For a well-formed segment it is genuinely implied -- start <= end, so
 * start > x gives end > x -- and dropping it would change nothing. What it
 * costs is one comparison; what it buys is that a MALFORMED segment, with its
 * end before its start, cannot be selected on the strength of its start alone
 * and then seek the player backwards. These segments come from a community API
 * over the network, so "well-formed" is an assumption about someone else's
 * data. Redundant against the happy path is not the same as useless.
 */
export function nextSegments<T extends HasSegment>(
    segments: T[] | null | undefined,
    currentTime: number,
): T[] {
    if (!Array.isArray(segments)) return [];
    const cutoff = (Number.isFinite(currentTime) ? currentTime : 0) - LOOKBACK_S;
    return segments
        .filter(
            (seg) =>
                Array.isArray(seg?.segment) && seg.segment[0] > cutoff && seg.segment[1] > cutoff,
        )
        .sort((a, b) => a.segment[0] - b.segment[0]);
}

/**
 * Where the player should land after skipping a segment.
 *
 * A segment ending within END_OF_VIDEO_S of the end of the video seeks to one
 * second short of its end rather than to the end itself. That is a BACKWARD seek
 * relative to the segment, and for a segment shorter than that second it lands
 * back INSIDE the segment -- which is the ping-pong the deferral warned about.
 * It is real, it is bounded (the caller's repeat guard stops re-skipping the
 * same UUID inside a second, with a toast), and it is asserted below so the
 * behaviour is recorded rather than rediscovered.
 */
export function seekTargetFor(end: number, duration: number): number {
    if (!Number.isFinite(end)) return 0;
    if (!Number.isFinite(duration)) return end;
    return duration - end < END_OF_VIDEO_S ? end - 1 : end;
}

/** Whether landing at `target` leaves the playhead inside the segment that was
 *  just skipped -- i.e. whether the caller is about to be asked to skip it
 *  again. */
export function landsInsideSegment(seg: HasSegment | null | undefined, target: number): boolean {
    if (!seg || !Array.isArray(seg.segment)) return false;
    const [start, end] = seg.segment;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(target)) return false;
    return target > start - LOOKBACK_S && target < end;
}
