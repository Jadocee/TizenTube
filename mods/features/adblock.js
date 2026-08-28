import { configRead } from '../config.js';
import Chapters from '../ui/chapters.js';
import resolveCommand from '../resolveCommand.js';
import { timelyAction, longPressData, MenuServiceItemRenderer, ShelfRenderer, TileRenderer, ButtonRenderer } from '../ui/ytUI.js';
import { PatchSettings } from '../ui/customYTSettings.js';
import { t } from 'i18next';

/**
 * This is a minimal reimplementation of the following uBlock Origin rule:
 * https://github.com/uBlockOrigin/uAssets/blob/3497eebd440f4871830b9b45af0afc406c6eb593/filters/filters.txt#L116
 *
 * This in turn calls the following snippet:
 * https://github.com/gorhill/uBlock/blob/bfdc81e9e400f7b78b2abc97576c3d7bf3a11a0b/assets/resources/scriptlets.js#L365-L470
 *
 * Seems like for now dropping just the adPlacements is enough for YouTube TV
 */
const origParse = JSON.parse;
JSON.parse = function () {
  const r = origParse.apply(this, arguments);
  try {
    const adBlockEnabled = configRead('enableAdBlock');
    const signinReminderEnabled = configRead('enableSigninReminder');

    if (r?.playbackContext?.contentPlaybackContext) {
      // Handle inline playback without ads
      console.log(r.playbackContext.contentPlaybackContext);
    }

    if (r.adPlacements && adBlockEnabled) {
      r.adPlacements = [];
    }

    // Also set playerAds to false, just incase.
    if (r.playerAds && adBlockEnabled) {
      r.playerAds = false;
    }

    // Also set adSlots to an empty array, emptying only the adPlacements won't work.
    if (r.adSlots && adBlockEnabled) {
      r.adSlots = [];
    }

    if (r.paidContentOverlay && !configRead('enablePaidPromotionOverlay')) {
      r.paidContentOverlay = null;
    }

    if (r?.streamingData?.adaptiveFormats && configRead('videoPreferredCodec') !== 'any') {
      const preferredCodec = configRead('videoPreferredCodec');
      const hasPreferredCodec = r.streamingData.adaptiveFormats.find(format => format.mimeType.includes(preferredCodec));
      if (hasPreferredCodec) {
        r.streamingData.adaptiveFormats = r.streamingData.adaptiveFormats.filter(format => {
          if (format.mimeType.startsWith('audio/')) return true;
          return format.mimeType.includes(preferredCodec);
        });
      }
    }

    // Drop "masthead" ad from home screen
    if (
      r?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content
        ?.sectionListRenderer?.contents
    ) {
      if (!signinReminderEnabled) {
        r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents =
          r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents.filter(
            (elm) => !elm.feedNudgeRenderer
          );
      }

      if (adBlockEnabled) {
        r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents =
          r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents.filter(
            (elm) => !elm.adSlotRenderer
          );

        for (const shelve of r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents) {
          if (shelve.shelfRenderer && shelve.shelfRenderer.content?.horizontalListRenderer?.items) {
            shelve.shelfRenderer.content.horizontalListRenderer.items =
              shelve.shelfRenderer.content.horizontalListRenderer.items.filter(
                (item) => !item.adSlotRenderer
              );
          }
        }
      }

      processShelves(r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents);
    }

    if (
      r?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content
        ?.gridRenderer?.items
    ) {
      addLongPress(r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.gridRenderer.items);
    }

    if (r.endscreen && configRead('enableHideEndScreenCards')) {
      r.endscreen = null;
    }

    if (r.messages && Array.isArray(r.messages) && !configRead('enableYouThereRenderer')) {
      r.messages = r.messages.filter(
        (msg) => !msg?.youThereRenderer
      );
    }

    // Remove shorts ads
    if (!Array.isArray(r) && r?.entries && adBlockEnabled) {
      r.entries = r.entries?.filter(
        (elm) => !elm?.command?.reelWatchEndpoint?.adClientParams?.isAd
      );
    }

    // Patch settings

    if (r?.title?.runs) {
      PatchSettings(r);
    }

    // DeArrow Implementation. I think this is the best way to do it. (DOM manipulation would be a pain)

    if (r?.contents?.sectionListRenderer?.contents) {
      processShelves(r.contents.sectionListRenderer.contents);
    }

    if (r?.continuationContents?.sectionListContinuation?.contents) {
      processShelves(r.continuationContents.sectionListContinuation.contents);
    }

    if (r?.continuationContents?.horizontalListContinuation?.items) {
      deArrowify(r.continuationContents.horizontalListContinuation.items);
      hqify(r.continuationContents.horizontalListContinuation.items);
      addLongPress(r.continuationContents.horizontalListContinuation.items);
      r.continuationContents.horizontalListContinuation.items = hideVideo(r.continuationContents.horizontalListContinuation.items);
    }

    if (r?.continuationContents?.gridContinuation?.items) {
      addLongPress(r.continuationContents.gridContinuation.items);
    }

    if (r?.contents?.tvBrowseRenderer?.content?.tvSecondaryNavRenderer?.sections) {
      for (let i = 0; i < r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections.length; i++) {
        const section = r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections[i].tvSecondaryNavSectionRenderer;
        if (!section || !section.tabs) continue;

        if (configRead('sortSubscriptionsByAlphabet')) {
          section.tabs.sort((a, b) => {
            if (a.tabRenderer.selected && !b.tabRenderer.selected) return -1;
            if (!a.tabRenderer.selected && b.tabRenderer.selected) return 1;
            return a.tabRenderer.title.localeCompare(b.tabRenderer.title);
          });
        }

        for (let j = 0; j < section.tabs.length; j++) {
          const tab = section.tabs[j];
          const content = tab.tabRenderer.content?.tvSurfaceContentRenderer?.content;
          if (content?.sectionListRenderer?.contents) {
            const index = section.tabs.indexOf(tab);
            const clone = content.sectionListRenderer.contents;
            processShelves(clone);
            section.tabs[index].tabRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents = clone;
          }
          if (content?.gridRenderer?.items) {
            addLongPress(content.gridRenderer.items);
          }
        }
      }
    }

    if (r?.contents?.singleColumnWatchNextResults?.pivot?.sectionListRenderer) {
      if (!signinReminderEnabled) {
        r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents =
          r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents.filter(
            (elm) => !elm.alertWithActionsRenderer
          );
      }
      processShelves(r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents, false);
      if (window.queuedVideos.videos.length > 0) {
        const queuedVideosClone = window.queuedVideos.videos.slice();
        queuedVideosClone.unshift(TileRenderer(
          t('queue.clear'),
          {
            customAction: {
              action: 'CLEAR_QUEUE'
            }
          }));
        // The Clear tile is unshifted onto the front, so index 0 is destructive:
        // focus has to land on the playing item when there is one. Reading
        // contentId off the wrapper instead of its tileRenderer made the lookup
        // always miss, so it always landed on Clear.
        const playingIndex = queuedVideosClone.findIndex(
          v => v.tileRenderer && v.tileRenderer.contentId === window.queuedVideos.lastVideoId
        );
        r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents.unshift(ShelfRenderer(
          t('queue.shelfTitle'),
          queuedVideosClone,
          playingIndex !== -1 ? playingIndex : 0
        ));
      }
    }
    /*
   
    Chapters are disabled due to the API removing description data which was used to generate chapters
   
    if (r?.contents?.singleColumnWatchNextResults?.results?.results?.contents && configRead('enableChapters')) {
      const chapterData = Chapters(r);
      r.frameworkUpdates.entityBatchUpdate.mutations.push(chapterData);
      resolveCommand({
        "clickTrackingParams": "null",
        "loadMarkersCommand": {
          "visibleOnLoadKeys": [
            chapterData.entityKey
          ],
          "entityKeys": [
            chapterData.entityKey
          ]
        }
      });
    }*/

    // Manual SponsorBlock Skips

    if (r?.playerOverlays?.playerOverlayRenderer) {
      if (r.playerOverlays.playerOverlayRenderer.timelyActionRenderers) {
        r.playerOverlays.playerOverlayRenderer.timelyActionRenderers = 
        r.playerOverlays.playerOverlayRenderer.timelyActionRenderers.filter(a => a.timelyActionRenderer.type !== 'TIMELY_ACTION_TYPE_SHOPPING' ||
                                                                                a.timelyActionRenderer.type !== 'TIMELY_ACTION_TYPE_NFL_WATERMARK');
      } else r.playerOverlays.playerOverlayRenderer.timelyActionRenderers = [];
      if (configRead('sponsorBlockManualSkips').length > 0) {
        const manualSkippedSegments = configRead('sponsorBlockManualSkips');
        if (window?.sponsorblock?.segments) {
          for (const segment of window.sponsorblock.segments) {
            if (manualSkippedSegments.includes(segment.category)) {
              const timelyActionData = timelyAction(
                t('sponsorblock.toasts.skip', { segment: t(`sponsorblock.segments.${segment.category}`) }),
                'SKIP_NEXT',
                {
                  clickTrackingParams: null,
                  showEngagementPanelEndpoint: {
                    customAction: {
                      action: 'SKIP',
                      parameters: {
                        time: segment.segment[1]
                      }
                    }
                  }
                },
                segment.segment[0] * 1000,
                segment.segment[1] * 1000 - segment.segment[0] * 1000
              );
              r.playerOverlays.playerOverlayRenderer.timelyActionRenderers.push(timelyActionData);
            }
          }
        }
      }
    }

    if (r?.transportControls?.transportControlsRenderer?.promotedActions && configRead('enableSponsorBlockHighlight')) {
      if (window?.sponsorblock?.segments) {
        const category = window.sponsorblock.segments.find(seg => seg.category === 'poi_highlight');
        if (category) {
          r.transportControls.transportControlsRenderer.promotedActions.push({
            type: 'TRANSPORT_CONTROLS_BUTTON_TYPE_SPONSORBLOCK_HIGHLIGHT',
            button: {
              buttonRenderer: ButtonRenderer(
                false,
                t('sponsorblock.toasts.skipToHighlight'),
                'SKIP_NEXT',
                {
                  clickTrackingParams: null,
                  customAction: {
                    action: 'SKIP',
                    parameters: {
                      time: category.segment[0]
                    }
                  }
                })
            }
          });
        }
      }
    }
  } catch (e) {
    console.error('An error occured while processing the JSON:', e);
  }

  return r;
};

