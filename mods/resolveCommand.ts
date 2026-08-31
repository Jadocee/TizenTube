import { configWrite, configRead, isConfigKey } from './config.js';
import { enablePip } from './features/pictureInPicture.js';
import modernUI, { optionShow } from './ui/settings.js';
import { speedSettings } from './ui/speedUI.js';
import { showToast, buttonItem } from './ui/ytUI.js';
import { addEntry, parseEntry } from './features/tileMenu.js';
import { noteCommand } from './features/commandCounter.js';
import checkForUpdates from './features/updater.js';
import { t } from 'i18next';
import type { Command, SettingData } from './types/youtube';

/** A `settingDatas` entry as it arrives from YouTube. The value sits under
 *  whichever `*Value` key the payload happened to use, so it is read by name
 *  rather than by a declared property. */
interface SettingDataPayload extends SettingData {
    [key: string]: any;
}

/** The legacy key fields the TV app's own handlers read off a synthesised
 *  keydown. Neither is on `Event` in lib.dom. */
interface LegacyKeyEvent extends Event {
    keyCode: number;
    which: number;
}

export default function resolveCommand(cmd: Command, _?: any): any {
    // resolveCommand function is pretty OP, it can do from opening modals, changing client settings and way more.
    // Because the client might change, we should find it first.

    for (const key in window._yttv) {
        if (window._yttv[key] && window._yttv[key].instance && window._yttv[key].instance.resolveCommand) {
            return window._yttv[key].instance.resolveCommand(cmd, _);
        }
    }
}

export function findFunction(funcName: string): any {
    for (const key in window._yttv) {
        if (window._yttv[key] && window._yttv[key][funcName] && typeof window._yttv[key][funcName] === 'function') {
            return window._yttv[key][funcName];
        }
    }
}

// Patch resolveCommand to be able to change TizenTube settings

