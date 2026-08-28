import { configRead, configChangeEmitter } from "../config.js";
import type { YouTubePlayer } from "../types/youtube";

const SELECTORS = {
    PLAYER: '.html5-video-player',
};

const EVENTS = {
    YT_STATE_CHANGE: 'onStateChange',
    CONFIG_CHANGE: 'configChange',
};

const CONFIG_KEYS = {
    QUALITY: 'preferredVideoQuality',
} as const;

class PreferredQualityHandler {
    #player: YouTubePlayer | null = null;
    #attachTimeout: ReturnType<typeof setTimeout> | null = null;
    #lastVideoId: string | null | undefined = null;
    #hasAppliedQuality = false;

    constructor() {
        this.init();
    }

    init(): void {
        this.#pollForPlayer();
        this.#setupConfigListener();
    }

    #pollForPlayer(): void {
        clearTimeout(this.#attachTimeout!);

        const playerElement = document.querySelector<YouTubePlayer>(SELECTORS.PLAYER);

        if (!playerElement) {
            this.#attachTimeout = setTimeout(() => this.#pollForPlayer(), 100);
            return;
        }

        this.#player = playerElement;

        this.#player.addEventListener(EVENTS.YT_STATE_CHANGE, this.#handleStateChange);

        this.#handleStateChange();
    }

    #setupConfigListener(): void {
        configChangeEmitter.addEventListener(EVENTS.CONFIG_CHANGE, (ev) => {
            if (ev.detail?.key === CONFIG_KEYS.QUALITY) {
                this.#applyQuality();
            }
        });
    }

    #handleStateChange = () => {
        const state = this.#player?.getPlayerStateObject?.();
        const videoData = this.#player?.getVideoData?.();
        const videoId = videoData?.video_id;

        if (videoId !== this.#lastVideoId) {
            this.#lastVideoId = videoId;
            this.#hasAppliedQuality = false;
        }

        const isShorts = Object.values(this.#player!.getVideoStats()).find(a => a && a === 'shortspage');
        if (state?.isPlaying && !this.#hasAppliedQuality && !isShorts) {
            this.#applyQuality();
            this.#hasAppliedQuality = true;
        }
    };

    #applyQuality(): void {
        const preferredQuality = configRead(CONFIG_KEYS.QUALITY);
        if (!preferredQuality || preferredQuality === 'auto' || !this.#player) return;

        try {
            const quality = this.#determineQuality(preferredQuality);

            if (quality) {
              this.#player.setPlaybackQualityRange(quality, quality)
            }
        } catch (e) {
            console.warn('[PreferredQuality] Failed to apply quality:', e);
        }
    }

    #determineQuality(preference: string): string {
        const availableQualities = this.#player!.getAvailableQualityData();
        if (!availableQualities?.length) return 'highres';

        const getQualityValue = (label: string) => parseInt(label, 10) || 0;
        const targetValue = getQualityValue(preference);

        const match = availableQualities.find(q => getQualityValue(q.qualityLabel) === targetValue);

        return match ? match.quality : 'highres';
    }
}

window.preferredVideoQualityHandler = new PreferredQualityHandler();
