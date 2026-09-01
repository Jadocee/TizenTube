import { configRead, configChangeEmitter } from '../config.js';
import type { YouTubePlayer } from '../types/youtube';

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

        if (state?.isPlaying && !this.#hasAppliedQuality) {
            // Guarded the way its two neighbours above already are: this runs
            // before the player API is attached, where the unguarded call threw
            // and took the whole handler with it.
            const stats = this.#player?.getVideoStats?.();
            const isShorts = stats ? Object.values(stats).some((a) => a === 'shortspage') : false;
            if (!isShorts) {
                this.#applyQuality();
                this.#hasAppliedQuality = true;
            }
        }
    };

    #applyQuality(): void {
        const preferredQuality = configRead(CONFIG_KEYS.QUALITY);
        if (!preferredQuality || preferredQuality === 'auto' || !this.#player) return;

        try {
            const quality = this.#determineQuality(preferredQuality);

            if (quality) {
                this.#player.setPlaybackQualityRange(quality, quality);
            }
        } catch (e) {
            console.warn('[PreferredQuality] Failed to apply quality:', e);
        }
    }

    #determineQuality(preference: string): string | null {
        const availableQualities = this.#player!.getAvailableQualityData();
        // Null rather than 'highres': the caller's `if (quality)` then does the
        // work, and an idle player no longer gets pinned to maximum from the
        // settings menu.
        if (!availableQualities?.length) return null;

        const getQualityValue = (label: string) => parseInt(label, 10) || 0;
        const targetValue = getQualityValue(preference);

        // Copy before sorting: the array is YouTube's, not ours.
        const sorted = [...availableQualities].sort(
            (a, b) => getQualityValue(b.qualityLabel) - getQualityValue(a.qualityLabel),
        );
        // The preference is a cap, so take the best rendition at or below it.
        // Matching the height exactly and falling back to 'highres' otherwise
        // meant a stream without that exact label was pinned to the MAXIMUM --
        // the opposite of what the setting asks for. Subsumes the exact match;
        // when every rendition is above the request, lands on the lowest.
        const atOrBelow = sorted.find((q) => getQualityValue(q.qualityLabel) <= targetValue);
        return (atOrBelow ?? sorted[sorted.length - 1]).quality;
    }
}

window.preferredVideoQualityHandler = new PreferredQualityHandler();
