import { configRead } from '../config.js';
import { showModal, buttonItem, overlayPanelItemListRenderer, scrollPaneRenderer, overlayMessageRenderer, QrCodeRenderer } from './ytUI.js';
import qrcode from 'qrcode-npm';
import { t } from 'i18next';
import { readStartupError } from './startupError.js';
import { channelOf, channelEntry, parseChannelEntry } from '../features/videoContext.js';
import type { Config, ConfigKey } from '../config.js';
import type { CompactLinkRenderer, Command, Renderer } from '../types/youtube';

/** A setting that holds a list of values rather than a single one. Those are
 *  edited by toggling members on and off, not by writing the setting whole. */
type ArrayConfigKey = { [K in ConfigKey]: Config[K] extends string[] ? K : never }[ConfigKey];

/** The title and subtitle a submenu opens with. */
interface MenuHeader {
    title: string;
    subtitle: string;
}

/** What a row opens when it shows content rather than a list of rows. */
interface ContentPanel {
    title: string;
    subtitle: string;
    content: Renderer;
}

/** What every row of the settings tree carries. */
interface RowBase {
    name: string;
    icon?: string;
    subtitle?: string;
    menuId?: string;
    menuHeader?: MenuHeader;
}

/** A row that toggles one setting on and off. Its `value` is the setting's
 *  name, so a row pointing at a setting that does not exist will not compile. */
interface ToggleRow extends RowBase {
    value: ConfigKey;
    key?: undefined;
    arrayToEdit?: undefined;
    options?: undefined;
}

/** A row that opens either more rows or a panel of content. */
interface SubmenuRow extends RowBase {
    value: null;
    key?: undefined;
    arrayToEdit?: undefined;
    options: (SettingsEntry | null)[] | ContentPanel;
}

/** One of a set of mutually exclusive choices: selecting it writes `value` to
 *  the setting named by `key`. */
interface ChoiceRow extends RowBase {
    key: ConfigKey;
    value: string | number;
    arrayToEdit?: undefined;
    options?: undefined;
}

/** A row that opens the members of an array setting. */
interface ArrayEditRow extends RowBase {
    value: null;
    key?: undefined;
    arrayToEdit: ArrayConfigKey;
    options: ArrayMemberRow[];
}

/** One member of an array setting. Its `value` is stored in that array, so it
 *  is an arbitrary string rather than the name of a setting. */
interface ArrayMemberRow {
    name: string;
    icon?: string;
    subtitle?: string;
    value: string;
}

type SettingsRow = ToggleRow | SubmenuRow | ChoiceRow | ArrayEditRow;

/** An entry of a rendered menu: one of the mod's rows, or a button built up
 *  front by ytUI. */
type SettingsEntry = SettingsRow | CompactLinkRenderer;

/** Everything a row can open. */
type RowOptions = (SettingsEntry | null)[] | ArrayMemberRow[] | ContentPanel;

interface MenuParametersBase {
    selectedIndex?: number;
    update?: boolean | 'customUI';
    menuId?: string;
    menuHeader?: MenuHeader;
    parent?: OptionsParameters;
}

/** The parameters of a menu that toggles the members of an array setting. */
interface ArrayMenuParameters extends MenuParametersBase {
    arrayToEdit: ArrayConfigKey;
    options: ArrayMemberRow[];
}

/** The parameters of a menu of rows, or of a single panel of content. */
interface RowMenuParameters extends MenuParametersBase {
    arrayToEdit?: undefined;
    options: (SettingsEntry | null)[] | ContentPanel;
}

/** What an OPTIONS_SHOW command hands back to `optionShow`. */
export type OptionsParameters = ArrayMenuParameters | RowMenuParameters;

const qrcodes: Record<string, string> = {};

// TV-friendly presets: every one is dark enough to sit behind white text and to
// keep an OLED panel from driving a full-brightness background for hours.
const THEME_COLORS = [
    { key: 'default', value: '#0f0f0f' },
    { key: 'trueBlack', value: '#000000' },
    { key: 'darkGray', value: '#212121' },
    { key: 'midnightBlue', value: '#101b2d' },
    { key: 'deepPurple', value: '#1a1024' },
    { key: 'darkGreen', value: '#0d1f14' },
    { key: 'darkRed', value: '#2a0f10' }
];

const CLOCK_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * The options of a row that opens a list of mutually exclusive choices, i.e.
 * every entry carries the config key it writes to.
 */
function isChoiceList(options: RowOptions | undefined): options is (SettingsRow | null)[] {
    return Array.isArray(options) && options.some((option) => option && (option as SettingsRow).key !== undefined && (option as SettingsRow).key !== null);
}

/**
 * The label of whichever choice is stored right now, so a row can show its
 * value inline instead of making the user open it to find out.
 */
function currentChoiceLabel(options: RowOptions | undefined): string | undefined {
    if (!isChoiceList(options)) return undefined;
    for (const option of options) {
        if (!option || option.key === undefined || option.key === null) continue;
        if (configRead(option.key) === option.value) return option.name;
    }
    return undefined;
}

/** The same choice's position, so the list opens on it rather than at the top. */
function currentChoiceIndex(options: RowOptions | undefined): number {
    if (!isChoiceList(options)) return 0;
    for (let index = 0; index < options.length; index++) {
        const option = options[index];
        if (!option || option.key === undefined || option.key === null) continue;
        if (configRead(option.key) === option.value) return index;
    }
    return 0;
}

