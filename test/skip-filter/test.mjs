// Which SponsorBlock segment gets skipped next, and where the player lands.
//
// This harness exists to settle an argument. A reviewed change proposed dropping
// the second conjunct of the skip filter as redundant, bundled that with an
// end-of-video guard, and the reviewers split on the guard -- so the whole thing
// was deferred with the note "they land together or not at all". Both halves are
// decidable, and neither needed a television.
import { checker } from '../lib/repo.mjs';
import {
    nextSegments,
    seekTargetFor,
    landsInsideSegment,
    LOOKBACK_S,
    END_OF_VIDEO_S,
} from './mod.generated.mts';

const { check, done } = checker();
const seg = (a, b, extra = {}) => ({ segment: [a, b], ...extra });

// --- the ordinary case ------------------------------------------------------
const ahead = [seg(30, 40), seg(10, 20), seg(50, 60)];
check(
    'segments ahead are returned soonest first',
    JSON.stringify(nextSegments(ahead, 5).map((s) => s.segment[0])),
    '[10,30,50]',
);
check('a segment behind the playhead is dropped', nextSegments([seg(10, 20)], 25).length, 0);

// The lookback: a timeupdate can fire immediately before an already scheduled
// skip, so a segment fractionally behind is still the one meant.
//
// Pinned to CONCRETE values as well as symbolic ones. Assertions written only in
// terms of the constants move with them, so setting LOOKBACK_S to 0 left every
// one of them passing -- a constant its own tests cannot see change is not being
// tested at all.
check('the lookback is three tenths of a second', LOOKBACK_S, 0.3);
check('the end-of-video window is one second', END_OF_VIDEO_S, 1);
check('a segment 0.2s behind is still in range', nextSegments([seg(10, 20)], 10.2).length, 1);
check('  ...and one 0.4s behind is not', nextSegments([seg(10, 20)], 10.4).length, 0);
check(
    'a segment just behind is still in range',
    nextSegments([seg(10, 20)], 10 + LOOKBACK_S - 0.01).length,
    1,
);
check(
    '  ...and one further back is not',
    nextSegments([seg(10, 20)], 10 + LOOKBACK_S + 0.01).length,
    0,
);

// --- THE CONJUNCT the review wanted removed ---------------------------------
// For a well-formed segment it IS implied: start <= end, so start > x gives
// end > x. Asserted so the redundancy claim is on the record as true...
const wellFormed = [seg(10, 20), seg(30, 40), seg(0, 5)];
for (const t of [0, 4.9, 9.8, 25, 100]) {
    const both = nextSegments(wellFormed, t).length;
    const startOnly = wellFormed.filter((s) => s.segment[0] > t - LOOKBACK_S).length;
    check(`at t=${t} the second conjunct changes nothing for well-formed data`, both, startOnly);
}

// ...and this is why it stays anyway. These segments arrive from a community API
// over the network, so start <= end is an assumption about someone else's data.
// A malformed segment passes the start test and would be selected on it alone --
// then the player is seeked to an end that is in the past.
const malformed = seg(50, 10);
check('a malformed segment passes the start test', malformed.segment[0] > 20 - LOOKBACK_S, true);
check('  ...and is rejected anyway', nextSegments([malformed], 20).length, 0);
check(
    '  ...which is the whole value of the "redundant" conjunct',
    malformed.segment[1] > 20 - LOOKBACK_S,
    false,
);

// --- where the player lands -------------------------------------------------
check('an ordinary skip lands on the segment end', seekTargetFor(40, 100), 40);
check('  ...even close to the end, if there is room', seekTargetFor(98, 100), 98);
// Inside END_OF_VIDEO_S of the end, it lands a second short instead.
check('a skip at the very end lands short', seekTargetFor(99.5, 100), 98.5);
check(
    '  ...exactly at the boundary',
    seekTargetFor(100 - END_OF_VIDEO_S, 100),
    100 - END_OF_VIDEO_S,
);

// --- THE PING-PONG the reviewers split over ---------------------------------
// It is real, and this is exactly when: a segment SHORTER than the second the
// end-of-video guard rewinds by lands back inside itself.
const shortAtEnd = seg(99.5, 99.9);
const target = seekTargetFor(shortAtEnd.segment[1], 100);
check(
    'the guard rewinds past the start of a short end segment',
    target < shortAtEnd.segment[0],
    true,
);
// BEFORE it, not inside it -- and that is the mechanism. Landing inside would be
// harmless, because a segment behind the playhead is filtered out. Landing in
// FRONT of it puts it ahead again, so it is selected and skipped a second time,
// which rewinds again.
check(
    '  ...landing in front of it rather than inside',
    landsInsideSegment(shortAtEnd, target),
    false,
);
// Bounded, not infinite: the caller keeps a per-UUID repeat guard that refuses a
// second skip of the same segment inside a second and shows a toast instead. The
// observable effect is one extra rewind and one toast at the end of a video,
// which is why this was worth recording rather than urgently fixing.
check(
    '  ...and it is selected for skipping a second time',
    nextSegments([shortAtEnd], target).length,
    1,
);

// A segment longer than the rewind does NOT ping-pong, which is why this is a
// narrow case rather than a general breakage.
const longAtEnd = seg(90, 99.9);
const longTarget = seekTargetFor(longAtEnd.segment[1], 100);
check('a long end segment is not re-entered', landsInsideSegment(longAtEnd, longTarget), true);
check(
    '  ...but is not re-selected, being behind the playhead',
    nextSegments([longAtEnd], longTarget).length,
    0,
);

// --- junk -------------------------------------------------------------------
// All of this runs off a network response and a media element, on a device with
// no console.
let threw = null;
const JUNK = [null, undefined, 0, '', 'x', [], {}, NaN, true, [null], [{}], [{ segment: 'x' }]];
for (const v of JUNK) {
    try {
        nextSegments(v, 10);
        nextSegments([seg(1, 2)], v);
        seekTargetFor(v, v);
        landsInsideSegment(v, v);
    } catch (e) {
        threw = `${JSON.stringify(v)} threw ${e.message}`;
    }
}
check('nothing throws on junk', threw, null);
check(
    'a malformed entry is dropped, not crashed on',
    nextSegments([{ segment: 'x' }, seg(10, 20)], 5).length,
    1,
);
check('a non-finite time is treated as zero', nextSegments([seg(10, 20)], NaN).length, 1);

done();
