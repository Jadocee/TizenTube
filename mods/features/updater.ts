// TizenTube Cobalt Update Checker

import { buttonItem, showModal, showToast, overlayPanelItemListRenderer, scrollPaneRenderer, overlayMessageRenderer } from '../ui/ytUI.js';
import { configRead } from '../config.js';
import { t } from 'i18next';
import type { Renderer } from '../types/youtube';

/** The slice of a GitHub release the updater reads. */
interface GitHubReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface GitHubRelease {
    tag_name: string;
    published_at: string;
    body: string;
    assets: GitHubReleaseAsset[];
}

// If TizenTube is not running on Cobalt, do nothing
// Add a timeout since reloading the home page while the updater pop up is shown causes the pop up to instantly disappear.
setTimeout(() => {
    if (window.h5vcc && window.h5vcc.tizentube && configRead('enableUpdater')) {
        const currentEpoch = Math.floor(Date.now() / 1000);
        if (configRead('dontCheckUpdateUntil') > currentEpoch) {
            console.info('Skipping update check until', new Date(configRead('dontCheckUpdateUntil') * 1000).toLocaleString());
        } else checkForUpdates();
    }
}, 2500);

function getLatestRelease(): Promise<GitHubRelease> {
    return fetch('https://api.github.com/repos/reisxd/TizenTubeCobalt/releases/latest')
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        });
}

// 'Check for updates' shows nothing while it runs, so a user who thinks the row
// is dead presses OK again. Each completion pushed a NEW modal rather than
// matching the live one, and a user-initiated modal opens focused on
// 'Update Now' -- so the second press could land on starting an APK download.
let checkInFlight = false;

function checkForUpdates(isUserInitiated?: boolean): void {
    if (checkInFlight) return;
    checkInFlight = true;
    const currentAppVersion = window.h5vcc!.tizentube!.GetVersion();
    const currentEpoch = Math.floor(Date.now() / 1000);

    getLatestRelease()
        .then(release => {
            const latestVersion = release.tag_name.replace('v', '');
            const releaseDate = new Date(release.published_at).getTime() / 1000;

            let architecture: string | undefined;
            let downloadUrl: string;

            if (window.h5vcc!.tizentube!.GetArchitecture) {
                architecture = window.h5vcc!.tizentube!.GetArchitecture!();
            }

            // These were three non-null assertions on lookups the GitHub API
            // does not guarantee: find() returns undefined when a release has no
            // matching APK, and assets[0] assumes the release has any asset at
            // all. The resulting TypeError was swallowed by the catch below, so
            // a user-initiated check just looked like nothing happened.
            const wanted = architecture ? (architecture === 'arm64-v8a' ? 'arm64.apk' : 'arm.apk') : null;
            const asset = wanted ? release.assets.find(a => a.name.includes(wanted)) : release.assets[0];
            if (!asset) {
                console.warn('No matching release asset', release.tag_name, architecture, release.assets.map(a => a.name));
                if (isUserInitiated) {
                    showToast(t('settings.options.updater.checkFailed.title'), t('settings.options.updater.checkFailed.subtitle'), null);
                }
                return;
            }
            downloadUrl = asset.browser_download_url;

            if (latestVersion !== currentAppVersion) {
                console.info(`New version available: ${latestVersion} (current: ${currentAppVersion})`);
                const msg = `${t('settings.options.updater.releaseDate', { date: new Date(releaseDate * 1000).toLocaleString() })}\n${release.body}`.replace(/#/g, '').replace(/\*/g, '').trim();

                const buttons: Renderer[] = [
                    buttonItem(
                        { title: t('settings.options.updater.updateNow.title'), subtitle: t('settings.options.updater.updateNow.subtitle') },
                        { icon: 'DOWN_ARROW' },
                        [
                            {
                                customAction: {
                                    action: 'UPDATE_DOWNLOAD',
                                    parameters: downloadUrl
                                }
                            },
                            {
                                signalAction: {
                                    signal: 'POPUP_BACK'
                                }
                            }
                        ]
                    ),
                    buttonItem(
                        { title: t('settings.options.updater.remindLater.title'), subtitle: t('settings.options.updater.remindLater.subtitle') },
                        { icon: 'SEARCH_HISTORY' },
                        [
                            {
                                customAction: {
                                    action: 'UPDATE_REMIND_LATER',
                                    parameters: currentEpoch + 86400
                                }
                            },
                            {
                                signalAction: {
                                    signal: 'POPUP_BACK'
                                }
                            }
                        ]
                    )
                ];

                // Add an empty message so the CSS doesn't get screwed after user input
                buttons.push(overlayMessageRenderer(' '));
                buttons.push(overlayMessageRenderer(msg));

                showModal(
                    {
                        title: t('settings.options.updater.updateAvailable.title'),
                        subtitle: t('settings.options.updater.updateAvailable.subtitle', { latestVersion, currentVersion: currentAppVersion })
                    },
                    // An unasked-for modal must not open with "Update Now" under the
                    // cursor: on a TV, OK is the button most likely to be pressed by
                    // reflex, and it starts an APK download.
                    overlayPanelItemListRenderer(buttons, isUserInitiated ? 0 : 1),
                    'tt-update-modal',
                    false
                )
            } else {
                console.info('You are using the latest version of TizenTube.');
                if (isUserInitiated) {
                    showToast(t('settings.options.updater.upToDate.title'), t('settings.options.updater.upToDate.subtitle', { version: currentAppVersion }), null);
                }
            }
        })
        .catch(error => {
            console.error('Error fetching the latest release:', error);
            // Only worth interrupting for when the user asked; otherwise every
            // launch without a network shows an error nobody requested.
            if (isUserInitiated) {
                showToast(t('settings.options.updater.checkFailed.title'), t('settings.options.updater.checkFailed.subtitle'), null);
            }
        })
        .finally(() => {
            checkInFlight = false;
        });
}

export default checkForUpdates;