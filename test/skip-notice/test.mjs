// When the SponsorBlock skip notice appears, and for how long.
//
// SponsorBlock used to announce skips through YouTube's own toast, which meant
// its timing was the app's problem. It is now this mod's, and the failure modes
// are all timing: a notice that outlives the skip it describes, one that
// swallows a DIFFERENT skip because a similar one just happened, or one whose
// timer is extended rather than restarted so it never comes down at all. None
// of those is visible from a screenshot, and all of them are one subtraction.
import { checker } from '../lib/repo.mjs';
import {
    NONE,
    shouldShow,
    hidesAt,
    remainingMs,
    NOTICE_DURATION_MS,
    COALESCE_WINDOW_MS,
} from './skipNotice.generated.mts';

const { check, done } = checker();

const T0 = 1_000_000;
const shown = (text, at = T0) => ({ text, shownAt: at });

// --- the ordinary case ------------------------------------------------------
check('the first notice shows', shouldShow(NONE, 'Skipping Sponsor', T0), true);
check('  ...and nothing shows an empty message', shouldShow(NONE, '', T0), false);
check('  ...nor a non-string', shouldShow(NONE, null, T0), false);

// --- coalescing is PER TEXT, and that is the point --------------------------
// Chained segments fire in quick succession; the same phrase twice is one skip
// to the viewer. But a blanket "one notice per three seconds" -- which is the
// shape the old toast helper used -- would swallow the second of two DIFFERENT
// skips, and that second message is the only one that teaches anything.
const sponsor = shown('Skipping Sponsor');
check('the same text again is swallowed', shouldShow(sponsor, 'Skipping Sponsor', T0 + 500), false);
check(
    '  ...right up to the window',
    shouldShow(sponsor, 'Skipping Sponsor', T0 + COALESCE_WINDOW_MS - 1),
    false,
);
check(
    '  ...and shows again once it has passed',
    shouldShow(sponsor, 'Skipping Sponsor', T0 + COALESCE_WINDOW_MS),
    true,
);
check(
    'a DIFFERENT skip is never swallowed',
    shouldShow(sponsor, 'Skipping Interaction Reminder', T0 + 10),
    true,
);

// --- shapes rather than crashes ---------------------------------------------
check('a missing state shows', shouldShow(null, 'Skipping Sponsor', T0), true);
check('a NaN clock shows rather than hiding', shouldShow(sponsor, 'Skipping Sponsor', NaN), true);

// --- how long it stays ------------------------------------------------------
check('the notice comes down after its duration', hidesAt(T0), T0 + NOTICE_DURATION_MS);
check('  ...and junk still yields a finite deadline', hidesAt(NaN), NOTICE_DURATION_MS);

// RESTARTED, not extended. remainingMs is computed from the NEW shownAt, so a
// replacing notice gets a full duration. Subtracting the other way round leaves
// a notice up for the rest of the video, which is the one failure here that
// cannot be waited out.
check('a fresh notice has its whole life', remainingMs(T0, T0), NOTICE_DURATION_MS);
check('  ...less what has elapsed', remainingMs(T0, T0 + 600), NOTICE_DURATION_MS - 600);
check('  ...reaching zero at the deadline', remainingMs(T0, T0 + NOTICE_DURATION_MS), 0);
check('  ...and never going negative', remainingMs(T0, T0 + 99_000), 0);
check(
    'a notice replacing another restarts from now',
    remainingMs(T0 + 2000, T0 + 2000),
    NOTICE_DURATION_MS,
);
check('a NaN clock yields the full duration', remainingMs(T0, NaN), NOTICE_DURATION_MS);

// --- the numbers themselves -------------------------------------------------
// Asserted because they are the whole design: long enough to read two words at
// three metres, short enough not to become furniture, and a coalesce window
// wider than the notice itself so a repeat cannot re-show the instant one goes.
check('the notice is readable but brief', NOTICE_DURATION_MS >= 2000, true);
check('  ...and not furniture', NOTICE_DURATION_MS <= 4000, true);
check('  ...with a window wider than the notice', COALESCE_WINDOW_MS > NOTICE_DURATION_MS, true);

done();
