// Which transport-control slot gets previous and which gets next.
//
// The bug this pins shipped, and it was invisible from here until the real
// bundle was on disk. The app resolves its two skip buttons as
//
//     this.F = ... _.B(_.E("isRtl", !1) ? d.skipNextButton : d.skipPreviousButton, _.hA)
//     this.B = ... _.B(_.E("isRtl", !1) ? d.skipPreviousButton : d.skipNextButton, _.hA)
//
// -- fixed SLOTS whose MEANING swaps with the layout direction. customUI finds
// those two methods by matching their source text, which contains the whole
// ternary and is therefore the same string whichever way isRtl resolves. So the
// mod assigned previous to the first slot always, and on a right-to-left
// account its two buttons sat the wrong way round.
import { checker } from '../lib/repo.mjs';
import { transportSlots, documentIsRtl } from './mod.generated.mts';

const { check, done } = checker();
const NAMES = { first: 'F', second: 'B' };

// --- left to right, the ordinary case ---------------------------------------
const ltr = transportSlots(NAMES, false);
check('ltr puts previous in the first slot', ltr.previous, 'F');
check('  ...and next in the second', ltr.next, 'B');

// --- right to left ----------------------------------------------------------
const rtl = transportSlots(NAMES, true);
check('rtl swaps them', rtl.previous, 'B');
check('  ...both ways', rtl.next, 'F');
// The whole point, stated as an invariant rather than as two values.
check(
    'the two directions are mirror images',
    rtl.previous === ltr.next && rtl.next === ltr.previous,
    true,
);
// ...and neither direction may drop a slot or use one twice: doing so would
// leave half the transport row replaced and half YouTube's own.
for (const [label, got] of [
    ['ltr', ltr],
    ['rtl', rtl],
]) {
    check(`${label} assigns both slots`, !!got.previous && !!got.next, true);
    check(`  ...to different methods`, got.previous !== got.next, true);
}

// --- a name that was never found --------------------------------------------
// customUI gates on having found something; the mapping must not invent one,
// because a half-patched row is worse than an unpatched one.
check(
    'a missing first name yields nothing',
    JSON.stringify(transportSlots({ second: 'B' }, false)),
    '{}',
);
check(
    'a missing second name yields nothing',
    JSON.stringify(transportSlots({ first: 'F' }, false)),
    '{}',
);
check('no names at all yields nothing', JSON.stringify(transportSlots({}, true)), '{}');
check('null yields nothing', JSON.stringify(transportSlots(null, false)), '{}');

// --- reading the direction off the document ---------------------------------
const doc = (dir, computed) => ({
    documentElement: { dir },
    defaultView:
        computed === undefined ? undefined : { getComputedStyle: () => ({ direction: computed }) },
});
check('an explicit rtl attribute is rtl', documentIsRtl(doc('rtl')), true);
check('  ...case-insensitively', documentIsRtl(doc('RTL')), true);
check('an explicit ltr attribute is not', documentIsRtl(doc('ltr')), false);
// The attribute is often absent while the direction is inherited or set in CSS,
// which is how the app itself ends up rtl.
check('an inherited direction still counts', documentIsRtl(doc('', 'rtl')), true);
check('  ...and ltr does not', documentIsRtl(doc('', 'ltr')), false);

// Everything unreadable falls back to ltr, which is the layout almost every set
// uses -- getting this wrong the other way would swap the buttons for everyone.
check('no document is ltr', documentIsRtl(null), false);
check('no documentElement is ltr', documentIsRtl({}), false);
check('no defaultView is ltr', documentIsRtl(doc('')), false);
let threw = null;
try {
    documentIsRtl({
        get documentElement() {
            throw new Error('detached');
        },
    });
} catch (e) {
    threw = e.message;
}
check('a throwing document does not escape', threw, null);

done();