// Fix playback issues

const origStringify = JSON.stringify;
JSON.stringify = function (value, replacer, space) {
  if (value?.playbackContext?.contentPlaybackContext) {
    const copiedValue = JSON.parse(origStringify(value));
    if (!copiedValue.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd) {
      copiedValue.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd = true;
      return origStringify.call(this, copiedValue, replacer, space);
    }
  }
  return origStringify.call(this, value, replacer, space);
};

// `window.JSON` is the same object the assignments above already wrote to, so
// the two `window.JSON.x = x` lines that used to sit here were no-ops.
//
// This part is not. YouTube's bundle keeps per-module references to JSON, and a
// module that captured `parse` before this script ran keeps calling the native
// one -- its ad payloads are never filtered. This loop exists to repair that,
// but it used to run once at module load, when `window._yttv` does not exist
// yet: every other feature in this mod polls for it, and `for (const key in
// undefined)` iterates zero times. So it never patched anything, and whether
// ads were blocked came down to whether this script won the race against
// YouTube's bundle -- which is why blocking silently fails for a whole session
// now and then and comes back after restarting the app.

let jsonPatchAttempts = 0;
let jsonPatchQuietPasses = 0;

function patchYttvJson() {
  let sawModules = false;
  let applied = 0;

  for (const key in window._yttv) {
    sawModules = true;
    const module = window._yttv[key];
    if (!module || !module.JSON) continue;
    try {
      if (module.JSON.parse && module.JSON.parse !== JSON.parse) {
        module.JSON.parse = JSON.parse;
        applied++;
      }
      if (module.JSON.stringify && module.JSON.stringify !== JSON.stringify) {
        module.JSON.stringify = JSON.stringify;
        applied++;
      }
    } catch (e) {
      // A frozen module is not worth failing the whole pass over.
    }
  }

  jsonPatchQuietPasses = applied ? 0 : jsonPatchQuietPasses + 1;

  // Modules keep appearing as the app boots and as surfaces are opened, so this
  // runs until the registry exists and has needed nothing for five seconds.
  // Capped at a minute, after which it either worked or never will.
  const settled = sawModules && jsonPatchQuietPasses >= 20;
  if (++jsonPatchAttempts < 240 && !settled) {
    setTimeout(patchYttvJson, 250);
  }
}

