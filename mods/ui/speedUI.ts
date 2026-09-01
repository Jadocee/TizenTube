import { configRead } from '../config.js';
import { showModal, buttonItem, overlayPanelItemListRenderer } from './ytUI.js';
import { t } from 'i18next';
import type { CompactLinkRenderer } from '../types/youtube';

const interval = setInterval(() => {
    const videoElement = document.querySelector('video');
    if (videoElement) {
        execute_once_dom_loaded_speed();
        clearInterval(interval);
    }
}, 1000);

function execute_once_dom_loaded_speed(): void {
    document.querySelector('video')!.addEventListener('canplay', () => {
        document.getElementsByTagName('video')[0].playbackRate = configRead('videoSpeed');
    });

    const eventHandler = (evt: KeyboardEvent) => {
        if (evt.keyCode === 406 || evt.keyCode === 191) {
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.type === 'keydown') {
                // The theme panel is a plain overlay rather than a YouTube popup,
                // so opening a popup underneath it would strand it on screen with
                // focus gone from it for good. Read the state off the DOM: a flag
                // would desync the moment the panel closed by any other route.
                const themePanel = document.querySelector<HTMLElement>('.ytaf-ui-container');
                if (themePanel && themePanel.style.display !== 'none') {
                    themePanel.style.display = 'none';
                    themePanel.blur();
                }
                speedSettings();
                return false;
            }
            return true;
        }
    };

    // Colour keys. Blue opens the speed menu; Red and Green are handled in ui.js.
    // Yellow is deliberately unbound.
    // Red 403 | Green 404 or 172 | Yellow 405 or 170 | Blue 406 or 191
    document.addEventListener('keydown', eventHandler, true);
    document.addEventListener('keypress', eventHandler, true);
    document.addEventListener('keyup', eventHandler, true);
}

function speedSettings(): void {
    const currentSpeed = configRead('videoSpeed');
    let selectedIndex = 0;
    const maxSpeed = 5;
    const increment = configRead('speedSettingsIncrement') || 0.25;
    const buttons: CompactLinkRenderer[] = [];
    // Driven by an integer counter: adding `increment` repeatedly accumulates
    // float error into the bound test, which dropped the 5x row at an increment
    // of 0.2. floor, not round -- round would add rows above maxSpeed at 0.3
    // and 0.4.
    const steps = Math.floor(maxSpeed / increment);
    for (let i = 1; i <= steps; i++) {
        const fixedSpeed = Math.round(i * increment * 100) / 100;
        buttons.push(
            buttonItem({ title: `${fixedSpeed}x` }, null, [
                {
                    signalAction: {
                        signal: 'POPUP_BACK',
                    },
                },
                {
                    setClientSettingEndpoint: {
                        settingDatas: [
                            {
                                clientSettingEnum: {
                                    item: 'videoSpeed',
                                },
                                intValue: fixedSpeed.toString(),
                            },
                        ],
                    },
                },
                {
                    customAction: {
                        action: 'SET_PLAYER_SPEED',
                        parameters: fixedSpeed.toString(),
                    },
                },
            ]),
        );
        if (currentSpeed === fixedSpeed) {
            selectedIndex = buttons.length - 1;
        }
    }

    buttons.push(
        buttonItem({ title: t('player.playbackSpeed.fixStuttering') }, null, [
            {
                signalAction: {
                    signal: 'POPUP_BACK',
                },
            },
            {
                setClientSettingEndpoint: {
                    settingDatas: [
                        {
                            clientSettingEnum: {
                                item: 'videoSpeed',
                            },
                            intValue: '1.0001',
                        },
                    ],
                },
            },
            {
                customAction: {
                    action: 'SET_PLAYER_SPEED',
                    parameters: '1.0001',
                },
            },
        ]),
    );

    // The stuttering row writes 1.0001, a value the increment loop can never
    // produce, so the loop's own check could never select it and the menu always
    // reopened on the first entry after using it.
    if (currentSpeed === 1.0001) selectedIndex = buttons.length - 1;

    showModal(
        t('player.playbackSpeed.title'),
        overlayPanelItemListRenderer(buttons, selectedIndex),
        'tt-speed',
    );
}

export { speedSettings };
