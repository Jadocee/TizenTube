import { configRead } from '../config.js';
import { showModal, buttonItem, overlayPanelItemListRenderer } from './ytUI.js';
import { t } from 'i18next';

const interval = setInterval(() => {
    const videoElement = document.querySelector('video');
    if (videoElement) {
        execute_once_dom_loaded_speed();
        clearInterval(interval);
    }
}, 1000);

function execute_once_dom_loaded_speed() {
    document.querySelector('video').addEventListener('canplay', () => {
        document.getElementsByTagName('video')[0].playbackRate = configRead('videoSpeed');;
    });

    const eventHandler = (evt) => {
        if (evt.keyCode == 406 || evt.keyCode == 191) {
            evt.preventDefault();
            evt.stopPropagation();
            if (evt.type === 'keydown') {
                // The theme panel is a plain overlay rather than a YouTube popup,
                // so opening a popup underneath it would strand it on screen with
                // focus gone from it for good. Read the state off the DOM: a flag
                // would desync the moment the panel closed by any other route.
                const themePanel = document.querySelector('.ytaf-ui-container');
                if (themePanel && themePanel.style.display !== 'none') {
                    themePanel.style.display = 'none';
                    themePanel.blur();
                }
                speedSettings();
                return false;
            }
            return true;
        };
    }

    // Colour keys. Blue opens the speed menu; Red and Green are handled in ui.js.
    // Yellow is deliberately unbound.
    // Red 403 | Green 404 or 172 | Yellow 405 or 170 | Blue 406 or 191
    document.addEventListener('keydown', eventHandler, true);
    document.addEventListener('keypress', eventHandler, true);
    document.addEventListener('keyup', eventHandler, true);
}

function speedSettings() {
    const currentSpeed = configRead('videoSpeed');
    let selectedIndex = 0;
    const maxSpeed = 5;
    const increment = configRead('speedSettingsIncrement') || 0.25;
    const buttons = [];
    for (let speed = increment; speed <= maxSpeed; speed += increment) {
        const fixedSpeed = Math.round(speed * 100) / 100;
        buttons.push(
            buttonItem(
                { title: `${fixedSpeed}x` },
                null,
                [
                    {
                        signalAction: {
                            signal: 'POPUP_BACK'
                        }
                    },
                    {
                        setClientSettingEndpoint: {
                            settingDatas: [
                                {
                                    clientSettingEnum: {
                                        item: 'videoSpeed'
                                    },
                                    intValue: fixedSpeed.toString()
                                }
                            ]
                        }
                    },
                    {
                        customAction: {
                            action: 'SET_PLAYER_SPEED',
                            parameters: fixedSpeed.toString()
                        }
                    }
                ]
            )
        );
        if (currentSpeed === fixedSpeed) {
            selectedIndex = buttons.length - 1;
        }
    }

    buttons.push(
        buttonItem(
            { title: t('player.playbackSpeed.fixStuttering') },
            null,
            [
                {
                    signalAction: {
                        signal: 'POPUP_BACK'
                    }
                },
                {
                    setClientSettingEndpoint: {
                        settingDatas: [
                            {
                                clientSettingEnum: {
                                    item: 'videoSpeed'
                                },
                                intValue: '1.0001'
                            }
                        ]
                    }
                },
                {
                    customAction: {
                        action: 'SET_PLAYER_SPEED',
                        parameters: '1.0001'
                    }
                }
            ]
        )
    );

    showModal(t('player.playbackSpeed.title'), overlayPanelItemListRenderer(buttons, selectedIndex), 'tt-speed');
}

export {
    speedSettings
}