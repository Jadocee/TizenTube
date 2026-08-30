// Picture in Picture Mode for TizenTube

import resolveCommand from "../resolveCommand.js";
import { whenBodyReady } from "../utils/domReady.js";

window.isPipPlaying = false;
let PlayerService: any = null;

let pipLoadAttempts = 0;

function pipLoad(): void {
    // Everything in here is wrapped, because of where this runs from. When the
    // document is already loaded -- which is how TizenBrew injects, and how the
    // standalone app's fallback path injects -- the call below happens at MODULE
    // SCOPE, and a throw at module scope aborts every module imported after this
    // one. This is the ninth of thirty-nine, so the casualties would include ad
    // blocking, SponsorBlock, the stylesheet and the settings panel: an app that
    // launches and looks fine while most of the mod is simply absent.
    //
    // Picture-in-picture failing to hook is worth a warning. It is not worth
    // taking the rest of the mod with it.
    try {
        // window._yttv is published by YouTube's own bundle. Every other feature
        // in the mod retries for it; this one assumed it was already there,
        // which threw "Cannot convert undefined or null to object".
        const mappings = window._yttv && Object.values(window._yttv).find(a => a && a.mappings);
        // Having a `mappings` property does not make an entry the registry:
        // `get` was called unguarded, so any other object carrying that property
        // name threw "mappings.get is not a function" from here.
        if (!mappings || typeof mappings.get !== 'function') {
            if (++pipLoadAttempts <= 240) setTimeout(pipLoad, 250);
            return;
        }

        PlayerService = mappings.get('PlayerService');
        const PlaybackPreviewService = mappings.get('PlaybackPreviewService');
        if (!PlaybackPreviewService) return;
        const PlaybackPreviewServiceStart = PlaybackPreviewService.start;
        const PlaybackPreviewServiceStop = PlaybackPreviewService.stop;

        PlaybackPreviewService.start = function (this: any, ...args: any[]) {
            if (window.isPipPlaying) return;
            return PlaybackPreviewServiceStart.apply(this, args);
        }

        PlaybackPreviewService.stop = function (this: any, ...args: any[]) {
            if (window.isPipPlaying) return;
            return PlaybackPreviewServiceStop.apply(this, args);
        }
    } catch (err) {
        console.warn('[TizenTube] Picture-in-Picture could not hook the player:', err);
    }
}

if (document.readyState === 'complete') {
    pipLoad();
} else window.addEventListener('load', pipLoad);

// The observer armed by the last enablePip(), so a second press supersedes the
// first instead of leaving a stale one armed. A stale observer still holds the
// timestamp and playback config of the earlier video, and would reload the wrong
// video at the wrong position when its class mutation finally arrived.
let pipObserver: MutationObserver | null = null;

function enablePip(): void {
    if (!PlayerService) return;
    pipObserver?.disconnect();
    const timestamp = Math.floor(document.querySelector('video')!.currentTime);
    const videoElement = document.querySelector('video')!;

    const ytlrPlayer = document.querySelector<HTMLElement>('ytlr-player')!;
    const ytlrPlayerContainer = document.querySelector<HTMLElement>('ytlr-player-container')!;

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === 'class') {
                if (!ytlrPlayer.classList.contains('ytLrPlayerEnabled')) {
                    function setStyles() {
                        ytlrPlayerContainer.style.zIndex = '10';
                        ytlrPlayer.style.display = 'block';
                        ytlrPlayer.style.backgroundColor = 'rgba(0,0,0,0)';
                    }

                    setStyles();
                    setTimeout(setStyles, 500);

                    function onPipEnter() {
                        videoElement.style.removeProperty('inset');
                        const pipWidth = window.innerWidth / 3.5;
                        const pipHeight = window.innerHeight / 3.5;
                        videoElement.style.width = `${pipWidth}px`;
                        videoElement.style.height = `${pipHeight}px`;
                        videoElement.style.top = '68vh';
                        videoElement.style.left = '68vw';

                        window.isPipPlaying = true;
                        videoElement.removeEventListener('play', onPipEnter);
                    }

                    videoElement.addEventListener('play', onPipEnter);
                    observer.disconnect();
                    pipObserver = null;

                    setTimeout(() => {
                        PlayerService.loadedPlaybackConfig.watchEndpoint.startTimeSeconds = timestamp;
                        PlayerService.loadVideo(PlayerService.loadedPlaybackConfig);
                    }, 1000);
                }
            }
        });
    });

    pipObserver = observer;
    observer.observe(ytlrPlayer, { attributes: true });

    // Exit from the current video player
    resolveCommand({
        signalAction: {
            signal: "HISTORY_BACK"
        }
    });
}

function pipToFullscreen(): void {
    const { clickTrackingParams, commandMetadata, watchEndpoint } = PlayerService.loadedPlaybackConfig;
    watchEndpoint.startTimeSeconds = Math.floor(document.querySelector('video')!.currentTime);
    const command = {
        clickTrackingParams,
        commandMetadata,
        watchEndpoint
    };
    resolveCommand(command);
    window.isPipPlaying = false;
};

