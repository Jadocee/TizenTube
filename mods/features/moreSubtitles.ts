// TizenTube Subtitle Localization Mod
// Automatically adds user's local language to subtitle auto-translate menu if not present

import { configRead } from '../config.js';
import languages from '../translations/language-names.js';
import type { CompactLinkRenderer } from '../types/youtube';

const LANGUAGE_CODES = [
    'af',
    'sq',
    'am',
    'ar',
    'hy',
    'as',
    'az',
    'eu',
    'be',
    'bn',
    'bs',
    'bg',
    'my',
    'ca',
    'zh-CN',
    'zh-TW',
    'zh-HK',
    'hr',
    'cs',
    'da',
    'nl',
    'en',
    'et',
    'fil',
    'fi',
    'fr',
    'gl',
    'ka',
    'de',
    'el',
    'gu',
    'he',
    'hi',
    'hu',
    'is',
    'id',
    'ga',
    'it',
    'ja',
    'kn',
    'kk',
    'km',
    'ko',
    'ky',
    'lo',
    'lv',
    'lt',
    'mk',
    'ms',
    'ml',
    'mt',
    'mr',
    'mn',
    'ne',
    'no',
    'or',
    'fa',
    'pl',
    'pt',
    'pa',
    'ro',
    'ru',
    'sr',
    'si',
    'sk',
    'sl',
    'es',
    'sw',
    'sv',
    'ta',
    'te',
    'th',
    'tr',
    'uk',
    'ur',
    'uz',
    'vi',
    'cy',
    'yi',
    'yo',
    'zu',
];

// Return an object mapping language code -> localized language name.
export function getComprehensiveLanguageList(): Record<string, string> {
    try {
        const map: Record<string, string> = {};
        LANGUAGE_CODES.forEach((code) => {
            if (code.includes('-')) {
                const [lang, region] = code.split('-');
                const languageName = languages.language.standard.long[lang] || code;
                const regionName = languages.region.long[region] || region;
                map[code] = `${languageName} (${regionName})`;
            } else {
                const name = languages.language.standard.long[code] || code;
                map[code] = name;
            }
        });
        return map;
    } catch (_e) {
        const fallback: Record<string, string> = {};
        LANGUAGE_CODES.forEach((c) => (fallback[c] = c));
        return fallback;
    }
}

// Subtags CLDR answers with that YouTube's menu does not use. Norwegian is the
// one that actually comes up: maximize() says "nb", the menu offers "no".
const LANGUAGE_ALIASES: Record<string, string> = { nb: 'no', nn: 'no' };

// Infer the most likely language for a given ISO 3166-1 alpha-2 country code using Intl.Locale.
// Returns { code, name } or null if unknown.
export function getCountryLanguage(
    countryCode: string | null,
): { code: string; name: string } | null {
    if (!countryCode) return null;
    try {
        const region = String(countryCode).toUpperCase();
        // Named via the comprehensive list rather than languages.language.standard.long:
        // that map is keyed by bare language codes, so a hyphenated code misses
        // it and the menu row ends up titled "zh-CN".
        const names = getComprehensiveLanguageList();

        const zhRegionMap: Record<string, string> = {
            CN: 'zh-CN',
            TW: 'zh-TW',
            HK: 'zh-HK',
            MO: 'zh-HK',
            SG: 'zh-CN',
        };
        if (zhRegionMap[region]) {
            const code = zhRegionMap[region];
            return { code, name: names[code] || code };
        }

        // Intl.Locale is native on the Chromium M120 target and typed by the
        // ES2023 lib. Note this path is LIVE only since that retarget: the old
        // Chrome 47 build had no Intl.Locale, so the constructor always threw
        // and every region outside zhRegionMap fell to the catch below.
        const maximized = new Intl.Locale('und', { region }).maximize();
        const inferred = maximized.language || 'en';
        const lang = LANGUAGE_ALIASES[inferred] || inferred;

        // CLDR happily answers with a language YouTube's auto-translate menu
        // does not offer -- GH gives "ak", TJ "tg", BT "dz", MV "dv". Adding a
        // row for one builds a command asking YouTube to translate into a
        // language it will refuse, so decline instead, which is exactly what
        // the old target did for every region.
        if (!LANGUAGE_CODES.includes(lang)) return null;

        return { code: lang, name: names[lang] || lang };
    } catch (e) {
        console.warn(
            'TizenTube Subtitle Localization: Could not infer language for country',
            countryCode,
            e,
        );
        return null;
    }
}

let isPatched = false;