function themeColorOptions(configKey: ConfigKey): ChoiceRow[] {
    return THEME_COLORS.map((color): ChoiceRow => {
        return {
            name: t(`settings.options.uiSettings.options.theme.colors.${color.key}`),
            key: configKey,
            value: color.value
        };
    });
}

/**
 * The channels SponsorBlock is turned off for, plus the one playing now.
 *
 * Built per render rather than declared, because the list is whatever the user
 * has collected. Both jobs are the same toggle: the rows are members of one
 * array setting, so ticking the current channel adds it and unticking a stored
 * one removes it. Nothing here needs a separate "add" action.
 */
function disabledChannelOptions(): ArrayMemberRow[] {
    const stored = configRead('sponsorBlockDisabledChannels');
    const rows: ArrayMemberRow[] = stored.map((entry): ArrayMemberRow => {
        const channel = parseChannelEntry(entry);
        return { name: channel.name, value: entry, icon: 'ACCOUNT_CIRCLE' };
    });

    // The channel on screen, if it is not already in the list. This is the only
    // way to add one: a TV has no text entry worth using, so the current video
    // is the input.
    const playing = channelOf(null);
    if (playing && !stored.some((entry) => parseChannelEntry(entry).id === playing.id)) {
        rows.unshift({
            name: playing.name,
            value: channelEntry(playing),
            subtitle: t('settings.options.sponsorblock.options.channels.nowPlaying'),
            icon: 'ACCOUNT_CIRCLE'
        });
    }

    return rows;
}

