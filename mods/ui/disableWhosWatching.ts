import { configChangeEmitter, configRead } from '../config.js';

/** The slice of YouTube's `recurring_actions` entry that the mod rewrites. */
interface RecurringActions {
    data: { data: Record<string, { lastFired: number }> };
}

const RECURRING_ACTIONS_KEY = 'yt.leanback.default::recurring_actions';

// The startup screens this feature schedules. YouTube only records an action
// once it has fired, so a profile that has never seen one simply has no entry
// for it -- two of these were already treated as optional, the third was not.
const STARTUP_ACTIONS = [
    'startup-screen-account-selector-with-guest',
    'whos_watching_fullscreen_zero_accounts',
    'startup-screen-signed-out-welcome-back',
];

configChangeEmitter.addEventListener('configChange', (event) => {
    const { key, value } = event.detail;
    // permanentlyEnableWhoIsWatchingMenu is what decides whether the interval
    // below gets armed, and it is a user-facing toggle too -- dropping its
    // change meant turning it off left the 60s interval running until reload.
    // Re-read rather than trusting event.value, which for the perma key is not
    // the argument this function takes.
    if (key === 'enableWhoIsWatchingMenu' || key === 'permanentlyEnableWhoIsWatchingMenu') {
        disableWhosWatching(configRead('enableWhoIsWatchingMenu'));
    }
});

let interval: ReturnType<typeof setInterval> | null | undefined;

function readRecurringActions(): RecurringActions | null {
    try {
        const stored = JSON.parse(localStorage[RECURRING_ACTIONS_KEY]);
        return stored?.data?.data ? stored : null;
    } catch (e) {
        // Absent on a fresh profile, and this runs before YouTube has booted.
        console.info('No leanback recurring actions to adjust yet.');
        return null;
    }
}

function setLastFired(recurringActions: RecurringActions, time: number): void {
    for (const action of STARTUP_ACTIONS) {
        const entry = recurringActions.data.data[action];
        if (entry) entry.lastFired = time;
    }
    localStorage[RECURRING_ACTIONS_KEY] = JSON.stringify(recurringActions);
}

function disableWhosWatching(value: unknown): void {
    // Everything below runs at module scope on launch. It used to throw on a
    // missing key or a missing action entry, and a throw there aborts every
    // module imported after this one in the bundle.
    const LeanbackRecurringActions = readRecurringActions();
    if (!LeanbackRecurringActions) return;

    const shouldPermanentlyEnable = configRead('permanentlyEnableWhoIsWatchingMenu');
    const date = new Date();

    if (interval) {
        clearInterval(interval);
        interval = null;
    }

    if (!value) {
        // Setting it after 7 days should be enough, as it'll get executed every time the app launches.
        date.setDate(date.getDate() + 7);
        setLastFired(LeanbackRecurringActions, date.getTime());
        return;
    }

    const lastFired =
        LeanbackRecurringActions.data.data['startup-screen-account-selector-with-guest']?.lastFired;
    const sinceLastFired = date.getTime() - lastFired;
    // Do nothing if the last fired action is less than 2 hours ago.
    if (sinceLastFired > 0 && sinceLastFired < 2 * 60 * 60 * 1000 && !shouldPermanentlyEnable) {
        return;
    }

    setLastFired(LeanbackRecurringActions, date.getTime());

    if (shouldPermanentlyEnable) {
        date.setDate(date.getDate() - 7);
        setLastFired(LeanbackRecurringActions, date.getTime());
        // Re-read each tick. setLastFired re-serialises the whole blob it is
        // handed, and this used to hand it the snapshot parsed at launch --
        // rewriting every unrelated key YouTube had updated since, once a minute.
        interval = setInterval(() => {
            const fresh = readRecurringActions();
            if (fresh) setLastFired(fresh, date.getTime());
        }, 60 * 1000);
    }
}

disableWhosWatching(configRead('enableWhoIsWatchingMenu'));
