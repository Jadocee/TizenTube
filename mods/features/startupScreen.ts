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