export default function modernUI(update?: boolean, parameters?: number[]): void {
    // Only present when this launch's startup threw. Nothing to read means
    // TizenTube started cleanly.
    const startupError = readStartupError();

    // Nothing at the top level writes a radio value, so every row here either
    // toggles a setting or opens a submenu.
    const settings: (ToggleRow | SubmenuRow | null)[] = [
        startupError ? {
            name: t('settings.options.startupError.title'),
            icon: 'INFO',
            value: null,
            menuId: 'tt-startup-error',
            options: {
                title: t('settings.options.startupError.title'),
                subtitle: t('settings.options.startupError.subtitle'),
                content: scrollPaneRenderer([
                    overlayMessageRenderer(t('settings.options.startupError.occurrences', { count: startupError.count })),
                    overlayMessageRenderer(startupError.at),
                    overlayMessageRenderer(startupError.message)
                ])
            }
        } : null,
        {
            name: t('settings.supportTT.title'),
            icon: 'MONEY_HEART',
            value: null,
            menuId: 'tt-support',
            options: {
                title: t('settings.supportTT.title'),
                subtitle: t('settings.supportTT.subtitle'),
                content: scrollPaneRenderer([
                    overlayMessageRenderer(t('settings.supportTT.content.1')),
                    overlayMessageRenderer(t('settings.supportTT.content.2')),
                    overlayMessageRenderer(t('settings.supportTT.content.3'))
                ])
            }
        },
        {
            name: t('settings.options.socialMedia.title'),
            icon: 'PRIVACY_UNLISTED',
            value: null,
            menuId: 'tt-social-media',
            menuHeader: {
                title: t('settings.options.socialMedia.title'),
                subtitle: t('settings.ttSettings.title')
            },
            options: [
                {
                    name: 'GitHub',
                    link: 'https://github.com/Jadocee/TizenTube',
                },
                {
                    name: 'YouTube',
                    link: 'https://www.youtube.com/@tizenbrew',
                },
                {
                    name: 'Discord',
                    link: 'https://discord.gg/m2P7v8Y2qR',
                },
                {
                    name: `Telegram (${t('settings.options.socialMedia.group')})`,
                    link: 'https://t.me/tizentubeofficial',
                },
                {
                    name: t('settings.options.socialMedia.website'),
                    link: 'https://tizentube.6513006.xyz',
                }
            ].map((option): SubmenuRow => {
                if (!qrcodes[option.name]) {
                    const qr = qrcode.qrcode(6, 'H');
                    qr.addData(option.link);
                    qr.make();

                    const qrDataImgTag = qr.createImgTag(8, 8);
                    const qrDataUrl = qrDataImgTag.match(/src="([^"]+)"/)![1];
                    qrcodes[option.name] = qrDataUrl;
                }
                return {
                    name: option.name,
                    icon: 'OPEN_IN_NEW',
                    value: null,
                    menuId: `tt-social-${option.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                    options: {
                        title: option.name,
                        subtitle: option.link,
                        content: overlayPanelItemListRenderer([
                            overlayMessageRenderer(t('settings.options.socialMedia.qrCodeScanMessage', { name: option.name })),
                            QrCodeRenderer(qrcodes[option.name])
                        ])
                    }
                }
            })
        },
        {
            name: t('settings.options.shortcuts.title'),
            icon: 'INFO',
            value: null,
            menuId: 'tt-shortcuts',
            options: {
                title: t('settings.options.shortcuts.title'),
                subtitle: t('settings.options.shortcuts.subtitle'),
                content: scrollPaneRenderer([
                    overlayMessageRenderer(t('settings.options.shortcuts.content.1')),
                    overlayMessageRenderer(t('settings.options.shortcuts.content.2')),
                    overlayMessageRenderer(t('settings.options.shortcuts.content.3')),
                    overlayMessageRenderer(t('settings.options.shortcuts.content.4'))
                ])
            }
        },
        {
            name: t('settings.options.adBlock'),
            icon: 'DOLLAR_SIGN',
            value: 'enableAdBlock'
        },
        {
            name: t('settings.options.sponsorblock.title'),
            icon: 'MONEY_HAND',
            value: null,
            menuId: 'tt-sponsorblock-settings',
            menuHeader: {
                title: t('settings.options.sponsorblock.title'),
                subtitle: 'https://sponsor.ajay.app/'
            },
            options: [
                {
                    name: t('settings.options.sponsorblock.options.enableSB'),
                    icon: 'MONEY_HAND',
                    value: 'enableSponsorBlock'
                },
                {
                    name: t('settings.options.sponsorblock.options.manualSkip'),
                    icon: 'DOLLAR_SIGN',
                    value: null,
                    arrayToEdit: 'sponsorBlockManualSkips',
                    menuId: 'tt-sponsorblock-manual-segment-skip',
                    menuHeader: {
                        title: t('settings.options.sponsorblock.options.manualSkip'),
                        subtitle: t('settings.options.sponsorblock.title')
                    },
                    options: [
                        {
                            name: t('settings.options.sponsorblock.options.categories.sponsor'),
                            icon: 'MONEY_HEART',
                            value: 'sponsor'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.intro'),
                            icon: 'PLAY_CIRCLE',
                            value: 'intro'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.outro'),
                            value: 'outro'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.interaction'),
                            value: 'interaction'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.selfpromo'),
                            value: 'selfpromo'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.preview'),
                            value: 'preview'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.filler'),
                            value: 'filler'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.music_offtopic'),
                            value: 'music_offtopic'
                        }
                    ]
                },
                {
                    name: t('settings.options.sponsorblock.options.segments'),
                    icon: 'SETTINGS',
                    value: null,
                    menuId: 'tt-sponsorblock-segments',
                    menuHeader: {
                        title: t('settings.options.sponsorblock.options.segments'),
                        subtitle: t('settings.options.sponsorblock.title')
                    },
                    options: [
                        {
                            name: t('settings.options.sponsorblock.options.categories.sponsor'),
                            icon: 'MONEY_HEART',
                            value: 'enableSponsorBlockSponsor'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.intro'),
                            icon: 'PLAY_CIRCLE',
                            value: 'enableSponsorBlockIntro'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.outro'),
                            value: 'enableSponsorBlockOutro'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.interaction'),
                            value: 'enableSponsorBlockInteraction'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.selfpromo'),
                            value: 'enableSponsorBlockSelfPromo'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.preview'),
                            value: 'enableSponsorBlockPreview'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.filler'),
                            value: 'enableSponsorBlockFiller'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.music_offtopic'),
                            value: 'enableSponsorBlockMusicOfftopic'
                        },
                        {
                            name: t('settings.options.sponsorblock.options.categories.highlights'),
                            icon: 'LOCATION_POINT',
                            value: 'enableSponsorBlockHighlight'
                        }
                    ]
                },
                {
                    name: t('settings.options.sponsorblock.options.showSBToasts'),
                    value: 'enableSponsorBlockToasts'
                },
                {
                    name: t('settings.options.sponsorblock.options.channels.title'),
                    subtitle: t('settings.options.sponsorblock.options.channels.subtitle'),
                    value: null,
                    arrayToEdit: 'sponsorBlockDisabledChannels',
                    menuId: 'tt-sponsorblock-channels',
                    menuHeader: {
                        title: t('settings.options.sponsorblock.options.channels.title'),
                        subtitle: t('settings.options.sponsorblock.title')
                    },
                    options: disabledChannelOptions()
                }
            ]
        },
        {
            name: t('settings.options.dearrow.title'),
            icon: 'VISIBILITY_OFF',
            value: null,
            menuId: 'tt-dearrow-settings',
            menuHeader: {
                title: t('settings.options.dearrow.title'),
                subtitle: 'https://dearrow.ajay.app/'
            },
            options: [
                {
                    name: t('settings.options.dearrow.options.enableDA'),

                    icon: 'VISIBILITY_OFF',
                    value: 'enableDeArrow'
                },
                {
                    name: t('settings.options.dearrow.options.enableDAThumbnails'),
                    icon: 'TV',
                    value: 'enableDeArrowThumbnails'
                }
            ]
        },
        {
            name: t('settings.options.misc.title'),
            icon: 'SETTINGS',
            value: null,
            menuId: 'tt-misc-settings',
            menuHeader: {
                title: t('settings.options.misc.title'),
                subtitle: t('settings.ttSettings.title')
            },
            options: [
                {
                    name: t('settings.options.misc.options.endScreenCards'),

                    icon: 'VISIBILITY_OFF',
                    value: 'enableHideEndScreenCards'
                },
                {
                    name: t('settings.options.misc.options.youThereRenderer'),
                    icon: 'HELP',
                    value: 'enableYouThereRenderer'
                },
                {
                    name: t('settings.options.misc.options.paidPromoOverlay'),
                    icon: 'MONEY_HAND',
                    value: 'enablePaidPromotionOverlay'
                },
                {
                    name: t('settings.options.misc.options.whosWatching.title'),
                    icon: 'ACCOUNT_CIRCLE',
                    menuId: 'tt-whos-watching-menu-settings',
                    value: null,
                    menuHeader: {
                        title: t('settings.options.misc.options.whosWatching.title'),
                        subtitle: t('settings.options.misc.title')
                    },
                    options: [
                        {
                            name: t('settings.options.misc.options.whosWatching.options.enableWW'),
                            value: 'enableWhoIsWatchingMenu'
                        },
                        {
                            name: t('settings.options.misc.options.whosWatching.options.permaEnableWW'),
                            value: 'permanentlyEnableWhoIsWatchingMenu'
                        },
                        {
                            name: t('settings.options.misc.options.whosWatching.options.enableWWOnExit'),
                            value: 'enableWhosWatchingMenuOnAppExit'
                        }
                    ]
                },
                {
                    name: t('settings.options.misc.options.fixUI'),
                    icon: 'STAR',
                    value: 'enableFixedUI'
                },
                {
                    name: t('settings.options.misc.options.hqThumbnails'),
                    icon: 'VIDEO_QUALITY',
                    value: 'enableHqThumbnails'
                },
                /*{
                    name: 'Chapters',
                    icon: 'BOOKMARK_BORDER',
                    value: 'enableChapters'
                },*/
                {
                    name: t('settings.options.misc.options.longPress'),
                    value: 'enableLongPress'
                },
                {
                    name: t('settings.options.misc.options.shorts'),
                    icon: 'YOUTUBE_SHORTS_FILL_24',
                    value: 'enableShorts'
                },
                {
                    name: t('settings.options.misc.options.videoPreviews'),
                    value: 'enablePreviews'
                },
                {
                    name: t('settings.options.misc.options.previewIndicator'),
                    icon: 'PLAY_ARROW',
                    value: 'enablePreviewIndicator'
                },
                {
                    name: t('settings.options.misc.options.mutePreviews'),
                    value: 'mutePreviews'
                },
                {
                    name: t('settings.options.misc.options.ttWelcomeMsg'),
                    value: 'showWelcomeToast',
                },
                {
                    name: t('settings.options.misc.options.guestSignInReminder'),
                    value: 'enableSigninReminder'
                },
                {
                    name: t('settings.options.misc.options.reloadHomeOnStartup'),
                    value: 'reloadHomeOnStartup'
                }
            ]
        },
        {
            name: t('settings.options.subtitles.title'),
            icon: 'TRANSLATE',
            value: null,
            menuId: 'tt-subtitle-settings',
            menuHeader: {
                title: t('settings.options.subtitles.title'),
                subtitle: t('settings.ttSettings.title')
            },
            options: [
                {
                    name: t('settings.options.subtitles.options.showLocalSubtitle'),
                    value: 'enableShowUserLanguage'
                },
                {
                    name: t('settings.options.subtitles.options.showHiddenSubtitles'),
                    value: 'enableShowOtherLanguages'
                }
            ]
        },
        {
            name: t('settings.options.videoPlayer.title'),
            icon: 'VIDEO_YOUTUBE',
            value: null,
            menuId: 'tt-video-player-settings',
            menuHeader: {
                title: t('settings.options.videoPlayer.title'),
                subtitle: t('settings.options.videoPlayer.subtitle')
            },
            options: [
                {
                    name: t('settings.options.videoPlayer.options.patching.title'),
                    icon: 'SETTINGS',
                    value: null,
                    menuId: 'tt-video-player-ui-patching',
                    menuHeader: {
                        title: t('settings.options.videoPlayer.options.patching.title'),
                        subtitle: t('settings.options.videoPlayer.title')
                    },
                    options: [
                        {
                            name: t('settings.options.videoPlayer.options.patching.options.enableVPUIPatching'),
                            icon: 'SETTINGS',
                            value: 'enablePatchingVideoPlayer'
                        },
                        {
                            name: t('settings.options.videoPlayer.options.patching.options.previousNextBtns'),
                            icon: 'SKIP_NEXT',
                            value: 'enablePreviousNextButtons'
                        },
                        {
                            name: t('settings.options.videoPlayer.options.patching.options.showSuperThxBtn'),
                            icon: 'MONEY_HEART',
                            value: 'enableSuperThanksButton'
                        },
                        {
                            name: t('settings.options.videoPlayer.options.patching.options.showAIAskBtn'),
                            icon: 'SPARK',
                            value: 'enableAIAskButton'
                        },
                        {
                            name: t('settings.options.videoPlayer.options.patching.options.showSpeedCtrlBtn'),
                            icon: 'SLOW_MOTION_VIDEO',
                            value: 'enableSpeedControlsButton'
                        },
                        {
                            name: t('settings.options.videoPlayer.options.patching.options.addMPBtn'),
                            icon: 'CLEAR_COOKIES',
                            value: 'enableMPButton'
                        },
                        {
                            name: t('settings.options.videoPlayer.options.patching.options.swapMPWithPIP'),
                            icon: 'CLEAR_COOKIES',
                            value: 'enableSwapMPWithPIP'
                        }
                    ]
                },
                {
                    name: t('settings.options.videoPlayer.options.preferredVideoQuality.title'),
                    icon: 'VIDEO_QUALITY',
                    value: null,
                    menuId: 'tt-preferred-video-quality',
                    menuHeader: {
                        title: t('settings.options.videoPlayer.options.preferredVideoQuality.title'),
                        subtitle: t('settings.options.videoPlayer.options.preferredVideoQuality.subtitle')
                    },
                    options:
                        ['Auto', '2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'].map((quality): ChoiceRow => {
                            return {
                                name: quality === 'Auto' ? t('settings.options.videoPlayer.options.qualityAuto') : quality,
                                key: 'preferredVideoQuality',
                                value: quality.toLowerCase()
                            }
                        })

                },
                {
                    name: t('settings.options.videoPlayer.options.speedSettings.title'),
                    icon: 'SLOW_MOTION_VIDEO',
                    value: null,
                    menuId: 'tt-speed-settings-increments',
                    menuHeader: {
                        title: t('settings.options.videoPlayer.options.speedSettings.title'),
                        subtitle: t('settings.options.videoPlayer.options.speedSettings.subtitle')
                    },
                    options: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5].map((increment): ChoiceRow => {
                        return {
                            name: `${increment}x`,
                            key: 'speedSettingsIncrement',
                            value: increment
                        }
                    })
                },
                {
                    name: t('settings.options.videoPlayer.options.preferredVideoCodec.title'),
                    icon: 'VIDEO_QUALITY',
                    value: null,
                    menuId: 'tt-preferred-video-codec',
                    menuHeader: {
                        title: t('settings.options.videoPlayer.options.preferredVideoCodec.title'),
                        subtitle: t('settings.options.videoPlayer.options.preferredVideoCodec.subtitle'),
                    },
                    options: ['any', 'vp9', 'av01', 'avc1'].map((codec): ChoiceRow => {
                        return {
                            name: codec === 'any' ? t('settings.options.videoPlayer.options.codecAny') : codec.toUpperCase(),
                            key: 'videoPreferredCodec',
                            value: codec
                        }
                    })
                },
                window.h5vcc && window.h5vcc.tizentube && window.h5vcc.tizentube.SetFrameRate ? {
                    name: t('settings.options.videoPlayer.options.afr'),
                    icon: 'SLOW_MOTION_VIDEO',
                    value: 'autoFrameRate'
                } : null,
                window.h5vcc && window.h5vcc.tizentube && window.h5vcc.tizentube.SetFrameRate ? {
                    name: t('settings.options.videoPlayer.options.afrPauseDuration.title'),
                    icon: 'TIMER',
                    value: null,
                    menuId: 'tt-auto-frame-rate-pause-duration',
                    menuHeader: {
                        title: t('settings.options.videoPlayer.options.afrPauseDuration.title'),
                        subtitle: t('settings.options.videoPlayer.options.afrPauseDuration.subtitle')
                    },
                    options: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((seconds): ChoiceRow => {
                        return {
                            name: t(seconds === 1 ? 'settings.options.time.second' : 'settings.options.time.seconds', { count: seconds }),                            
                            key: 'autoFrameRatePauseVideoFor',
                            value: seconds * 1000
                        }
                    })
                } : null
            ]
        },
        {
            name: t('settings.options.uiSettings.title'),
            icon: 'SETTINGS',
            value: null,
            menuId: 'tt-ui-settings',
            menuHeader: {
                title: t('settings.options.uiSettings.title'),
                subtitle: t('settings.options.uiSettings.subtitle')
            },
            options: [
                {
                    name: t('settings.options.uiSettings.options.hideWatchedVideos.title'),
                    icon: 'VISIBILITY_OFF',
                    value: null,
                    menuId: 'tt-hide-watched-videos-settings',
                    menuHeader: {
                        title: t('settings.options.uiSettings.options.hideWatchedVideos.title'),
                        subtitle: t('settings.options.uiSettings.title')
                    },
                    options: [
                        {
                            name: t('settings.options.uiSettings.options.hideWatchedVideos.options.enableHideWatchedVideos'),
                            icon: 'VISIBILITY_OFF',
                            value: 'enableHideWatchedVideos'
                        },
                        {
                            name: t('settings.options.uiSettings.options.hideWatchedVideos.options.watchedVideosThreshold.title'),
                            value: null,
                            menuId: 'tt-hide-watched-videos-threshold',
                            menuHeader: {
                                title: t('settings.options.uiSettings.options.hideWatchedVideos.options.watchedVideosThreshold.title'),
                                subtitle: t('settings.options.uiSettings.options.hideWatchedVideos.options.watchedVideosThreshold.subtitle')
                            },
                            options: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((percent): ChoiceRow => {
                                return {
                                    name: `${percent}%`,
                                    key: 'hideWatchedVideosThreshold',
                                    value: percent
                                }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.hideWatchedVideos.options.setPagesToHideWatchedVideos'),
                            value: null,
                            arrayToEdit: 'hideWatchedVideosPages',
                            menuId: 'tt-hide-watched-videos-pages',
                            menuHeader: {
                                title: t('settings.options.uiSettings.options.hideWatchedVideos.options.setPagesToHideWatchedVideos'),
                                subtitle: t('settings.options.uiSettings.options.hideWatchedVideos.title')
                            },
                            options: [
                                {
                                    name: t('settings.options.uiSettings.options.categories.searchResults'),
                                    value: 'search'
                                },
                                {
                                    name: t('settings.options.uiSettings.options.categories.home'),
                                    value: 'home'
                                },
                                {
                                    name: t('settings.options.uiSettings.options.categories.music'),
                                    value: 'music'
                                },
                                {
                                    name: t('settings.options.uiSettings.options.categories.gaming'),
                                    value: 'gaming'
                                },
                                {
                                    name: t('settings.options.uiSettings.options.categories.subscriptions'),
                                    value: 'subscriptions'
                                },
                                {
                                    name: t('settings.options.uiSettings.options.categories.library'),
                                    value: 'library'
                                },
                                {
                                    name: t('settings.options.uiSettings.options.categories.more'),
                                    value: 'more'
                                }
                            ]
                        }
                    ]
                },
                {
                    name: t('settings.options.uiSettings.options.screenDimming.title'),
                    icon: 'EYE_OFF',
                    value: null,
                    menuId: 'tt-screen-dimming-settings',
                    menuHeader: {
                        title: t('settings.options.uiSettings.options.screenDimming.title'),
                        subtitle: t('settings.options.uiSettings.title')
                    },
                    options: [
                        {
                            name: t('settings.options.uiSettings.options.screenDimming.options.enableScreenDimming'),
                            icon: 'EYE_OFF',
                            value: 'enableScreenDimming'
                        },
                        {
                            name: t('settings.options.uiSettings.options.screenDimming.options.dimmingTimeout.title'),
                            icon: 'TIMER',
                            value: null,
                            menuId: 'tt-dimming-timeout',
                            menuHeader: {
                                title: t('settings.options.uiSettings.options.screenDimming.options.dimmingTimeout.title'),
                                subtitle: t('settings.options.uiSettings.options.screenDimming.options.dimmingTimeout.subtitle')
                            },
                            options: [10, 20, 30, 60, 120, 180, 240, 300].map((seconds): ChoiceRow => {
                                const title = seconds >= 60 ? t(`settings.options.time.minute${seconds / 60 > 1 ? 's' : ''}`, { count: seconds / 60 }) : t('settings.options.time.seconds', { count: seconds });
                                return {
                                    name: title,
                                    key: 'dimmingTimeout',
                                    value: seconds
                                }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.screenDimming.options.dimmingOpacity.title'),
                            icon: 'LENS_BLUE',
                            value: null,
                            menuId: 'tt-dimming-opacity',
                            menuHeader: {
                                title: t('settings.options.uiSettings.options.screenDimming.options.dimmingOpacity.title'),
                                subtitle: t('settings.options.uiSettings.options.screenDimming.options.dimmingOpacity.subtitle')
                            },
                            options: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map((opacity): ChoiceRow => {
                                return {
                                    name: `${Math.round(opacity * 100)}%`,
                                    key: 'dimmingOpacity',
                                    value: opacity
                                }
                            })
                        }
                    ]
                },
                {
                    name: t('settings.options.uiSettings.options.disableSidebarContents.title'),
                    icon: 'MENU',
                    value: null,
                    arrayToEdit: 'disabledSidebarContents',
                    menuId: 'tt-sidebar-contents',
                    menuHeader: {
                        title: t('settings.options.uiSettings.options.disableSidebarContents.title'),
                        subtitle: t('settings.options.uiSettings.options.disableSidebarContents.subtitle')
                    },
                    options: [
                        {
                            name: t('settings.options.uiSettings.options.categories.search'),
                            icon: 'SEARCH',
                            value: 'SEARCH'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.home'),
                            icon: 'WHAT_TO_WATCH',
                            value: 'WHAT_TO_WATCH'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.sports'),
                            icon: 'TROPHY',
                            value: 'TROPHY'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.news'),
                            icon: 'NEWS',
                            value: 'NEWS'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.music'),
                            icon: 'YOUTUBE_MUSIC',
                            value: 'YOUTUBE_MUSIC'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.podcasts'),
                            icon: 'BROADCAST',
                            value: 'BROADCAST'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.moviesAndTv'),
                            icon: 'CLAPPERBOARD',
                            value: 'CLAPPERBOARD'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.live'),
                            icon: 'LIVE',
                            value: 'LIVE'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.gaming'),
                            icon: 'GAMING',
                            value: 'GAMING'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.subscriptions'),
                            icon: 'SUBSCRIPTIONS',
                            value: 'SUBSCRIPTIONS'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.library'),
                            icon: 'TAB_LIBRARY',
                            value: 'TAB_LIBRARY'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.more'),
                            icon: 'TAB_MORE',
                            value: 'TAB_MORE'
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.shorts'),
                            icon: 'YOUTUBE_SHORTS_FILL_24',
                            value: 'YOUTUBE_SHORTS_FILL_24'
                        }
                    ]
                },
                {
                    name: t('settings.options.uiSettings.options.launchToOnStartup.title'),
                    icon: 'TV',
                    value: null,
                    menuId: 'tt-launch-to-on-startup',
                    menuHeader: {
                        title: t('settings.options.uiSettings.options.launchToOnStartup.title'),
                        subtitle: t('settings.options.uiSettings.options.launchToOnStartup.subtitle')
                    },
                    options: [
                        {
                            name: t('settings.options.uiSettings.options.launchToOnStartup.none'),
                            key: 'launchToOnStartup',
                            // Empty rather than null: a null value routes a row into the
                            // submenu branch instead of writing the setting.
                            value: ''
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.search'),
                            icon: 'SEARCH',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                searchEndpoint: { query: '' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.home'),
                            icon: 'WHAT_TO_WATCH',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.sports'),
                            icon: 'TROPHY',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_sports' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.news'),
                            icon: 'NEWS',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_news' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.music'),
                            icon: 'YOUTUBE_MUSIC',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_music' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.podcasts'),
                            icon: 'BROADCAST',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_podcasts' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.moviesAndTv'),
                            icon: 'CLAPPERBOARD',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_movies' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.gaming'),
                            icon: 'GAMING',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_gaming' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.live'),
                            icon: 'LIVE',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_live' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.subscriptions'),
                            icon: 'SUBSCRIPTIONS',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEsubscriptions' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.library'),
                            icon: 'TAB_LIBRARY',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FElibrary' }
                            })
                        },
                        {
                            name: t('settings.options.uiSettings.options.categories.more'),
                            icon: 'TAB_MORE',
                            key: 'launchToOnStartup',
                            value: JSON.stringify({
                                browseEndpoint: { browseId: 'FEtopics_more' }
                            })
                        }
                    ]
                },
                {
                    name: t('settings.options.uiSettings.options.sortSubscriptionsByAlphabet'),
                    icon: 'SUBSCRIPTIONS',
                    value: 'sortSubscriptionsByAlphabet'
                },
                {
                    name: t('settings.options.uiSettings.options.disableChannelsOnSidebar'),
                    value: 'disableChannelsOnSidebar'
                },
                {
                    name: t('settings.options.uiSettings.options.theme.title'),
                    value: null,
                    icon: 'LENS_BLUE',
                    menuId: 'tt-theme-settings',
                    menuHeader: {
                        title: t('settings.options.uiSettings.options.theme.title'),
                        subtitle: t('settings.options.uiSettings.options.theme.subtitle')
                    },
                    options: [
                        {
                            name: t('settings.options.uiSettings.options.theme.barColor'),
                            icon: 'LENS_BLUE',
                            value: null,
                            menuId: 'tt-theme-bar-color',
                            menuHeader: {
                                title: t('settings.options.uiSettings.options.theme.barColor'),
                                subtitle: t('settings.options.uiSettings.options.theme.subtitle')
                            },
                            options: themeColorOptions('focusContainerColor')
                        },
                        {
                            name: t('settings.options.uiSettings.options.theme.routeColor'),
                            icon: 'LENS_BLUE',
                            value: null,
                            menuId: 'tt-theme-route-color',
                            menuHeader: {
                                title: t('settings.options.uiSettings.options.theme.routeColor'),
                                subtitle: t('settings.options.uiSettings.options.theme.subtitle')
                            },
                            options: themeColorOptions('routeColor')
                        }
                    ]
                },
                {
                    name: t('settings.options.uiSettings.options.clock.title'),
                    value: null,
                    icon: 'TIMER',
                    menuId: 'tt-clock-settings',
                    menuHeader: {
                        title: t('settings.options.uiSettings.options.clock.title'),
                        subtitle: t('settings.options.uiSettings.options.clock.subtitle')
                    },
                    options: [
                        {
                            name: t('settings.options.uiSettings.options.clock.options.enableClock'),
                            icon: 'TIMER',
                            value: 'enableClock'
                        },
                        {
                            name: t('settings.options.uiSettings.options.clock.options.isClock12HourFormat'),
                            icon: 'TIMER',
                            value: 'isClock12HourFormat'
                        },
                        {
                            name: t('settings.options.uiSettings.options.clock.options.clockShowSeconds'),
                            icon: 'TIMER',
                            value: 'clockShowSeconds'
                        },
                        {
                            name: t('settings.options.uiSettings.options.clock.options.clockPosition.title'),
                            icon: 'TIMER',
                            value: null,
                            menuId: 'tt-clock-position',
                            menuHeader: {
                                title: t('settings.options.uiSettings.options.clock.options.clockPosition.title'),
                                subtitle: t('settings.options.uiSettings.options.clock.options.clockPosition.subtitle')
                            },
                            options: CLOCK_POSITIONS.map((position): ChoiceRow => {
                                return {
                                    name: t(`settings.options.uiSettings.options.clock.options.clockPosition.options.${position}`),
                                    key: 'clockPosition',
                                    value: position
                                };
                            })
                        }
                    ]
                }
            ]
        },
        window.h5vcc && window.h5vcc.tizentube ?
            {
                name: t('settings.options.updater.title'),
                icon: 'SYSTEM_UPDATE',
                value: null,
                menuId: 'tt-updater-settings',
                menuHeader: {
                    title: t('settings.options.updater.title'),
                    subtitle: t('settings.options.updater.menuSubtitle')
                },
                subtitle:  t('settings.options.updater.versionSubtitle', { version: window.h5vcc.tizentube.GetVersion() }),
                options: [
                    buttonItem(
                        { title: t('settings.options.updater.options.checkForUpdates') },
                        { icon: 'SYSTEM_UPDATE' },
                        [
                            {
                                customAction: {
                                    action: 'CHECK_FOR_UPDATES',
                                }
                            }
                        ]
                    ),
                    {
                        name: t('settings.options.updater.options.checkForUpdatesOnStartup'),
                        icon: 'SYSTEM_UPDATE',
                        value: 'enableUpdater'
                    }
                ]
            } : null
    ];

    const buttons: CompactLinkRenderer[] = [];

    let index = 0;
    for (const setting of settings) {
        if (!setting) continue;
        const currentVal = setting.value ? configRead(setting.value) : null;
        buttons.push(
            buttonItem(
                { title: setting.name, subtitle: setting.subtitle || currentChoiceLabel(setting.options) },
                {
                    icon: setting.icon ? setting.icon : 'CHEVRON_DOWN',
                    secondaryIcon:
                        currentVal === null ? 'CHEVRON_RIGHT' : currentVal ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK'
                },
                currentVal !== null
                    ? [
                        {
                            setClientSettingEndpoint: {
                                settingDatas: [
                                    {
                                        clientSettingEnum: {
                                            item: setting.value!
                                        },
                                        boolValue: !configRead(setting.value!)
                                    }
                                ]
                            }
                        },
                        {
                            customAction: {
                                action: 'SETTINGS_UPDATE',
                                parameters: [index]
                            }
                        }
                    ]
                    : [
                        {
                            customAction: {
                                action: 'OPTIONS_SHOW',
                                parameters: {
                                    options: setting.options,
                                    selectedIndex: currentChoiceIndex(setting.options),
                                    update: (setting.options as ContentPanel | undefined)?.title ? 'customUI' : false,
                                    menuId: setting.menuId,
                                    arrayToEdit: setting.arrayToEdit,
                                    menuHeader: setting.menuHeader
                                }
                            }
                        }
                    ]
            )
        );
        index++;
    }

    showModal(
        {
            title: t('settings.ttSettings.title'),
            subtitle: t('settings.ttSettings.madeByText')
        },
        overlayPanelItemListRenderer(buttons, parameters && parameters.length > 0 ? parameters[0] : 0),
        'tt-settings',
        update
    );
}

export function optionShow(parameters: OptionsParameters, update?: boolean | 'customUI'): void {
    if (update === 'customUI') {
        const option = parameters.options as ContentPanel;
        showModal(
            {
                title: option.title,
                subtitle: option.subtitle
            },
            option.content,
            parameters.menuId || 'tt-settings-support',
            false
        );
        return;
    }
    const buttons: CompactLinkRenderer[] = [];

    // Check if this is the legacy sponsorBlockManualSkips (array-based) or new boolean-based options
    const isArrayBasedOptions = parameters.arrayToEdit !== undefined;

    if (isArrayBasedOptions) {
        // Legacy handling for sponsorBlockManualSkips
        const value = configRead(parameters.arrayToEdit);
        for (const option of parameters.options) {
            buttons.push(
                buttonItem(
                    { title: option.name, subtitle: option.subtitle },
                    {
                        icon: option.icon ? option.icon : 'CHEVRON_DOWN',
                        secondaryIcon: value.includes(option.value) ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK'
                    },
                    [
                        {
                            setClientSettingEndpoint: {
                                settingDatas: [
                                    {
                                        clientSettingEnum: {
                                            item: parameters.arrayToEdit
                                        },
                                        arrayValue: option.value
                                    }
                                ]
                            }
                        },
                        {
                            customAction: {
                                action: 'OPTIONS_SHOW',
                                parameters: {
                                    options: parameters.options,
                                    selectedIndex: parameters.options.indexOf(option),
                                    update: true,
                                    menuId: parameters.menuId,
                                    arrayToEdit: parameters.arrayToEdit,
                                    menuHeader: parameters.menuHeader
                                }
                            }
                        }
                    ]
                )
            );
        }
    } else {
        // New handling for boolean-based options (like subtitle localization)
        let index = 0;
        for (const option of parameters.options as (SettingsEntry | null)[]) {
            if (!option) continue;
            if ('compactLinkRenderer' in option) {
                buttons.push(option);
                index++;
                continue;
            }
            const isRadioChoice = option.key !== null && option.key !== undefined;
            const currentVal = option.value === null ? undefined : configRead(isRadioChoice ? option.key : option.value);
            buttons.push(
                buttonItem(
                    { title: option.name, subtitle: option.subtitle || currentChoiceLabel(option.options) },
                    {
                        icon: option.icon ? option.icon : 'CHEVRON_DOWN',
                        secondaryIcon: isRadioChoice ? currentVal === option.value ? 'RADIO_BUTTON_CHECKED' : 'RADIO_BUTTON_UNCHECKED' : option.value === null ? 'CHEVRON_RIGHT' : currentVal ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK'
                    },
                    option.value === null ? [
                        {
                            customAction: {
                                action: 'OPTIONS_SHOW',
                                parameters: {
                                    options: option.options,
                                    selectedIndex: currentChoiceIndex(option.options),
                                    update: (option.options as ContentPanel | undefined)?.title ? 'customUI' : false,
                                    menuId: option.menuId,
                                    arrayToEdit: option.arrayToEdit,
                                    menuHeader: option.menuHeader,
                                    // Lets a choice made in that menu redraw this row, which
                                    // shows the chosen value as its subtitle.
                                    parent: {
                                        options: parameters.options,
                                        selectedIndex: index,
                                        update: true,
                                        menuId: parameters.menuId,
                                        arrayToEdit: parameters.arrayToEdit,
                                        menuHeader: parameters.menuHeader
                                    }
                                }
                            }
                        }
                    ] : option.key !== null && option.key !== undefined ? ([
                        {
                            setClientSettingEndpoint: {
                                settingDatas: [
                                    {
                                        clientSettingEnum: {
                                            item: option.key
                                        },
                                        stringValue: option.value
                                    }
                                ]
                            }
                        },
                        parameters.parent
                            ? {
                                signalAction: {
                                    signal: 'POPUP_BACK'
                                }
                            }
                            : {
                                customAction: {
                                    action: 'OPTIONS_SHOW',
                                    parameters: {
                                        options: parameters.options,
                                        selectedIndex: index,
                                        update: (parameters.options as ContentPanel | undefined)?.title ? 'customUI' : true,
                                        menuId: parameters.menuId,
                                        arrayToEdit: parameters.arrayToEdit,
                                        menuHeader: parameters.menuHeader
                                    }
                                }
                            },
                        parameters.parent
                            ? {
                                customAction: {
                                    action: 'OPTIONS_SHOW',
                                    parameters: parameters.parent
                                }
                            }
                            : null
                    ] satisfies (Command | null)[]).filter(Boolean) as Command[] : [
                        {
                            setClientSettingEndpoint: {
                                settingDatas: [
                                    {
                                        clientSettingEnum: {
                                            item: option.value
                                        },
                                        boolValue: !currentVal
                                    }
                                ]
                            }
                        },
                        {
                            customAction: {
                                action: 'OPTIONS_SHOW',
                                parameters: {
                                    options: parameters.options,
                                    selectedIndex: index,
                                    update: (parameters.options as ContentPanel | undefined)?.title ? 'customUI' : true,
                                    menuId: parameters.menuId,
                                    arrayToEdit: parameters.arrayToEdit,
                                    menuHeader: parameters.menuHeader
                                }
                            }
                        }
                    ]
                )
            );
            index++;
        }
    }

    showModal(parameters.menuHeader ? parameters.menuHeader : t('settings.ttSettings.title'), overlayPanelItemListRenderer(buttons, parameters.selectedIndex), parameters.menuId || 'tt-settings-options', update);
}