patchYttvJson();


function processShelves(shelves, shouldAddPreviews = true) {
  for (const shelve of shelves) {
    if (shelve.shelfRenderer) {
      if (!shelve.shelfRenderer.content?.horizontalListRenderer?.items) continue;
      deArrowify(shelve.shelfRenderer.content.horizontalListRenderer.items);
      hqify(shelve.shelfRenderer.content.horizontalListRenderer.items);
      addLongPress(shelve.shelfRenderer.content.horizontalListRenderer.items);
      if (shouldAddPreviews) {
        addPreviews(shelve.shelfRenderer.content.horizontalListRenderer.items);
      }
      shelve.shelfRenderer.content.horizontalListRenderer.items = hideVideo(shelve.shelfRenderer.content.horizontalListRenderer.items);
      if (!configRead('enableShorts')) {
        if (shelve.shelfRenderer.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS') {
          shelves.splice(shelves.indexOf(shelve), 1);
          continue;
        }
        shelve.shelfRenderer.content.horizontalListRenderer.items = shelve.shelfRenderer.content.horizontalListRenderer.items.filter(item => item.tileRenderer?.tvhtml5ShelfRendererType !== 'TVHTML5_TILE_RENDERER_TYPE_SHORTS');

        shelve.shelfRenderer.content.horizontalListRenderer.items = shelve.shelfRenderer.content.horizontalListRenderer.items.filter(item => !item.tileRenderer?.onSelectCommand?.reelWatchEndpoint);
      }
    }
  }
}