export function patchResolveCommand(): void {
    for (const key in window._yttv) {
        if (window._yttv[key] && window._yttv[key].instance && window._yttv[key].instance.resolveCommand) {

            const ogResolve = window._yttv[key].instance.resolveCommand;
            window._yttv[key].instance.resolveCommand = function (this: any, cmd: Command, _?: any): any {
                // First statement, before any branch that returns early: the
                // sidebar refresh works by noticing that a press dispatched
                // NOTHING, so the counter has to move for every command the app
                // routes, whatever this wrapper then decides to do with it. The
                // guide dispatches through this same object -- its `this.ka` is
                // `_.ck()`, which returns `window._yttv.Bx.instance` -- so a real
                // navigation is always visible here.
                noteCommand();
                if (cmd.setClientSettingEndpoint) {
                    // Command to change client settings. Use TizenTube configuration to change settings.
                    // One pass. There used to be an inner loop over the same
                    // array, so with N entries in one command every entry was
                    // applied N times -- an arrayValue toggle applied twice is a
                    // no-op, which is how this stayed invisible.
                    for (const setting of cmd.setClientSettingEndpoint.settingDatas as SettingDataPayload[]) {
                        if (!setting.clientSettingEnum.item.includes('_')) {
                            const valName = Object.keys(setting).find(key => key.includes('Value'));
                            const value = valName === 'intValue' ? Number(setting[valName]) : setting[valName!];
                            // The item comes straight out of the command payload, so it is
                            // only a setting name if it actually names one.
                            const item = setting.clientSettingEnum.item;
                            if (!isConfigKey(item)) continue;
                            if (valName === 'arrayValue') {
                                const arr = configRead(item);
                                if (Array.isArray(arr)) {
                                    if (arr.includes(value)) {
                                        arr.splice(arr.indexOf(value), 1);
                                    } else {
                                        arr.push(value);
                                    }
                                    configWrite(item, arr);
                                }
                            } else configWrite(item, value);
                        } else if (setting.clientSettingEnum.item === 'I18N_LANGUAGE') {
                            const lang = setting.stringValue;
                            const date = new Date();
                            date.setFullYear(date.getFullYear() + 10);
                            document.cookie = `PREF=hl=${lang}; expires=${date.toUTCString()};`;
                            resolveCommand({
                                signalAction: {
                                    signal: 'RELOAD_PAGE'
                                }
                            });
                            return true;
                        }
                    }
                } else if (cmd.customAction) {
                    customAction(cmd.customAction.action, cmd.customAction.parameters);
                    return true;
                } else if (cmd?.signalAction?.customAction) {
                    customAction(cmd.signalAction.customAction.action, cmd.signalAction.customAction.parameters);
                    return true;
                } else if (cmd?.showEngagementPanelEndpoint?.customAction) {
                    customAction(cmd.showEngagementPanelEndpoint.customAction.action, cmd.showEngagementPanelEndpoint.customAction.parameters);
                    return true;
                } else if (cmd?.playlistEditEndpoint?.customAction) {
                    customAction(cmd.playlistEditEndpoint.customAction.action, cmd.playlistEditEndpoint.customAction.parameters);
                    return true;
                } else if (cmd?.openPopupAction?.uniqueId === 'playback-settings') {
                    // Patch the playback settings popup to use TizenTube speed settings
                    const items = cmd.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel.overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
                    for (const item of items) {
                        if (item?.compactLinkRenderer?.icon?.iconType === 'SLOW_MOTION_VIDEO') {
                            item.compactLinkRenderer.subtitle && (item.compactLinkRenderer.subtitle.simpleText = t('player.withTizenTube'));
                            item.compactLinkRenderer.serviceEndpoint = {
                                clickTrackingParams: "null",
                                signalAction: {
                                    customAction: {
                                        action: 'TT_SPEED_SETTINGS_SHOW',
                                        parameters: []
                                    }
                                }
                            };
                        }
                    }

                    // Guarded like every other renderer insert in the mod
                    // (customUI.ts does the same before its PiP and speed rows).
                    // Nothing here guarantees YouTube hands back a fresh endpoint
                    // object, and these splice into it in place.
                    const settingsItems = cmd.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel.overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
                    const hasAction = (action: string) => settingsItems.some((item: any) =>
                        item?.compactLinkRenderer?.serviceEndpoint?.commandExecutorCommand?.commands?.some(
                            (c: any) => c?.customAction?.action === action));

                    if (!hasAction('ENTER_MP')) {
                        settingsItems.splice(2, 0,
                            buttonItem(
                                { title: t('player.miniPlayer') },
                                { icon: 'CLEAR_COOKIES' }, [
                                {
                                    customAction: {
                                        action: 'ENTER_MP'
                                    }
                                }
                            ])
                        );
                    }

                    if (window.h5vcc && window.h5vcc.tizentube && window.h5vcc.tizentube.HasSystemFeature &&
                        window.h5vcc.tizentube.HasSystemFeature('android.software.picture_in_picture') &&
                        !hasAction('ENTER_PIP')) {
                        // Placed after the mini-player row wherever that ended up,
                        // rather than at a hardcoded index that assumed it went in.
                        settingsItems.splice(settingsItems.findIndex((item: any) =>
                            item?.compactLinkRenderer?.serviceEndpoint?.commandExecutorCommand?.commands?.some(
                                (c: any) => c?.customAction?.action === 'ENTER_MP')) + 1, 0,
                            buttonItem(
                                { title: t('player.pictureInPicture') },
                                { icon: 'TV' }, [
                                {
                                    customAction: {
                                        action: 'ENTER_PIP'
                                    }
                                },
                                {
                                    signalAction: {
                                         signal: 'POPUP_BACK'
                                    }
                                }
                            ])
                        );
                    }
                } else if (cmd?.watchEndpoint?.videoId) {
                    window.isPipPlaying = false;
                    // Guarded like the analogous lookup in ui.ts. A throw here
                    // stopped the watch command from ever reaching ogResolve, so
                    // the video would not open at all.
                    document.querySelector<HTMLElement>('ytlr-player-container')?.style.removeProperty('z-index');
                }

                // ogResolve, not the registry slot -- that slot is this very
                // wrapper, so the old call recursed into itself.
                if (cmd.customAction) return ogResolve.call(this, cmd, _);

                if (cmd.commandExecutorCommand && cmd.commandExecutorCommand.commands) {
                    for (const command of cmd.commandExecutorCommand.commands) {
                        if (command.customAction) {
                            customAction(command.customAction.action, command.customAction.parameters);
                        } else if (command.signalAction?.customAction) {
                            customAction(command.signalAction.customAction.action, command.signalAction.customAction.parameters);
                        } else if (command.showEngagementPanelEndpoint?.customAction) {
                            customAction(command.showEngagementPanelEndpoint.customAction.action, command.showEngagementPanelEndpoint.customAction.parameters);
                        } else if (command.playlistEditEndpoint?.customAction) {
                            customAction(command.playlistEditEndpoint.customAction.action, command.playlistEditEndpoint.customAction.parameters);
                        } else {
                            ogResolve.call(this, command, _);
                        }
                    }
                    return true;
                }

                if (cmd?.requestAccountSelectorCommand
                    && cmd.requestAccountSelectorCommand?.identityActionContext?.eventTrigger === 'ACCOUNT_EVENT_TRIGGER_ON_EXIT') {
                    if (!configRead('enableWhosWatchingMenuOnAppExit')) {
                        ogResolve.call(this, {
                            signalAction: {
                                signal: 'EXIT_APP'
                            }
                        });
                        return false;
                    }
                }

                return ogResolve.call(this, cmd, _);
            }
        }
    }
}

