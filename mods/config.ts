const CONFIG_KEY = 'ytaf-configuration';
const defaultConfig = {
    enableAdBlock: true,
    enableSponsorBlock: true,
    enableSponsorBlockToasts: true,
    sponsorBlockManualSkips: ['intro', 'outro', 'filler'] as string[],
    enableSponsorBlockSponsor: true,
    enableSponsorBlockIntro: true,
    enableSponsorBlockOutro: true,
    enableSponsorBlockInteraction: true,
    enableSponsorBlockSelfPromo: true,
    enableSponsorBlockPreview: true,
    enableSponsorBlockMusicOfftopic: true,
    enableSponsorBlockFiller: false,
    enableSponsorBlockHighlight: true,
    // One entry per channel, stored as "<channelId> <display name>". Channel ids
    // never contain a space, so the first one splits the two unambiguously and the
    // name survives for the settings list -- which would otherwise have to show
    // people a column of raw UC... ids.
    sponsorBlockDisabledChannels: [] as string[],
    videoSpeed: 1,
    preferredVideoQuality: 'auto' as string,
    enableDeArrow: true,
    enableDeArrowThumbnails: false,
    focusContainerColor: '#0f0f0f' as string,
    routeColor: '#0f0f0f' as string,
    enableFixedUI: !(window.h5vcc && window.h5vcc.tizentube),
    enableHqThumbnails: false,
    // On by default: it was asked for. The cost is a 27% narrower title box on
    // every card -- the metadata font does not shrink with the thumbnail -- so
    // it is a taste call, and the toggle is how it gets reversed.
    enableCompactShelves: true,
    enableChapters: true,
    enableLongPress: true,
    enableShorts: true,
    dontCheckUpdateUntil: 0,
    enableWhoIsWatchingMenu: false,
    permanentlyEnableWhoIsWatchingMenu: false,
    enableWhosWatchingMenuOnAppExit: false,
    enableShowUserLanguage: true,
    enableShowOtherLanguages: false,
    showWelcomeToast: true,
    enablePreviousNextButtons: true,
    enableSuperThanksButton: false,
    enableAIAskButton: false,
    enableSpeedControlsButton: true,
    enablePatchingVideoPlayer: true,
    enableMPButton: true,
    enableSwapMPWithPIP: false,
    enablePreviews: true,
    // A focused tile starts playing after three seconds with nothing at all to
    // say so, which leaves "is this a still or is it running?" -- and, since
    // previews are unmuted by default, "where is that audio coming from?" --
    // answerable only by waiting.
    enablePreviewIndicator: true,
    mutePreviews: false,
    // Suppression the user applies from a tile's long-press menu. Both lists ship
    // empty, so the feature is inert until used; the master toggle exists so it
    // can be turned off without emptying them.
    enableHideRecommendations: true,
    // "<videoId> <title>" and "<channelId-or-@handle> <display name>". The key
    // never contains a space, so the first one splits it from the label -- the
    // same shape sponsorBlockDisabledChannels already uses.
    hiddenVideos: [] as string[],
    hiddenChannels: [] as string[],
    // Members-only videos appear in the feed with a badge and a paywall behind
    // them, so for anyone who is not a member they are a row of tiles that cannot
    // be played.
    hideMembersOnlyVideos: false,
    // Captions. The app persists caption STYLING but nothing about the on/off
    // state, so it resets every video; 'leave' is the default so the feature is
    // inert until asked for. Per-channel entries use the same "<key> <name>" form
    // as the other channel lists and beat the global default.
    captionsDefault: 'leave' as string,
    captionsOnChannels: [] as string[],
    captionsOffChannels: [] as string[],
    // AiSList: a community list of channels publishing AI-generated content.
    // Fetched at runtime, never bundled -- see features/aisList.ts for why that is
    // a licence requirement. Off by default: it is third-party data that hides
    // things.
    enableAiSList: false,
    aisListIncludeWarnlist: false,
    enableHideWatchedVideos: false,
    hideWatchedVideosThreshold: 80,
    hideWatchedVideosPages: [] as string[],
    enableHideEndScreenCards: false,
    enableYouThereRenderer: true,
    lastAnnouncementCheck: 0,
    enableScreenDimming: false,
    dimmingTimeout: 60,
    dimmingOpacity: 0.5,
    enablePaidPromotionOverlay: true,
    speedSettingsIncrement: 0.25,
    videoPreferredCodec: 'any' as string,
    launchToOnStartup: '' as string,
    reloadHomeOnStartup: true,
    disabledSidebarContents: [] as string[],
    disableChannelsOnSidebar: false,
    // Watch Later is an account-level row, so it only appears in the guide when
    // signed in -- which is why the option exists rather than the row simply being
    // in disabledSidebarContents alongside the topic entries.
    hideWatchLaterInSidebar: false,
    // Selecting the sidebar entry for the page you are already on. The app itself
    // does nothing there; see features/guideReselect.ts.
    refreshOnReselect: true,
    enableUpdater: true,
    autoFrameRate: false,
    autoFrameRatePauseVideoFor: 0,
    enableSigninReminder: false,
    sortSubscriptionsByAlphabet: false,
    enableClock: false,
    isClock12HourFormat: false,
    clockShowSeconds: false,
    clockPosition: 'top-right' as string,
};

/** Every setting the mod has, and the type each one holds. */
export type Config = typeof defaultConfig;

/** The name of a setting. A typo is now a compile error rather than a
 *  silently-ignored write -- which is exactly how the "Preferred Video Codec"
 *  menu spent its life writing to a key nothing read. */
export type ConfigKey = keyof Config;