function addPreviews(items) {
  if (!configRead('enablePreviews')) return;
  for (const item of items) {
    if (item.tileRenderer) {
      const watchEndpoint = item.tileRenderer.onSelectCommand;
      const copiedEndpoint = JSON.parse(JSON.stringify(watchEndpoint));
      if (item.tileRenderer?.onFocusCommand?.playbackEndpoint) continue;
      if (item.tileRenderer?.onFocusCommand?.commandExecutorCommand) continue;
      item.tileRenderer.onFocusCommand = {
        startInlinePlaybackCommand: {
          blockAdoption: true,
          caption: false,
          delayMs: 3000,
          durationMs: 40000,
          muted: false,
          restartPlaybackBeforeSeconds: 10,
          resumeVideo: true,
          playbackEndpoint: copiedEndpoint
        }
      };
    }
  }
}

function deArrowify(items) {
  for (const item of items) {
    if (item.adSlotRenderer) {
      const index = items.indexOf(item);
      items.splice(index, 1);
      continue;
    }
    if (!item.tileRenderer) continue;
    if (configRead('enableDeArrow')) {
      const videoID = item.tileRenderer.contentId;
      fetch(`https://sponsor.ajay.app/api/branding?videoID=${videoID}`).then(res => res.json()).then(data => {
        if (data.titles.length > 0) {
          const mostVoted = data.titles.reduce((max, title) => max.votes > title.votes ? max : title);
          item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText = mostVoted.title;
        }

        if (data.thumbnails.length > 0 && configRead('enableDeArrowThumbnails')) {
          const mostVotedThumbnail = data.thumbnails.reduce((max, thumbnail) => max.votes > thumbnail.votes ? max : thumbnail);
          if (mostVotedThumbnail.timestamp) {
            item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = [
              {
                url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${videoID}&time=${mostVotedThumbnail.timestamp}`,
                width: 1280,
                height: 640
              }
            ]
          }
        }
      }).catch(() => { });
    }
  }
}


function hqify(items) {
  for (const item of items) {
    if (!item.tileRenderer) continue;
    if (item.tileRenderer.style !== 'TILE_STYLE_YTLR_DEFAULT') continue;
    if (configRead('enableHqThumbnails')) {
      if (!item.tileRenderer.onSelectCommand?.watchEndpoint?.videoId) continue;
      if (!item.tileRenderer.header?.tileHeaderRenderer?.thumbnail?.thumbnails?.[0]?.url) continue;
      const videoID = item.tileRenderer.onSelectCommand.watchEndpoint.videoId;
      const queryArgs = item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails[0].url.split('?')[1];
      item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = [
        {
          url: `https://i.ytimg.com/vi/${videoID}/sddefault.jpg${queryArgs ? `?${queryArgs}` : ''}`,
          width: 640,
          height: 480
        }
      ];
    }
  }
}

function addLongPress(items) {
  for (const item of items) {
    if (!item.tileRenderer) continue;
    if (item.tileRenderer.style !== 'TILE_STYLE_YTLR_DEFAULT') continue;
    if (item.tileRenderer.onLongPressCommand?.showMenuCommand?.menu?.menuRenderer?.items) {
      const copiedItem = JSON.parse(JSON.stringify(item));
      item.tileRenderer.onLongPressCommand.showMenuCommand.menu.menuRenderer.items.push(MenuServiceItemRenderer(t('longPress.addToQueue'), {
        clickTrackingParams: null,
        playlistEditEndpoint: {
          customAction: {
            action: 'ADD_TO_QUEUE',
            parameters: copiedItem
          }
        }
      }));
      continue;
    }
    if (!configRead('enableLongPress')) continue;
    if (!item.tileRenderer?.metadata?.tileMetadataRenderer) continue;
    if (!item.tileRenderer?.header?.tileHeaderRenderer?.thumbnail?.thumbnails) continue;
    if (!item.tileRenderer.onSelectCommand?.watchEndpoint) continue;
    const copiedItem = JSON.parse(JSON.stringify(item));
    const subtitleNode = copiedItem.tileRenderer.metadata.tileMetadataRenderer.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text;
    if (!subtitleNode) continue;
    const subtitle = subtitleNode;
    const data = longPressData({
      videoId: copiedItem.tileRenderer.contentId,
      thumbnails: copiedItem.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails,
      title: copiedItem.tileRenderer.metadata.tileMetadataRenderer.title.simpleText,
      subtitle: subtitle.runs ? subtitle.runs[0].text : subtitle.simpleText,
      watchEndpointData: copiedItem.tileRenderer.onSelectCommand.watchEndpoint,
      item: copiedItem
    });
    item.tileRenderer.onLongPressCommand = data;
  }
}

function hideVideo(items) {
  return items.filter(item => {
    if (!item.tileRenderer) return true;
    const progressBar = item.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays?.find(overlay => overlay.thumbnailOverlayResumePlaybackRenderer)?.thumbnailOverlayResumePlaybackRenderer;
    if (!progressBar) return true;
    const pages = configRead('hideWatchedVideosPages');
    if (!pages.length) return true;
    const hash = location.hash.substring(1);
    const pageName = hash === '/' ? 'home' : hash.startsWith('/search') ? 'search' : hash.split('?')[1]?.split('&')[0]?.split('=')[1]?.replace('FE', '')?.replace('topics_', '') ?? '';
    if (!pages.includes(pageName)) return true;

    const percentWatched = (progressBar.percentDurationWatched || 0);
    return percentWatched <= configRead('hideWatchedVideosThreshold');
  });
}
