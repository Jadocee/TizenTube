// Custom UI for video player

import { extractAssignedFunctions } from "../utils/ASTParser.js";
import { configRead } from "../config.js";
import { ButtonRenderer } from "./ytUI.js";
import { t } from 'i18next';

function applyPatches() {
    if (!window._yttv) return setTimeout(applyPatches, 250);
    if (!document.querySelector('video')) return setTimeout(applyPatches, 250);
    const methods = Object.keys(window._yttv).filter(key => {
        return typeof window._yttv[key] === 'function' && window._yttv[key].toString().includes('TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION');
    });

    if (methods.length === 0) {
        setTimeout(applyPatches, 250);
        return;
    }

    const origMethod = window._yttv[methods[0]];
    const origSource = origMethod.toString();
    const isClass = /^class\s/.test(origSource);
    const functions = extractAssignedFunctions(origSource);

    // Each of these reads a name out of the minified component. A miss used to
    // throw straight out of the constructor, which leaves the transport control
    // row unrenderable -- so they are resolved once, up front, and every use is
    // gated on having found something.
    const nameOf = (predicate) => {
        const match = functions.find(predicate);
        return match ? match.left.split('.')[1] : undefined;
    };

    const settingActionGroup = nameOf((func) => func.rhs.includes('TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS'));

    const previousButtonName = nameOf((func) => {
        if (!func.rhs.includes('skipNextButton')) return false;
        return func.rhs.indexOf('skipPreviousButton') > func.rhs.indexOf('skipNextButton');
    });

    const nextButtonName = nameOf((func) => {
        if (!func.rhs.includes('skipPreviousButton')) return false;
        return func.rhs.indexOf('skipNextButton') > func.rhs.indexOf('skipPreviousButton');
    });

    const engagementActionButton = nameOf((func) => func.rhs.includes('props.data.engagementActions'));

    function YtlrPlayerActionsContainer() {
        const args = Array.prototype.slice.call(arguments);

        function constructAsNew(ctor, argsList) {
            if (typeof Reflect !== 'undefined' && typeof Reflect.construct === 'function') {
                return Reflect.construct(ctor, argsList, YtlrPlayerActionsContainer);
            }
            return new origMethod(...argsList);
        }

        if (!(this instanceof YtlrPlayerActionsContainer)) {
            if (isClass) return constructAsNew(origMethod, args);
            return origMethod.apply(this, args);
        }

        let inst;
        if (isClass) {
            inst = constructAsNew(origMethod, args);
        } else {
            origMethod.apply(this, args);
            inst = this;
        }

        // Everything below decorates the instance. If any of it throws on a
        // bundle the patch no longer understands, an unpatched player still
        // beats a transport row that cannot render.
        try {
            const pipCommand = {
                "type": "TRANSPORT_CONTROLS_BUTTON_TYPE_PIP",
                "button": {
                    "buttonRenderer": ButtonRenderer(
                        false,
                        configRead('enableSwapMPWithPIP') ? t('player.pictureInPicture') : t('player.miniPlayer'),
                        'CLEAR_COOKIES',
                        {
                            customAction: {
                                action: configRead('enableSwapMPWithPIP') ? 'ENTER_PIP' : 'ENTER_MP',
                            }
                        }
                    )
                }
            }

            if (settingActionGroup && configRead('enableMPButton')) {
                const origSettingActionGroup = inst[settingActionGroup];
                inst[settingActionGroup] = function () {
                    const res = origSettingActionGroup.apply(this, arguments);
                    const idx = res.findIndex(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS');
                    res.find(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP') || res.splice(idx, 0, pipCommand);
                    return res;
                };
            }

            if (engagementActionButton && configRead('enableSpeedControlsButton')) {
                const origEngagementActionButton = inst[engagementActionButton];
                inst[engagementActionButton] = function () {
                    const res = origEngagementActionButton.apply(this, arguments);
                    res.find(item => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED') || res.push({
                        type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED',
                        button: {
                            buttonRenderer: ButtonRenderer(
                                false,
                                t('player.playbackSpeed.button'),
                                'SLOW_MOTION_VIDEO',
                                {
                                    customAction:
                                    {
                                        action: 'TT_SPEED_SETTINGS_SHOW',
                                    }
                                }
                            )
                        }
                    });
                    return res;
                }
            }

            if (engagementActionButton && !configRead('enableSuperThanksButton')) {
                const origEngagementActionButton = inst[engagementActionButton];
                inst[engagementActionButton] = function () {
                    const res = origEngagementActionButton.apply(this, arguments);
                    const superThanksFiltered = res.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SUPER_THANKS');
                    const shoppingFiltered = superThanksFiltered.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SHOPPING');
                    return shoppingFiltered;
                }
            }
        
            if (engagementActionButton && !configRead('enableAIAskButton')) {
                const origEngagementActionButton = inst[engagementActionButton];
                inst[engagementActionButton] = function () {
                    const res = origEngagementActionButton.apply(this, arguments);
                    const superThanksFiltered = res.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_YOUCHAT_BUTTON');
                    const shoppingFiltered = superThanksFiltered.filter(item => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_YOUCHAT_BUTTON');
                    return shoppingFiltered;
                }
            }

            if (previousButtonName && nextButtonName && configRead('enablePreviousNextButtons')) {
                inst[previousButtonName] = function () {
                    return ButtonRenderer(
                        false,
                        t('player.previous'),
                        'SKIP_PREVIOUS',
                        {
                            signalAction: {
                                signal: 'PLAYER_PLAY_PREVIOUS'
                            }
                        }
                    )
                }

                inst[nextButtonName] = function () {
                    return ButtonRenderer(
                        false,
                        t('player.next'),
                        'SKIP_NEXT',
                        {
                            signalAction: {
                                signal: 'PLAYER_PLAY_NEXT'
                            }
                        }
                    )
                }

            }
        } catch (e) {
            console.warn('TizenTube: could not patch the player controls:', e);
        }

        return inst;
    }

    if (configRead('enablePatchingVideoPlayer')) {
        YtlrPlayerActionsContainer.prototype = origMethod.prototype;
        window._yttv[methods[0]] = YtlrPlayerActionsContainer;
    }
}


if (document.readyState === 'complete' || document.readyState === 'interactive') {
    applyPatches();
} else {
    window.addEventListener('DOMContentLoaded', applyPatches);
}