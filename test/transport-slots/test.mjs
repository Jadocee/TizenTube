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

// --- the theme-panel closer registry ----------------------------------------
// Lives here rather than in its own directory because it is the same shape of
// problem: a decision that had to be extracted into an import-free module so
// two files could share it. speedUI's BLUE key has to close the theme panel,
// ui.ts owns the real close, and ui -> resolveCommand -> speedUI means speedUI
// cannot import it.
const host = await import('./panelHost.generated.mts');

host.resetThemePanelCloser();
check('nothing registered means nothing was closed', host.closeThemePanel(), false);

let closed = 0;
host.registerThemePanelCloser(() => closed++);
check('a registered closer runs', host.closeThemePanel(), true);
check('  ...exactly once', closed, 1);

// The return value is what speedUI branches on: false has to mean "there was
// nothing to close", so it can fall back to hiding the panel itself.
host.resetThemePanelCloser();
host.registerThemePanelCloser(() => {
    throw new Error('hidePanel blew up');
});
let escaped = null;
let result = null;
try {
    result = host.closeThemePanel();
} catch (e) {
    escaped = e.message;
}
// This runs from a capture-phase key handler on the document; an escape there
// would take the key press with it.
check('a throwing closer does not escape', escaped, null);
check('  ...and reports that it did not close', result, false);

// Asserted against a GOOD closer already in place, because that is the only way
// the guard is observable: registering junk over nothing leaves nothing either
// way, so the first version of this check passed with the guard deleted.
host.resetThemePanelCloser();
let good = 0;
host.registerThemePanelCloser(() => good++);
for (const junk of [null, undefined, 0, '', 'x', {}, []]) {
    host.registerThemePanelCloser(junk);
}
check('junk does not replace a working closer', host.closeThemePanel(), true);
check('  ...and the real one still ran', good, 1);

// Re-registering replaces rather than accumulating: ui.ts's init can run more
// than once, and two closers would hand focus back twice.
host.resetThemePanelCloser();
let a = 0;
let b = 0;
host.registerThemePanelCloser(() => a++);
host.registerThemePanelCloser(() => b++);
host.closeThemePanel();
check('re-registering replaces the closer', `${a}${b}`, '01');

done();
