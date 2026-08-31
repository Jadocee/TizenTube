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
  enableFixedUI: (window.h5vcc && window.h5vcc.tizentube) ? false : true,
  enableHqThumbnails: false,
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

let localConfig: Config;

try {
  localConfig = JSON.parse(window.localStorage[CONFIG_KEY]);
} catch (err) {
  console.warn('Config read failed:', err);
  localConfig = defaultConfig;
}

/** True when `key` names a real setting. Use before writing anything that came
 *  from outside the mod, such as a command payload. */
export function isConfigKey(key: string): key is ConfigKey {
  return Object.prototype.hasOwnProperty.call(defaultConfig, key);
}

export function configRead<K extends ConfigKey>(key: K): Config[K] {
  // A stored null counts as missing. No entry in defaultConfig is nullable, so
  // there is no legitimate null to clobber -- but older releases persisted one
  // (launchToOnStartup defaulted to null before it became ''), and repairing
  // only `undefined` handed that back typed as a non-nullable string forever.
  if (localConfig[key] === undefined || localConfig[key] === null) {
    console.warn('Populating key', key, 'with default value', defaultConfig[key]);
    localConfig[key] = defaultConfig[key];
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
    this.listeners[type] = this.listeners[type].filter(cb => cb !== callback);
  },
  dispatchEvent(event: { type: string; detail: ConfigChangeDetail }) {
    const type = event.type;
    if (!this.listeners[type]) return;
    this.listeners[type].forEach(cb => {
      try {
        cb.call(this, event)
      } catch (_) {};
    });
  }
};
