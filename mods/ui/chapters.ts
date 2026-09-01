import { t } from 'i18next';

/** One chapter parsed out of a video description. */
interface Chapter {
    time: number;
    name: string;
}

function parseTimestamps(input: string): Chapter[] {
    var lines = input.trim().split('\n');
    var result = [];
    // The hour group is optional but captured. The old pattern took only the
    // first two components, so "1:02:03" parsed as 1m02s -- every chapter in a
    // video over an hour collapsed into its opening minutes.
    var timestampRegex = /^(?:(\d+):)?(\d{1,2}):(\d{2})\b/;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var match = line.match(timestampRegex);
        if (match) {
            var hours = match[1] ? parseInt(match[1], 10) : 0;
            var minutes = parseInt(match[2], 10);
            var seconds = parseInt(match[3], 10);
            var milliseconds = (hours * 3600 + minutes * 60 + seconds) * 1000;
            // Sliced past the timestamp rather than split on spaces, which
            // dropped only the first token -- so the very common
            // "0:00 - Intro" form kept its leading dash.
            var name = line
                .slice(match[0].length)
                .replace(/^[\s\-\u2013\u2014|:]+/, '')
                .trim();
            result.push({ time: milliseconds, name: name });
        }
    }
    return result;
}

function marker(title: string, start: string, duration: string, videoID: string, i: number) {
    return {
        title: {
            simpleText: title,
        },
        startMillis: start,
        durationMillis: duration,
        thumbnailDetails: {
            thumbnails: [
                {
                    url: `https://i.ytimg.com/vi/${videoID}/hqdefault.jpg`,
                    width: 320,
                    height: 180,
                },
            ],
        },
        onActive: {
            innertubeCommand: {
                clickTrackingParams: null,
                entityUpdateCommand: {
                    entityBatchUpdate: {
                        mutations: [
                            {
                                entityKey: `${videoID}${start}${duration}`,
                                type: 'ENTITY_MUTATION_TYPE_REPLACE',
                                payload: {
                                    markersEngagementPanelSyncEntity: {
                                        key: `${videoID}${start}${duration}`,
                                        panelId:
                                            'engagement-panel-macro-markers-description-chapters',
                                        activeItemIndex: i,
                                        syncEnabled: true,
                                    },
                                },
                            },
                        ],
                    },
                },
            },
        },
    };
}

function markerEntity(videoID: string, markers: ReturnType<typeof marker>[]) {
    return {
        entityKey: `${videoID}-key`,
        type: 'ENTITY_MUTATION_TYPE_REPLACE',
        payload: {
            macroMarkersListEntity: {
                key: `${videoID}-key`,
                externalVideoId: videoID,
                markersList: {
                    markerType: 'MARKER_TYPE_CHAPTERS',
                    markers: markers,
                    headerTitle: {
                        runs: [
                            {
                                text: t('chapters.title'),
                            },
                        ],
                    },
                    onTap: {
                        innertubeCommand: {
                            clickTrackingParams: null,
                            changeEngagementPanelVisibilityAction: {
                                targetId: 'engagement-panel-macro-markers-description-chapters',
                                visibility: 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
                            },
                        },
                    },
                    markersEdu: {
                        enterNudgeText: {
                            runs: [
                                {
                                    text: t('chapters.enterNudge'),
                                },
                            ],
                        },
                        enterNudgeA11yText: t('chapters.enterNudge'),
                        navNudgeText: {
                            runs: [
                                {
                                    text: t('chapters.navNudge'),
                                },
                            ],
                        },
                        navNudgeA11yText: t('chapters.navNudgeA11y'),
                    },
                    loggingDirectives: {
                        trackingParams: null,
                        enableDisplayloggerExperiment: true,
                    },
                },
            },
        },
    };
}

export default function Chapters(video: any) {
    const videoID =
        video.contents.singleColumnWatchNextResults.results.results.contents[0].itemSectionRenderer
            .contents[0].videoMetadataRenderer.videoId;
    const videoDescription =
        video.contents.singleColumnWatchNextResults.results.results.contents[0].itemSectionRenderer
            .contents[0].videoMetadataRenderer.description.runs[0].text;
    const chapters = parseTimestamps(videoDescription);
    // Guarded: no <video> in the DOM threw here, and an element that has not
    // loaded metadata for the new video reports NaN, which used to reach the
    // final marker as the literal string "NaN".
    const videoEl = document.querySelector('video');
    const videoDuration =
        videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration * 1000 : 0;
    const markers: ReturnType<typeof marker>[] = [];

    for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const nextChapter = chapters[i + 1];
        const duration = nextChapter
            ? nextChapter.time - chapter.time
            : videoDuration > chapter.time
              ? videoDuration - chapter.time
              : 0;
        markers.push(marker(chapter.name, String(chapter.time), String(duration), videoID, i));
    }

    const markerEntityData = markerEntity(videoID, markers);
    return markerEntityData;
}
