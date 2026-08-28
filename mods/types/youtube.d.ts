// The renderer and command shapes the mod builds and hands to YouTube.
//
// These describe what *we* construct, not what YouTube returns — that stays
// `any`, because its shape changes per release and the mod only ever probes it.

/** A localized or plain string, in YouTube's two text shapes. */
export interface SimpleText { simpleText: string }
export interface TextRuns { runs: { text: string }[] }

export interface Thumbnail { url: string; width?: number; height?: number }
export interface Thumbnails { thumbnails: Thumbnail[] }

/** Anything the mod passes to resolveCommand. */
export interface Command {
    clickTrackingParams?: string | null;
    signalAction?: { signal?: string; customAction?: CustomAction };
    customAction?: CustomAction;
    setClientSettingEndpoint?: { settingDatas: SettingData[] };
    commandExecutorCommand?: { commands: Command[] };
    openPopupAction?: Record<string, any>;
    watchEndpoint?: Record<string, any>;
    browseEndpoint?: { browseId: string };
    searchEndpoint?: { query: string };
    [key: string]: any;
}

export interface CustomAction {
    action: string;
    parameters?: any;
}

export interface SettingData {
    clientSettingEnum: { item: string };
    boolValue?: boolean;
    intValue?: string;
    stringValue?: string;
    arrayValue?: string;
}

/** A row in one of the mod's menus. */
export interface CompactLinkRenderer {
    compactLinkRenderer: {
        title?: SimpleText;
        subtitle?: SimpleText;
        icon?: { iconType?: string };
        secondaryIcon?: { iconType?: string };
        serviceEndpoint: { commandExecutorCommand: { commands: Command[] } };
    };
}

export type Renderer = CompactLinkRenderer | Record<string, any>;

/** Header of a modal: either a bare title or a title/subtitle pair. */
export type ModalHeader = string | {
    title?: string;
    subtitle?: string;
    overlayPanelHeaderRenderer?: Record<string, any>;
};

/** A tile the mod has queued for playback. */
export interface QueuedTile {
    tileRenderer?: { contentId?: string; onSelectCommand?: Command; [key: string]: any };
    [key: string]: any;
}

export interface QueuedVideos {
    videos: QueuedTile[];
    lastVideoId: string | null;
}