/**
 * Removes the tile the user just acted on.
 *
 * `removeItemAction.childId` is the tile's contentId: the app builds its menu
 * with the tile's contentId as the child key, so that is what identifies the row
 * to remove. Wrapped because it is cosmetic -- the tile is gone from the next
 * fetch either way -- and a throw here would lose the toast that confirms the
 * choice was recorded.
 */
function dismissTile(videoId: string): void {
    try {
        resolveCommand({ removeItemAction: { childId: videoId } });
    } catch (e) {
        console.warn('[TizenTube] could not dismiss the tile', e);
    }
}

function customAction(action: string, parameters?: any): void {
    switch (action) {
        case 'SETTINGS_UPDATE':
            modernUI(true, parameters);
            break;
        case 'OPTIONS_SHOW':
            optionShow(parameters, parameters.update);
            break;
        case 'SKIP':
            const kE = document.createEvent('Event') as LegacyKeyEvent;
            kE.initEvent('keydown', true, true);
            kE.keyCode = 27;
            kE.which = 27;
            document.dispatchEvent(kE);

            document.querySelector('video')!.currentTime = parameters.time;
            break;
        case 'TT_SETTINGS_SHOW':
            modernUI();
            break;
        case 'TT_SPEED_SETTINGS_SHOW':
            speedSettings();
            break;
        case 'UPDATE_REMIND_LATER':
            configWrite('dontCheckUpdateUntil', parameters);
            break;
        case 'UPDATE_DOWNLOAD':
            window.h5vcc!.tizentube!.InstallAppFromURL(parameters);
            showToast(t('settings.options.updater.downloading.title'), t('settings.options.updater.downloading.subtitle'));
            break;
        case 'SET_PLAYER_SPEED':
            const speed = Number(parameters);
            document.querySelector('video')!.playbackRate = speed;
            break;
        case 'ENTER_MP':
            enablePip();
            break;
        case 'ENTER_PIP':
            window.h5vcc!.tizentube!.EnterPIP();
            break;
        case 'SHOW_TOAST':
            showToast('TizenTube 9', parameters);
            break;
        case 'ADD_TO_QUEUE': {
            // videoQueuing advances by findIndex on contentId, which always
            // finds the FIRST match -- so the same video queued twice trapped
            // playback in a loop between the two copies. Position is inferred
            // from identity, so identity has to be unique.
            const contentId = parameters?.tileRenderer?.contentId;
            if (!contentId || !window.queuedVideos.videos.some(v => v.tileRenderer?.contentId === contentId)) {
                window.queuedVideos.videos.push(parameters);
            }
            showToast('TizenTube 9', t('toasts.videoAddedToQueue'));
            break;
        }
        case 'CLEAR_QUEUE':
            window.queuedVideos.videos = [];
            // Cleared with the queue: a surviving id from the previous queue
            // resolves against the new one and silently skips or destroys it.
            window.queuedVideos.lastVideoId = null;
            showToast('TizenTube 9', t('toasts.videoQueueCleared'));
            break;
        case 'CHECK_FOR_UPDATES':
            checkForUpdates(true);
            break;
        case 'TT_HIDE_VIDEO': {
            // Validated because these arrive inside a payload the app hands back
            // to us; a malformed one must be inert rather than writing junk into
            // the stored list.
            const videoId = parameters?.videoId;
            if (typeof videoId !== 'string' || !videoId) break;
            const label = typeof parameters?.title === 'string' && parameters.title ? parameters.title : videoId;
            configWrite('hiddenVideos', addEntry(configRead('hiddenVideos'), `${videoId} ${label}`));
            // The app contributes only CLOSE_POPUP for a customAction endpoint --
            // its native removeItemAction is reserved for real playlist edits --
            // so without this the tile stays on screen and the press is
            // indistinguishable at ten feet from having done nothing.
            dismissTile(videoId);
            showToast('TizenTube 9', t('toasts.videoHidden'));
            break;
        }
        case 'TT_HIDE_CHANNEL': {
            const entry = parameters?.entry;
            if (typeof entry !== 'string' || !entry) break;
            configWrite('hiddenChannels', addEntry(configRead('hiddenChannels'), entry));
            if (typeof parameters?.videoId === 'string') dismissTile(parameters.videoId);
            // The channel's OTHER tiles are already on screen and this filter
            // runs on the payload, not the DOM -- so without a refetch a
            // channel-wide action produces a one-tile effect.
            resolveCommand({ signalAction: { signal: 'SOFT_RELOAD_PAGE' } });
            showToast('TizenTube 9', t('toasts.channelHidden', { channel: parseEntry(entry).name }));
            break;
        }
    }
}
