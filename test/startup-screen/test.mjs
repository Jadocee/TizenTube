// Whether the mod's startup command knows to stay out of the way.
//
// THE BUG THIS EXISTS FOR. ui.ts runs its startup block off a 250ms poll for a
// <video> element and, with reloadHomeOnStartup on by default, fires
// SOFT_RELOAD_PAGE. When the app had decided to show the account picker, that
// reload tore it down and landed on the signed-in account's home -- the picker
// appearing and then logging you in as the previous user before you could
// choose. Intermittent, because the trigger is "a <video> element appeared",
// sampled every 250ms, racing the picker's render.
//
// The predicate is the guard. It is pure so it can be driven over the shapes the
// app really produces, including the two that must NOT suppress the reload --
// STARTUP_SCREEN_NONE and _UNKNOWN -- because getting those wrong would disable
// the startup reload on ordinary launches and nothing on screen would say why.
import {
    onStartupScreen,
    whenStartupScreenClears,
    STARTUP_SCREEN_WAIT_POLLS,
} from './mod.generated.mts';
import { checker } from '../lib/repo.mjs';

const { check, done } = checker();

// A real body className, as the app assigns it: [pageType, windowSize, flags].
const body = (pageType) => `${pageType} landscape full-animation app-quality-root`;

// --- the screens that must hold the reload off -----------------------------
for (const type of [
    'STARTUP_SCREEN_ACCOUNT_SELECTOR',
    'STARTUP_SCREEN_WELCOME',
    'STARTUP_SCREEN_SIGNED_OUT_WELCOME_BACK',
    'STARTUP_SCREEN_PREMIUM_LITE_UPSELL',
    'STARTUP_SCREEN_KIDS_BLOCK',
]) {
    check(`${type} holds the reload`, onStartupScreen({ startupScreenType: type }), true);
}

// --- the two that must NOT ---------------------------------------------------
// UNKNOWN is what pre-bootstrap writes when it declines to decide -- a cast
// launch, a deeplink, a return from account switch. Treating it as a screen
// would kill the startup reload on exactly those launches.
check('NONE does not', onStartupScreen({ startupScreenType: 'STARTUP_SCREEN_NONE' }), false);
check('  ...nor UNKNOWN', onStartupScreen({ startupScreenType: 'STARTUP_SCREEN_UNKNOWN' }), false);

// --- the fallback, for when the app publishes no startupNavigation -----------
// It is only set when enable_startup_screen_from_pre_bootstrap or
// enable_early_startup_screen_validation is on, and those are per-account and
// per-device, so absent is an ordinary case rather than an error.
check(
    'the account-selector page type holds it',
    onStartupScreen({ bodyClassName: body('WEB_PAGE_TYPE_ACCOUNT_SELECTOR') }),
    true,
);
check(
    '  ...and the welcome page type',
    onStartupScreen({ bodyClassName: body('WEB_PAGE_TYPE_WELCOME') }),
    true,
);
check(
    '  ...and the accounts page',
    onStartupScreen({ bodyClassName: body('WEB_PAGE_TYPE_ACCOUNTS') }),
    true,
);
check(
    'an ordinary browse launch does not',
    onStartupScreen({ bodyClassName: body('WEB_PAGE_TYPE_BROWSE') }),
    false,
);
check(
    '  ...nor a watch page',
    onStartupScreen({ bodyClassName: body('WEB_PAGE_TYPE_WATCH') }),
    false,
);

// --- whole tokens, not substrings -------------------------------------------
// A substring test would be the wrong shape to leave behind even where no
// current page type collides, so it is asserted rather than assumed.
check(
    'a page type is matched as a whole token',
    onStartupScreen({ bodyClassName: body('WEB_PAGE_TYPE_ACCOUNT_SELECTOR_SOMETHING_ELSE') }),
    false,
);