// Function to get user's country code
function getUserCountryCode(): string | null {
    try {
        // Always use window.yt.config_.GL as primary source
        if (window.yt && window.yt.config_ && (window.yt.config_ as { GL?: string }).GL) {
            return (window.yt.config_ as { GL?: string }).GL!;
        }

        console.warn('TizenTube Subtitle Localization: Could not determine user country code');
        return null;
    } catch (error) {
        console.error('TizenTube Subtitle Localization: Error getting country code:', error);
        return null;
    }
}

// Function to check if language already exists in the menu
function languageExistsInMenu(items: any[], languageCode: string, languageName: string): boolean {
    return items.some((item) => {
        if (item.compactLinkRenderer && item.compactLinkRenderer.serviceEndpoint) {
            const commands =
                item.compactLinkRenderer.serviceEndpoint.commandExecutorCommand?.commands;
            if (commands && commands[0] && commands[0].selectSubtitlesTrackCommand) {
                const translationLang = commands[0].selectSubtitlesTrackCommand.translationLanguage;
                return (
                    translationLang &&
                    (translationLang.languageCode === languageCode ||
                        translationLang.languageName === languageName)
                );
            }
        }
        return false;
    });
}

// Function to create a language option
function createLanguageOption(languageCode: string, languageName: string): CompactLinkRenderer {
    return {
        compactLinkRenderer: {
            title: { simpleText: languageName },
            serviceEndpoint: {
                commandExecutorCommand: {
                    commands: [
                        {
                            selectSubtitlesTrackCommand: {
                                translationLanguage: {
                                    languageCode,
                                    languageName,
                                },
                            },
                        },
                        {
                            openClientOverlayAction: {
                                type: 'CLIENT_OVERLAY_TYPE_CAPTIONS_LANGUAGE',
                                updateAction: true,
                            },
                        },
                        {
                            signalAction: { signal: 'POPUP_BACK' },
                        },
                    ],
                },
            },
            secondaryIcon: { iconType: 'RADIO_BUTTON_UNCHECKED' },
        },
    };
}

// Function to get languages already present in menu
function getExistingLanguages(items: any[]): Set<string> {
    const existingLanguages = new Set<string>();

    items.forEach((item) => {
        if (item.compactLinkRenderer && item.compactLinkRenderer.serviceEndpoint) {
            const commands =
                item.compactLinkRenderer.serviceEndpoint.commandExecutorCommand?.commands;
            if (commands && commands[0] && commands[0].selectSubtitlesTrackCommand) {
                const translationLang = commands[0].selectSubtitlesTrackCommand.translationLanguage;
                if (translationLang) {
                    existingLanguages.add(translationLang.languageCode);
                    existingLanguages.add(translationLang.languageName);
                }
            }
        }
    });

    return existingLanguages;
}

// Function to create section title
function createSectionTitle(title: string) {
    return {
        overlayMessageRenderer: {
            title: { simpleText: '' },
            subtitle: { simpleText: title },
            style: 'OVERLAY_MESSAGE_STYLE_SUBSECTION_TITLE',
        },
    };
}

// Attempts spent waiting for the resolveCommand instance to register. The two
// exits above this one re-arm themselves; this one used to give up silently.
let instanceAttempts = 0;

