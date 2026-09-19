/**
 * Whether YouTube is showing one of its own startup screens this launch.
 *
 * THE BUG THIS EXISTS FOR. ui.ts fires a startup command once its 250ms poll
 * sees a <video> element -- SOFT_RELOAD_PAGE, or a navigation when
 * launchToOnStartup is set -- and reloadHomeOnStartup defaults to on. When the
 * app had decided to show the account picker, that reload tore the picker down
 * and landed on the signed-in account's home, which reads as being logged in as
 * the previous user before you could choose. It was intermittent because the
 * trigger is "a <video> element appeared", sampled every 250ms, racing the
 * picker's render.
 *
 * TWO SIGNALS, BECAUSE NEITHER IS ENOUGH ALONE.
 *
 * `window.startupNavigation.startupScreenType` is the better one: tv.html's
 * pre-bootstrap sets it once, before the app boots, and nothing clears it, so it
 * answers "was a startup screen scheduled for this launch" rather than "is one
 * on screen at this instant" -- which matters when the answer is being read from
 * a poll. But the app only publishes it when one of two server flags is on
 * (enable_startup_screen_from_pre_bootstrap, enable_early_startup_screen_
 * validation), and those are per-account and per-device, so it can simply be
 * absent.
 *
 * The body class is the fallback. The app assigns document.body.className
 * wholesale as [pageType, windowSize, flags] immediately before it renders, and
 * the startup screens have real page types of their own -- the same mechanism
 * that gives the watch page WEB_PAGE_TYPE_WATCH. It is a moment-in-time answer,
 * which is why it is second.
 */

/** Startup screen types that mean "the user is being asked something". */
const BLOCKING_SCREENS = [
    'STARTUP_SCREEN_ACCOUNT_SELECTOR',
    'STARTUP_SCREEN_WELCOME',
    'STARTUP_SCREEN_SIGNED_OUT_WELCOME_BACK',
    'STARTUP_SCREEN_PREMIUM_LITE_UPSELL',
    'STARTUP_SCREEN_KIDS_BLOCK',
];

/** Page types the app uses for those screens, plus the accounts page. */
const BLOCKING_PAGE_TYPES = [
    'WEB_PAGE_TYPE_ACCOUNT_SELECTOR',
    'WEB_PAGE_TYPE_WELCOME',
    'WEB_PAGE_TYPE_ACCOUNTS',
    'WEB_PAGE_TYPE_PREMIUM_LITE_UPSELL',
];

export interface StartupProbe {
    /** window.startupNavigation.startupScreenType, when the app published it. */
    startupScreenType?: unknown;
    /** document.body.className, as the app last assigned it. */
    bodyClassName?: unknown;
}

/**
 * True when the mod must not navigate: the app is asking the user something.
 *
 * Deliberately NOT true for STARTUP_SCREEN_NONE or _UNKNOWN. UNKNOWN is what
 * pre-bootstrap writes when it declines to decide -- on a cast launch, a
 * deeplink, or a return from account switch -- and treating that as "a screen is
 * up" would suppress the startup reload on exactly the launches that most want
 * it.
 */
export function onStartupScreen(probe: StartupProbe): boolean {
    const type = probe.startupScreenType;
    if (typeof type === 'string' && BLOCKING_SCREENS.includes(type)) return true;

    const className = probe.bodyClassName;
    if (typeof className !== 'string') return false;
    // Whole-token match. The class list is space separated and
    // WEB_PAGE_TYPE_ACCOUNTS is a prefix of nothing here, but a substring test
    // would still be the wrong shape to leave for the next page type.
    const tokens = className.split(/\s+/);
    return BLOCKING_PAGE_TYPES.some((t) => tokens.includes(t));
}

/** Reads both signals off the live window. */
export function onStartupScreenNow(): boolean {
    const nav = (window as unknown as { startupNavigation?: { startupScreenType?: unknown } })
        .startupNavigation;
    return onStartupScreen({
        startupScreenType: nav?.startupScreenType,
        bodyClassName: document.body?.className,
    });
}

/** How long to wait for a startup screen to go away, in 250ms polls. Five
 *  minutes: the thing being waited for is a person choosing an account, and a
 *  set left on the picker overnight should not still be polling by morning. */
export const STARTUP_SCREEN_WAIT_POLLS = 1200;

export interface DeferOptions {
    /** Reads the live signals. Injected so a harness can drive it. */
    isOnScreen: () => boolean;
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
    /** Defaults to STARTUP_SCREEN_WAIT_POLLS. */
    maxPolls?: number;
}

/**
 * Runs `task` once, as soon as no startup screen is in the way.
 *
 * WHY THIS IS NOT JUST A GUARD. ui.ts's startup block fires SOFT_RELOAD_PAGE and
 * repaints the guide, and both must stay away from the account picker -- firing
 * under it tears it down and logs you in as the previous user. The first fix
 * skipped the block outright when a screen was up, on the reasoning that picking
 * an account navigates anyway and that navigation would be processed like any
 * other.
 *
 * That assumed the mod survives the choice. It does not. Switching accounts
 * reloads the DOCUMENT -- the app's own command is named `reloadOnAccountSwitch`
 * and signing out fires `signalAction:{signal:"RELOAD_PAGE"}`, which resolves to
 * a top-frame navigation -- so every hook the mod installed dies, and in the new
 * document tv.html's inline pre-bootstrap POSTs for the home feed before any
 * external script runs. Whether the mod is re-injected and has patched
 * JSON.parse before that response lands is a race against the network. The
 * startup reload is what covers the launches where it loses, and skipping it on
 * exactly the launches that follow an account switch is how ads came back.
 *
 * So the block is deferred instead: the picker is never disturbed, and the feed
 * still gets its pass through the mod once the picker is gone.
 *
 * Runs AT MOST ONCE, and not at all if the budget runs out with the screen still
 * up -- firing then would be the original bug on a slow chooser.
 */
export function whenStartupScreenClears(task: () => void, opts: DeferOptions): void {
    if (!opts.isOnScreen()) {
        task();
        return;
    }

    const limit = opts.maxPolls === undefined ? STARTUP_SCREEN_WAIT_POLLS : opts.maxPolls;
    let waited = 0;
    const handle = opts.setInterval(() => {
        if (opts.isOnScreen() && ++waited <= limit) return;
        opts.clearInterval(handle);
        // Re-checked rather than assumed: the loop also exits on the budget, and
        // the screen can still be up when it does.
        if (!opts.isOnScreen()) task();
    }, 250);
}