// --- nothing to go on -------------------------------------------------------
// Absent signals must read as "no screen". The reload is the normal behaviour;
// failing closed here would silently disable it for anyone whose device never
// publishes startupNavigation and is mid-navigation when the poll fires.
check('no signals at all', onStartupScreen({}), false);
check('  ...a missing className', onStartupScreen({ bodyClassName: undefined }), false);
check('  ...a non-string className', onStartupScreen({ bodyClassName: 42 }), false);
check('  ...a non-string screen type', onStartupScreen({ startupScreenType: {} }), false);
check('  ...an empty className', onStartupScreen({ bodyClassName: '' }), false);

// --- either signal alone is enough ------------------------------------------
check(
    'the screen type wins even on a browse body',
    onStartupScreen({
        startupScreenType: 'STARTUP_SCREEN_ACCOUNT_SELECTOR',
        bodyClassName: body('WEB_PAGE_TYPE_BROWSE'),
    }),
    true,
);
check(
    'and the body class wins with no screen type',
    onStartupScreen({
        startupScreenType: undefined,
        bodyClassName: body('WEB_PAGE_TYPE_ACCOUNT_SELECTOR'),
    }),
    true,
);

// --- deferring, which is the half that was missing -------------------------
// THE SECOND BUG. The predicate above was used as a plain guard: when a screen
// was up the startup block was SKIPPED, on the reasoning that picking an account
// navigates anyway and that navigation would be processed like any other.
//
// It is not, because the mod is not there to process it. Switching accounts
// reloads the DOCUMENT -- the app's own command is `reloadOnAccountSwitch`, and
// signing out fires signalAction:{signal:"RELOAD_PAGE"}, which resolves through
// ReloadPageCommandResolver to a top-frame navigation. In the new document
// tv.html's inline pre-bootstrap POSTs for the home feed before any external
// script runs, so whether the mod has patched JSON.parse before that response
// lands is a race. The startup reload covers the launches where it loses, and
// skipping it on exactly the launches that follow an account switch is how ads
// came back after switching accounts.
//
// Driven with a fake clock: the real one takes five minutes to reach the budget.
function harness({ screenFor }) {
    let now = 0;
    let ran = 0;
    const timers = new Map();
    let seq = 0;
    const opts = {
        isOnScreen: () => now < screenFor,
        setInterval: (fn, ms) => {
            const id = ++seq;
            timers.set(id, { fn, ms });
            return id;
        },
        clearInterval: (id) => timers.delete(id),
    };
    const tick = (polls) => {
        for (let i = 0; i < polls; i++) {
            now += 250;
            for (const [, t] of [...timers]) t.fn();
        }
    };
    whenStartupScreenClears(() => ran++, opts);
    return { tick, ran: () => ran, live: () => timers.size };
}

// No screen: straight through, no timer at all.
const clear = harness({ screenFor: 0 });
check('with no startup screen it runs at once', clear.ran(), 1);
check('  ...and schedules nothing', clear.live(), 0);

// A screen that clears after four polls.
const brief = harness({ screenFor: 1000 });
check('with a screen up it does not run yet', brief.ran(), 0);
brief.tick(3);
check('  ...still held off three polls in', brief.ran(), 0);
brief.tick(2);
check('  ...and runs once the screen clears', brief.ran(), 1);
check('  ...stopping the timer when it does', brief.live(), 0);
brief.tick(20);
check('  ...exactly once, never again', brief.ran(), 1);

// The picker left up for longer than the budget. Firing then would be the
// original bug on a slow chooser, so it must give up instead.
const forever = harness({ screenFor: Number.POSITIVE_INFINITY });
forever.tick(STARTUP_SCREEN_WAIT_POLLS + 5);
check('a screen that never clears is given up on', forever.ran(), 0);
check('  ...and the timer is not left running', forever.live(), 0);

// The budget is a real number of polls, not an accident.
check('the budget is five minutes at 250ms', STARTUP_SCREEN_WAIT_POLLS * 250, 300000);

done();