const originalClasses = {
    ytlrSearchVoice: {
        length: 0,
        classes: [] as string[]
    },
    ytlrSearchVoiceMicButton: {
        length: 0,
        classes: [] as string[]
    }
}

const observerPipEnter = new MutationObserver(() => {
    // Keyed off the flag rather than off any one caller, so every exit path --
    // pipToFullscreen(), the watchEndpoint branch in resolveCommand, and any
    // future one -- clears the button. It carries focusability but no handler,
    // so leaving it behind puts a dead control in the search bar.
    if (!window.isPipPlaying) {
        document.querySelector('#tt-pip-button')?.remove();
        return;
    }
    const searchBar = document.querySelector('ytlr-search-bar');
    if (searchBar) {
        const pipButtonExists = document.querySelector('#tt-pip-button');
        if (!pipButtonExists) {
            const voiceButton = searchBar.querySelector('ytlr-search-voice');
            if (voiceButton) {
                const iconClassNames = window._yttv && Object.values(window._yttv).find(a => a instanceof Map && a.has("CLEAR_COOKIES"));
                if (!iconClassNames) return;
                const iconClassToBeRemoved = iconClassNames.get('MICROPHONE_ON');
                const iconClearCookiesClass = iconClassNames.get('CLEAR_COOKIES');
                const pipButton = document.createElement('ytlr-search-voice');
                for (let i = 0; i < voiceButton.classList.length; i++) {
                    if (originalClasses.ytlrSearchVoice.length === 0) {
                        originalClasses.ytlrSearchVoice.length = voiceButton.classList.length;
                    }

                    if (originalClasses.ytlrSearchVoice.length !== voiceButton.classList.length) {
                        for (const className of originalClasses.ytlrSearchVoice.classes) {
                            pipButton.classList.add(className);
                        }
                        break;
                    }

                    if (!originalClasses.ytlrSearchVoice.classes.includes(voiceButton.classList[i]))
                        originalClasses.ytlrSearchVoice.classes.push(voiceButton.classList[i]);

                    pipButton.classList.add(voiceButton.classList[i]);

                }
                pipButton.style.left = '10.25em';
                pipButton.id = 'tt-pip-button';
                const pipButtonMicButton = document.createElement('ytlr-search-voice-mic-button');
                for (let i = 0; i < voiceButton.children[0].classList.length; i++) {
                    if (originalClasses.ytlrSearchVoiceMicButton.length === 0) {
                        originalClasses.ytlrSearchVoiceMicButton.length = voiceButton.children[0].classList.length;
                    }
                    
                    if (originalClasses.ytlrSearchVoiceMicButton.length !== voiceButton.children[0].classList.length) {
                        for (const className of originalClasses.ytlrSearchVoiceMicButton.classes) {
                            pipButtonMicButton.classList.add(className);
                        }
                        break;
                    }

                    if (!originalClasses.ytlrSearchVoiceMicButton.classes.includes(voiceButton.children[0].classList[i]))
                        originalClasses.ytlrSearchVoiceMicButton.classes.push(voiceButton.children[0].classList[i]);

                    pipButtonMicButton.classList.add(voiceButton.children[0].classList[i]);
                }
                const pipIcon = document.createElement('yt-icon');
                for (let i = 0; i < voiceButton.children[0].children[0].classList.length; i++) {
                    pipIcon.classList.add(voiceButton.children[0].children[0].classList[i]);
                }
                pipIcon.classList.remove(iconClassToBeRemoved);
                pipIcon.classList.add(iconClearCookiesClass);

                pipButtonMicButton.appendChild(pipIcon);
                pipButton.appendChild(pipButtonMicButton);
                searchBar.appendChild(pipButton);
            } else {
                const pipButton = document.createElement('ytlr-search-voice');
                pipButton.style.left = '10.25em';
                pipButton.id = 'tt-pip-button';
                pipButton.setAttribute('idomkey', 'ytLrSearchBarSearchVoice');
                pipButton.setAttribute('tabindex', '0');
                pipButton.classList.add('ytLrSearchVoiceHost', 'ytLrSearchBarSearchVoice');
                const pipButtonMicButton = document.createElement('ytlr-search-voice-mic-button');
                pipButtonMicButton.setAttribute('hybridnavfocusable', 'true');
                pipButtonMicButton.setAttribute('tabindex', '-1');
                pipButtonMicButton.classList.add('ytLrSearchVoiceMicButtonHost', 'zylon-ve');
                const pipIcon = document.createElement('yt-icon');
                pipIcon.setAttribute('tabindex', '-1');
                pipIcon.classList.add('ytContribIconTvArrowLeft', 'ytContribIconHost', 'ytLrSearchVoiceMicButtonIcon');

                pipButtonMicButton.appendChild(pipIcon);
                pipButton.appendChild(pipButtonMicButton);
                searchBar.appendChild(pipButton);
            }
        }
    }
});

whenBodyReady(() => observerPipEnter.observe(document.body, { childList: true, subtree: true }));

export {
    enablePip,
    pipToFullscreen
}