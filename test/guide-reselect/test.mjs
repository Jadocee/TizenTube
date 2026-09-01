// Selecting the sidebar entry for the page you are already on.
//
// The app deliberately dispatches nothing there -- its guide handler computes
// `f = selectedIndex === c` and then guards the dispatch with `if (!f || _.KA)`
// and again with `if (!f || g)`, where g is true only for a searchEndpoint and
// `_.KA` is a build bit no userscript sets. So the feature works by noticing an
// ABSENCE, and the only thing that makes that safe is the set of conditions
// under which it stands down. Those are all here.
//
// The asymmetry every assertion below encodes: a missed refresh costs a feature
// nobody had yesterday; a wrong refresh reloads a page the user was navigating
// away from. Every uncertain branch has to fall the first way.
import { checker } from '../lib/repo.mjs';
import {
    shouldArm,
    decide,
    isRefreshableRoute,
    RESELECT_WINDOW_MS,
    GUIDE_DEBOUNCE_MS,
} from './guideReselect.generated.mts';

const { check, done } = checker();

// --- the window has to clear the app's own debounce -------------------------
// The guide waits 150ms before calling resolveCommand. A shorter window would
// read a real navigation as an absence and fire a reload into a page already on
// its way out -- the one way this feature could actively hurt.
check('the window clears the guide debounce', RESELECT_WINDOW_MS > GUIDE_DEBOUNCE_MS, true);
check('  ...with real margin', RESELECT_WINDOW_MS - GUIDE_DEBOUNCE_MS >= 200, true);

// --- which routes are refreshable -------------------------------------------
// Home is the bare hash: the app's hash writer special-cases `default` and
// `FEtopics` and writes no `c=` for them, so the live TV home is just `#/`.
check('an empty hash is home', isRefreshableRoute(''), true);
check('a bare slash is home', isRefreshableRoute('/'), true);
check('  ...and one still carrying its #', isRefreshableRoute('#/'), true);
check('a browse route is refreshable', isRefreshableRoute('/browse?c=FEsubscriptions'), true);
check('  ...with params too', isRefreshableRoute('/browse?c=FEmusic&params=x'), true);
// A press that dispatches nothing on a watch page is not a re-selection, and
// reloading the player out from under a video would be the worst outcome here.
check('a watch route is NOT refreshable', isRefreshableRoute('/watch?v=abc'), false);
check('a search route is NOT refreshable', isRefreshableRoute('/search?q=cats'), false);
check('something unrecognised is NOT refreshable', isRefreshableRoute('/nonsense'), false);
check('null is not', isRefreshableRoute(null), false);
check('a number is not', isRefreshableRoute(42), false);

// --- when a press is even a candidate ---------------------------------------
const armable = {
    enabled: true,
    guideFocused: true,
    hash: '#/',
    entryKey: 'YTLR-GUIDE-ENTRY|guideEntry|Home||0',
};
check('an ordinary sidebar press on home arms', shouldArm(armable), true);
check('the setting off never arms', shouldArm({ ...armable, enabled: false }), false);
// The single most important stand-down: the sidebar must actually have focus.
// A press anywhere else in the app -- opening a video, a settings row, a search
// result -- must never be read as a sidebar re-selection.
check(
    'a press with the sidebar unfocused never arms',
    shouldArm({ ...armable, guideFocused: false }),
    false,
);
check('no identifiable entry never arms', shouldArm({ ...armable, entryKey: null }), false);
check('an empty entry key never arms', shouldArm({ ...armable, entryKey: '' }), false);
check('a watch route never arms', shouldArm({ ...armable, hash: '/watch?v=abc' }), false);
check('null input never arms', shouldArm(null), false);
check('undefined input never arms', shouldArm(undefined), false);

// --- the decision -----------------------------------------------------------
const before = { hash: '#/', entryKey: 'home', commands: 7 };
check('nothing happened at all -> refresh', decide(before, { ...before }), 'refresh');

// A dispatched command is the strongest evidence the press was a real
// navigation, and it is checked first because it is true even when the
// destination happens to share our hash.
check('a command was dispatched -> stand down', decide(before, { ...before, commands: 8 }), 'none');
check(
    '  ...even if the hash has not caught up yet',
    decide(before, { hash: '#/', entryKey: 'home', commands: 9 }),
    'none',
);
check(
    'the route moved -> stand down',
    decide(before, { ...before, hash: '#/browse?c=FEmusic' }),
    'none',
);
check(
    'focus moved to another entry -> stand down',
    decide(before, { ...before, entryKey: 'subscriptions' }),
    'none',
);
// The route can leave and come back within the window without the hash
// comparison catching it, so the destination is re-checked on its own terms.
check(
    'landing on a watch route -> stand down',
    decide({ ...before, hash: '#/watch?v=a' }, { ...before, hash: '#/watch?v=a' }),
    'none',
);

// --- junk -------------------------------------------------------------------
let threw = null;
const JUNK = [null, undefined, {}, 0, '', [], true, { hash: 1, entryKey: 2, commands: NaN }];
for (const a of JUNK) {
    for (const b of JUNK) {
        try {
            const d = decide(a, b);
            if (d !== 'none' && d !== 'refresh') threw = `decide returned ${JSON.stringify(d)}`;
        } catch (e) {
            threw = `decide(${JSON.stringify(a)}, ${JSON.stringify(b)}) threw ${e.message}`;
        }
    }
    try {
        shouldArm(a);
        isRefreshableRoute(a);
    } catch (e) {
        threw = `${JSON.stringify(a)} threw ${e.message}`;
    }
}
check('junk never throws and never yields an unknown decision', threw, null);
// A NaN counter cannot be compared meaningfully, so it must not be read as "no
// command was dispatched".
check(
    'a NaN command count stands down rather than refreshing',
    decide(
        { hash: '#/', entryKey: 'home', commands: NaN },
        { hash: '#/', entryKey: 'home', commands: NaN },
    ),
    'none',
);

done();
