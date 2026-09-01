// Everything the mod reads from or writes to the page.
//
// The YouTube side is deliberately loose. `_yttv` is a registry of minified
// modules whose shapes change with every YouTube release, and pretending
// otherwise would be a lie the compiler enforces. What is typed here is the
// boundary: the names that exist, so a typo in one of them is still caught.

import type { QueuedVideos } from './youtube';

declare global {
    /** Registry of YouTube's own minified modules. Shapes are not stable. */
    type YttvRegistry = Record<string, any>;

    interface TectonicConfig {
        featureSwitches: Record<string, boolean>;
        clientData: Record<string, unknown> & { legacyApplicationQuality?: string };
    }

    /** The Cobalt/Android TV host bridge. Absent on Tizen. */
    interface H5vccTizenTube {
        GetVersion(): string;
        GetArchitecture?(): string;
        InstallAppFromURL(url: string): void;
        HasSystemFeature?(feature: string): boolean;
        EnterPIP(): void;
        SetUserAgent?(userAgent: string): void;
        SetFrameRate?(frameRate: number): void;
    }

    interface Window {
        _yttv?: YttvRegistry;
        yt?: { config_?: { HL?: string } };
        tectonicConfig?: TectonicConfig;
        h5vcc?: { tizentube?: H5vccTizenTube };

        /** Owned by the mod. */
        queuedVideos: QueuedVideos;
        isPipPlaying: boolean;
        sponsorblock?: { init(): Promise<void>; destroy(): void; videoID?: string } | null;
        preferredVideoQualityHandler?: unknown;

        /** From the vendored spatial-navigation polyfill. */
        __spatialNavigation__: {
            // The values the polyfill's setter actually accepts. It coerces anything else
            // to 'ARROW', so the two that used to be declared here stored the opposite
            // of what they named.
            keyMode: 'NONE' | 'ARROW' | 'SHIFTARROW';
        };
        navigate(direction: 'left' | 'right' | 'up' | 'down'): void;
    }

    /** Installed on window by the vendored spatial-navigation polyfill. */
    function navigate(direction: 'left' | 'right' | 'up' | 'down'): void;

    /** Tizen platform API, present only inside the TV app. */
    const tizen: any;
}