export interface ConfigChangeDetail {
    key: ConfigKey;
    value: Config[ConfigKey];
}

type ConfigChangeListener = (event: { type: string; detail: ConfigChangeDetail }) => void;

/** One default, with its array copied so a caller editing what configRead
 *  returned cannot reach the declared default. See readStoredConfig. */
function defaultValue<K extends ConfigKey>(key: K): Config[K] {
    const value = defaultConfig[key];
    return (Array.isArray(value) ? [...value] : value) as Config[K];
}

/** Every default, same guarantee. */
function freshDefaults(): Config {
    const copy = { ...defaultConfig } as Record<string, unknown>;
    for (const key of Object.keys(copy)) {
        const value = copy[key];
        if (Array.isArray(value)) copy[key] = [...value];
    }
    return copy as Config;
}

/**
 * The stored settings, or the defaults when what is stored cannot be used.
 *
 * JSON.parse SUCCEEDING IS NOT THE SAME AS IT RETURNING A CONFIG, and that gap
 * was a total failure of the mod rather than a bad setting. `null`, a number, a
 * string and `true` all parse without throwing, and the first configRead then
 * does `localConfig[key]` on them: reading a key off null throws, and assigning
 * the repaired default onto a number, a string or a boolean throws too, because
 * the bundle is an ES module and therefore strict.
 *
 * THE BLAST RADIUS IS NOT WHAT AN EARLIER VERSION OF THIS COMMENT CLAIMED, and
 * the difference is worth having right. There are four module-scope configRead
 * calls -- previewIndicator.ts, disableWhosWatching.ts, clock.ts,
 * aisListRefresh.ts -- and resolving userScript.ts's import graph puts the first
 * of them at position 70 of 95. settings.ts (47), adblock.ts (56) and
 * sponsorblock.ts (63) have all evaluated by then, so their hooks ARE installed:
 * the failure is not a clean abort but a mod that is half-wired and then throws
 * from inside configRead on every payload it was hooked to handle, while
 * everything from position 70 on never evaluates at all. Either way the set
 * shows plain YouTube and says nothing about why. It is the same failure the
 * who's-watching harness exists for.
 *
 * An array is the quieter version: it parses, it indexes, every read returns a
 * default, and configWrite stringifies it back as `[]` -- so settings appear to
 * save and are gone on the next launch.
 *
 * A COPY OF THE DEFAULTS, AND THE ARRAYS INSIDE THEM TOO. A shallow spread is
 * not enough, and the audit that said it was is the reason this is spelled out:
 * resolveCommand.ts's `arrayValue` branch -- which backs every multi-select row
 * in the settings panel, eight settings including sponsorBlockManualSkips and
 * hiddenChannels -- does `const arr = configRead(item); arr.splice(...)` and
 * edits the array configRead handed it, in place. With a shallow copy that array
 * IS defaultConfig's, so unticking "Intro" once would delete it from the
 * declared default for the rest of the session. (tileMenu's addEntry does
 * rebuild with filter/concat, but it covers only the two tile-menu commands.)
 *
 * So the arrays are copied here, and configRead's repair copies too -- see
 * defaultValue. Reachability of defaultConfig from a caller's hands is now
 * closed by construction, which is the only way it stays closed: the previous
 * comment tried to close it by auditing the callers, and got the audit wrong.
 */
function readStoredConfig(): Config {
    let stored: unknown;
    try {
        stored = JSON.parse(window.localStorage[CONFIG_KEY]);
    } catch (err) {
        // The ordinary path for a fresh install: no key, so JSON.parse is handed
        // the string "undefined".
        console.warn('Config read failed:', err);
        return freshDefaults();
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        console.warn('Stored config is not an object; using defaults instead:', stored);
        return freshDefaults();
    }
    return stored as Config;
}

const localConfig: Config = readStoredConfig();

/** True when `key` names a real setting. Use before writing anything that came
 *  from outside the mod, such as a command payload. */
export function isConfigKey(key: string): key is ConfigKey {
    return Object.hasOwn(defaultConfig, key);
}

export function configRead<K extends ConfigKey>(key: K): Config[K] {
    // A stored null counts as missing. No entry in defaultConfig is nullable, so
    // there is no legitimate null to clobber -- but older releases persisted one
    // (launchToOnStartup defaulted to null before it became ''), and repairing
    // only `undefined` handed that back typed as a non-nullable string forever.
    if (localConfig[key] === undefined || localConfig[key] === null) {
        console.warn('Populating key', key, 'with default value', defaultConfig[key]);
        localConfig[key] = defaultValue(key);
    }

    return localConfig[key];
}

export function configWrite<K extends ConfigKey>(key: K, value: Config[K]): void {
    console.info('Setting key', key, 'to', value);
    localConfig[key] = value;
    window.localStorage[CONFIG_KEY] = JSON.stringify(localConfig);
    configChangeEmitter.dispatchEvent(new CustomEvent('configChange', { detail: { key, value } }));
}

export const configChangeEmitter = {
    listeners: {} as Record<string, ConfigChangeListener[]>,
    addEventListener(type: string, callback: ConfigChangeListener) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(callback);
    },
    removeEventListener(type: string, callback: ConfigChangeListener) {
        if (!this.listeners[type]) return;
        this.listeners[type] = this.listeners[type].filter((cb) => cb !== callback);
    },
    dispatchEvent(event: { type: string; detail: ConfigChangeDetail }) {
        const type = event.type;
        if (!this.listeners[type]) return;
        this.listeners[type].forEach((cb) => {
            try {
                cb.call(this, event);
            } catch (_) {}
        });
    },
};
