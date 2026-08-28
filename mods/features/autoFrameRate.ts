import { configRead } from "../config.js";
import type { YouTubePlayer } from "../types/youtube";

// The resume timer from the last frame-rate switch, at module scope so a second
// switch supersedes the first rather than stacking another play() on top of it.
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

function attachToVideoPlayer() {
    const player = document.querySelector<YouTubePlayer>('.html5-video-player');
    if (!player) return setTimeout(attachToVideoPlayer, 500);

    player.addEventListener('onPlaybackStartExternal', () => {
        try {
            if (window.location.href.indexOf('watch') === -1) return;
            const statsForNerds = player.getStatsForNerds();

            const resolutionMatch = statsForNerds.resolution.match(/(\d+)x(\d+)@([\d.]+)/);
            const pauseFor = configRead('autoFrameRatePauseVideoFor');

            if (resolutionMatch) {
                const fps = resolutionMatch[3];
                if (configRead('autoFrameRate') && window.h5vcc && window.h5vcc.tizentube && window.h5vcc.tizentube.SetFrameRate) {
                    // Re-queried per use, the way every other consumer in the mod
                    // does it. This used to be captured once next to the player
                    // probe above -- before the guard that decides the player even
                    // exists -- so on the first attach it was null, pause() threw,
                    // and the catch below swallowed it: the frame-rate switch
                    // never ran at all.
                    const video = document.querySelector('video');
                    if (pauseFor > 0 && video) {
                        video.pause();
                        if (resumeTimer) clearTimeout(resumeTimer);
                        resumeTimer = setTimeout(() => {
                            resumeTimer = null;
                            // The pause is user-configurable up to five seconds,
                            // which is ample time to leave the video.
                            if (window.location.href.indexOf('watch') === -1) return;
                            // play() resolves to a promise here and rejects with
                            // AbortError whenever the play is interrupted.
                            video.play().catch(() => {});
                        }, pauseFor);
                    }
                    window.h5vcc.tizentube.SetFrameRate(parseFloat(fps));
                }
            }
        } catch (e) {
            console.error('Error in auto frame rate handling:', e);
        }
    });

    // Reset on every navigation. The guard here used to be
    // `indexOf('watch') > 0`, which is true when ARRIVING at a watch route --
    // the one moment the rate is about to be set again anyway -- and matched
    // nothing at all when leaving one, so the panel stayed locked at whatever
    // refresh rate the last video needed.
    window.addEventListener('hashchange', () => {
        if (configRead('autoFrameRate') && window.h5vcc && window.h5vcc.tizentube && window.h5vcc.tizentube.SetFrameRate) {
            window.h5vcc.tizentube.SetFrameRate(0);
        }
    });
}

attachToVideoPlayer();
