// Custom UI for video player

import { extractAssignedFunctions } from '../utils/ASTParser.js';
import { configRead } from '../config.js';
import { ButtonRenderer } from './ytUI.js';
import { t } from 'i18next';
import type { AssignedFunction } from '../utils/ASTParser.js';

// Passes spent waiting for the transport-controls component to register.
let scanAttempts = 0;

function applyPatches() {
    if (!window._yttv) return setTimeout(applyPatches, 250);
    if (!document.querySelector('video')) return setTimeout(applyPatches, 250);
    const methods = Object.keys(window._yttv).filter((key) => {
        return (
            typeof window._yttv![key] === 'function' &&
            window._yttv![key].toString().includes('TRANSPORT_CONTROLS_BUTTON_TYPE_FEATURED_ACTION')
        );
    });

    if (methods.length === 0) {
        // _yttv fills in progressively, so a miss means 'not yet' -- but this
        // scan stringifies every function in the registry, so back off rather
        // than paying that four times a second for the life of the page. Never
        // gives up: the user may sit on the home screen for minutes before
        // opening a video, and abandoning would cost them the player patches.
        scanAttempts++;
        setTimeout(applyPatches, scanAttempts > 40 ? 2000 : 250);
        return;
    }

    const origMethod = window._yttv[methods[0]];
    const origSource = origMethod.toString();
    // \b not \s: a minified anonymous class stringifies as `class{constructor…}`
    // with no space, so \s missed it, the ES5 path called a real class without
    // `new`, and YouTube's constructor threw.
    const isClass = /^class\b/.test(origSource);
    // Guarded even though the parser now returns [] rather than throwing: this
    // runs inside a setTimeout chain, so an escape here would kill every player
    // patch for the life of the page with nothing to retry it.
    let functions: AssignedFunction[] = [];
    try {
        functions = extractAssignedFunctions(origSource);
    } catch (e) {
        console.warn('TizenTube: could not parse the player component', e);
    }

    // Each of these reads a name out of the minified component. A miss used to
    // throw straight out of the constructor, which leaves the transport control
    // row unrenderable -- so they are resolved once, up front, and every use is
    // gated on having found something.
    const nameOf = (predicate: (func: AssignedFunction) => boolean) => {
        const match = functions.find(predicate);
        return match ? match.left!.split('.')[1] : undefined;
    };

    const settingActionGroup = nameOf((func) =>
        func.rhs.includes('TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS'),
    );

    const previousButtonName = nameOf((func) => {
        if (!func.rhs.includes('skipNextButton')) return false;
        return func.rhs.indexOf('skipPreviousButton') > func.rhs.indexOf('skipNextButton');
    });

    const nextButtonName = nameOf((func) => {
        if (!func.rhs.includes('skipPreviousButton')) return false;
        return func.rhs.indexOf('skipNextButton') > func.rhs.indexOf('skipPreviousButton');
    });

    const engagementActionButton = nameOf((func) =>
        func.rhs.includes('props.data.engagementActions'),
    );

    // Resolving nothing at all means the component's shape changed, not that
    // this particular build has no settings row. Worth a line, because the
    // failure is otherwise completely silent: every patch below simply no-ops.
    if (!settingActionGroup && !engagementActionButton) {
        console.warn(
            'TizenTube: no player-control members resolved; the transport component shape has changed',
        );
    }

    function YtlrPlayerActionsContainer(this: any) {
        const args = Array.prototype.slice.call(arguments);

        function constructAsNew(ctor: any, argsList: any[]) {
            // Reflect.construct is Chrome 49, so on the old target this test was
            // always false and the `new origMethod(...)` fallback was the only
            // arm anyone ran. On M120 it is always true and that arm is dead.
            return Reflect.construct(ctor, argsList, YtlrPlayerActionsContainer);
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
                type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP',
                button: {
                    buttonRenderer: ButtonRenderer(
                        false,
                        configRead('enableSwapMPWithPIP')
                            ? t('player.pictureInPicture')
                            : t('player.miniPlayer'),
                        'CLEAR_COOKIES',
                        {
                            customAction: {
                                action: configRead('enableSwapMPWithPIP')
                                    ? 'ENTER_PIP'
                                    : 'ENTER_MP',
                            },
                        },
                    ),
                },
            };

            if (settingActionGroup && configRead('enableMPButton')) {
                const origSettingActionGroup = inst[settingActionGroup];
                inst[settingActionGroup] = function (this: any) {
                    const res = origSettingActionGroup.apply(this, arguments);
                    const idx = res.findIndex(
                        (item: any) =>
                            item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PLAYBACK_SETTINGS',
                    );
                    // splice() reads a negative start as an offset from the end, so
                    // a missing settings button put the PiP button second-to-last
                    // instead of appending it.
                    if (
                        !res.some((item: any) => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_PIP')
                    ) {
                        res.splice(idx === -1 ? res.length : idx, 0, pipCommand);
                    }
                    return res;
                };
            }

            if (engagementActionButton && configRead('enableSpeedControlsButton')) {
                const origEngagementActionButton = inst[engagementActionButton];
                inst[engagementActionButton] = function (this: any) {
                    const res = origEngagementActionButton.apply(this, arguments);
                    res.find((item: any) => item.type === 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED') ||
                        res.push({
                            type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPEED',
                            button: {
                                buttonRenderer: ButtonRenderer(
                                    false,
                                    t('player.playbackSpeed.button'),
                                    'SLOW_MOTION_VIDEO',
                                    {
                                        customAction: {
                                            action: 'TT_SPEED_SETTINGS_SHOW',
                                        },
                                    },
                                ),
                            },
                        });
                    return res;
                };
            }

            if (engagementActionButton && !configRead('enableSuperThanksButton')) {
                const origEngagementActionButton = inst[engagementActionButton];
                inst[engagementActionButton] = function (this: any) {
                    const res = origEngagementActionButton.apply(this, arguments);
                    const superThanksFiltered = res.filter(
                        (item: any) => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SUPER_THANKS',
                    );
                    const shoppingFiltered = superThanksFiltered.filter(
                        (item: any) => item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_SHOPPING',
                    );
                    return shoppingFiltered;
                };
            }

            if (engagementActionButton && !configRead('enableAIAskButton')) {
                const origEngagementActionButton = inst[engagementActionButton];
                inst[engagementActionButton] = function (this: any) {
                    const res = origEngagementActionButton.apply(this, arguments);
                    // One pass. The second filter tested the same literal as the
                    // first, so nothing could match it and it only allocated a
                    // copy. Whatever second button type was meant here was never
                    // named, so it is not guessed at.
                    return res.filter(
                        (item: any) =>
                            item.type !== 'TRANSPORT_CONTROLS_BUTTON_TYPE_YOUCHAT_BUTTON',
                    );
                };
            }

            if (previousButtonName && nextButtonName && configRead('enablePreviousNextButtons')) {
                inst[previousButtonName] = () =>
                    ButtonRenderer(false, t('player.previous'), 'SKIP_PREVIOUS', {
                        signalAction: {
                            signal: 'PLAYER_PLAY_PREVIOUS',
                        },
                    });

                inst[nextButtonName] = () =>
                    ButtonRenderer(false, t('player.next'), 'SKIP_NEXT', {
                        signalAction: {
                            signal: 'PLAYER_PLAY_NEXT',
                        },
                    });
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