// Main function to patch the subtitle menu
function patchSubtitleMenu() {
    if (isPatched) return;

    const player = document.querySelector('.html5-video-player');
    if (!player) return setTimeout(patchSubtitleMenu, 250);

    // Always patch if possible - settings will be checked dynamically
    if (!window._yttv) return setTimeout(patchSubtitleMenu, 250);
    const yttvInstance = Object.values(window._yttv).find(
        (obj) => obj && obj.instance && typeof obj.instance.resolveCommand === 'function',
    );

    if (!yttvInstance) {
        // _yttv fills in progressively, so a miss here means "not yet". The
        // bootstrap interval clears itself as soon as it has called this once,
        // so without re-arming, losing this race meant the subtitle menu was
        // never patched at all. Capped at roughly thirty seconds.
        if (++instanceAttempts <= 120) return setTimeout(patchSubtitleMenu, 250);
        console.error('TizenTube Subtitle Localization: Could not find resolveCommand instance.');
        return;
    }

    if (yttvInstance.instance.resolveCommand.isPatchedBySubtitleLocalization) {
        console.log('TizenTube Subtitle Localization: Already patched.');
        return;
    }

    const originalResolveCommand = yttvInstance.instance.resolveCommand;

    yttvInstance.instance.resolveCommand = function (this: any, cmd: any, _?: any): any {
        // Identify the correct command using its uniqueId
        if (cmd?.openPopupAction?.uniqueId === 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE') {
            // Check current settings dynamically each time menu opens
            const showUserLanguage = configRead('enableShowUserLanguage');
            const showOtherLanguages = configRead('enableShowOtherLanguages');

            // If neither feature is enabled, don't modify the menu
            if (!showUserLanguage && !showOtherLanguages) {
                return originalResolveCommand.apply(this, arguments);
            }

            const items =
                cmd.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer
                    .actionPanel.overlayPanelRenderer.content.overlayPanelItemListRenderer.items;

            // Get existing languages
            const existingLanguages = getExistingLanguages(items);

            // Add user's local language if enabled
            if (showUserLanguage) {
                const userCountryCode = getUserCountryCode();
                const userLanguage = getCountryLanguage(userCountryCode);

                if (userLanguage) {
                    // Check if the user's language already exists
                    if (!languageExistsInMenu(items, userLanguage.code, userLanguage.name)) {
                        console.log(
                            `%c[TizenTube Subtitle Localization] Adding user's local language: ${userLanguage.name} (${userLanguage.code})`,
                            'background: #2196F3; color: #ffffff; font-size: 14px; font-weight: bold;',
                        );

                        const userLanguageOption = createLanguageOption(
                            userLanguage.code,
                            userLanguage.name,
                        );

                        // Insert under the menu's first section heading. This
                        // used to match the heading text against the English
                        // literals "Recommended languages" / "Other languages",
                        // but YouTube renders those in the account's language --
                        // so for exactly the non-English users this feature
                        // exists for, both searches missed and the row was
                        // unshifted above YouTube's own heading. Anchor on the
                        // renderer instead, which is language independent.
                        const headerIndex = items.findIndex(
                            (item: any) => item.overlayMessageRenderer,
                        );

                        if (headerIndex > -1) {
                            items.splice(headerIndex + 1, 0, userLanguageOption);
                        } else {
                            // A flat list with no headings at all: first is right.
                            items.unshift(userLanguageOption);
                        }
                        // Update existing languages set
                        existingLanguages.add(userLanguage.code);
                        existingLanguages.add(userLanguage.name);
                    } else {
                        console.log(
                            `%c[TizenTube Subtitle Localization] User's language ${userLanguage.name} already exists in menu`,
                            'background: #4CAF50; color: #ffffff; font-size: 12px;',
                        );
                    }
                } else {
                    console.warn(
                        `TizenTube Subtitle Localization: No language mapping found for country code: ${userCountryCode}`,
                    );
                }
            }

            // Create "Tizen Languages" section with all missing languages if enabled
            if (showOtherLanguages) {
                const missingLanguages = Object.entries(getComprehensiveLanguageList())
                    .filter(
                        ([code, name]) =>
                            !existingLanguages.has(code) && !existingLanguages.has(name),
                    )
                    .sort(([, a], [, b]) => a.localeCompare(b));

                if (missingLanguages.length > 0) {
                    console.log(
                        `%c[TizenTube Subtitle Localization] Adding "Tizen Languages" section with ${missingLanguages.length} additional languages`,
                        'background: #FF9800; color: #ffffff; font-size: 12px;',
                    );

                    // Add section title
                    items.push(createSectionTitle('Other Languages'));

                    // Add all missing languages
                    missingLanguages.forEach(([code, name]) => {
                        items.push(createLanguageOption(code, name));
                    });

                    console.log(
                        `%c[TizenTube Subtitle Localization] Added "Tizen Languages" section`,
                        'background: #FF9800; color: #ffffff; font-size: 12px;',
                    );
                } else {
                    console.log(
                        `%c[TizenTube Subtitle Localization] All languages already present in menu`,
                        'background: #4CAF50; color: #ffffff; font-size: 12px;',
                    );
                }
            }
        }

        // Let the original function run with our modified 'cmd' object
        return originalResolveCommand.apply(this, arguments);
    };

    yttvInstance.instance.resolveCommand.isPatchedBySubtitleLocalization = true;
    console.log('TizenTube Subtitle Localization: Patch successful!');
    isPatched = true;
}

// Wait for the YouTube TV app to be ready
const interval = setInterval(() => {
    if (window._yttv && Object.keys(window._yttv).length > 0) {
        patchSubtitleMenu();
        clearInterval(interval);
    }
}, 1000);

// Also try to patch when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchSubtitleMenu);
} else {
    patchSubtitleMenu();
}

console.log('TizenTube Subtitle Localization: Module loaded, waiting for YouTube TV...');
