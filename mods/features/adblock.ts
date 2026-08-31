import { configRead, configWrite } from '../config.js';
import { recordVideoContext } from './videoContext.js';
import { prune, pruneTokens, textCouldMatch, type PruneRule } from './jsonPrune.js';
import {
  TILE_STYLE_DEFAULT,
  DEFAULT_PREVIEW_DURATION_MS,
  bestThumbnail,
  previewableTile,
  startInlinePlayback,
  pageNameFromHash,
  shelfIsEmpty,
  hasMembersOnlyBadge,
} from './tileFixes.js';
import { fetchBranding, bestTitle, bestThumbnailTime } from './dearrowCache.js';
import { isAiChannel } from './aisList.js';
import {
  menuItems,
  offeredRows,
  tileIdentity,
  channelEntry,
  isVideoHidden,
  isChannelHidden,
} from './tileMenu.js';
import Chapters from '../ui/chapters.js';
import resolveCommand from '../resolveCommand.js';
import { timelyAction, longPressData, MenuServiceItemRenderer, ShelfRenderer, TileRenderer, ButtonRenderer } from '../ui/ytUI.js';
import { PatchSettings } from '../ui/customYTSettings.js';
import { t } from 'i18next';

/** A segment SponsorBlock's API returned. sponsorblock.js hangs these off
 *  window.sponsorblock once the request answers; globals.d.ts describes only
 *  that handler's lifecycle, so the extra field is narrowed at the read. */
interface SponsorSegment {
  category: string;
  /** [start, end], in seconds. */
  segment: [number, number];
}

interface SponsorBlockSegments {
  segments?: SponsorSegment[] | null;
}

/**
 * This is a minimal reimplementation of the following uBlock Origin rule:
 * https://github.com/uBlockOrigin/uAssets/blob/3497eebd440f4871830b9b45af0afc406c6eb593/filters/filters.txt#L116
 *
 * This in turn calls the following snippet:
 * https://github.com/gorhill/uBlock/blob/bfdc81e9e400f7b78b2abc97576c3d7bf3a11a0b/assets/resources/scriptlets.js#L365-L470
 *
 * Seems like for now dropping just the adPlacements is enough for YouTube TV
 */
/**
 * The ad rules, as paths rather than branches.
 *
 * `**` means "at any depth", which is the point of the rewrite: the previous
 * code tested `r.adPlacements` and friends at the top level only, so the same
 * properties inside a continuation, a watch-next payload or any nested response
 * went through untouched. One rule now covers every position they can occupy.
 *
 * Arrays are emptied rather than deleted because YouTube's renderers read
 * `.length` off them; `playerAds` is set false because that is what the field is
 * when there are none.
 */
const AD_RULES: PruneRule[] = [
    { path: '**.adPlacements', replaceWith: [] },
    { path: '**.adSlots', replaceWith: [] },
    { path: '**.playerAds', replaceWith: false },
    // Promoted tiles sit beside real ones inside a list, so the element goes and
    // the list stays. Previously done for exactly two hardcoded paths -- the
    // home sectionList and a shelf's horizontalList -- which is why grid
    // surfaces, continuations and every other list kept their ads.
    { path: '**.contents', dropItemsWith: 'adSlotRenderer' },
    { path: '**.items', dropItemsWith: 'adSlotRenderer' },
    { path: '**.entries', dropItemsWith: 'command.reelWatchEndpoint.adClientParams.isAd' },
];

/** The literal keys AD_RULES can match, computed once. */
const AD_TOKENS = pruneTokens(AD_RULES);

/**
 * Objects already processed, so the same payload cannot be run through twice.
 *
 * There are two entry points now -- JSON.parse and Response.json -- and nothing
 * says a given response reaches only one of them. Several of the steps below are
 * not idempotent (pushing a highlight button onto promotedActions, for one), so
 * without this a payload seen by both would get them applied twice.
 */
const processed = new WeakSet<object>();

/**
 * Everything the mod does to a parsed InnerTube payload.
 *
 * `sourceText` is the raw JSON when the caller has it, purely as a cheap filter:
 * a key absent from the text cannot be in the object, so the ad pass can be
 * skipped without walking the tree. Response.json has no text to offer and
 * passes undefined, which simply runs the pass.
 */
function processResponse(r: any, sourceText?: unknown): any {
  if (r !== null && typeof r === 'object') {
    if (processed.has(r)) return r;
    processed.add(r);
  }
  try {
    // Every player response the page parses comes through here, and it is the
    // only place the current video's channel is visible. SponsorBlock's
    // per-channel opt-out reads what this records.
    recordVideoContext(r);

    const adBlockEnabled = configRead('enableAdBlock');
    const signinReminderEnabled = configRead('enableSigninReminder');

    // The whole ad pass, at any depth. Skipped outright when the source text
    // cannot contain any of the keys, which is the common case.
    if (adBlockEnabled && textCouldMatch(sourceText, AD_TOKENS)) {
      prune(r, AD_RULES);
    }

    if (r.paidContentOverlay && !configRead('enablePaidPromotionOverlay')) {
      r.paidContentOverlay = null;
    }

    if (r?.streamingData?.adaptiveFormats && configRead('videoPreferredCodec') !== 'any') {
      const preferredCodec = configRead('videoPreferredCodec');
      const hasPreferredCodec = r.streamingData.adaptiveFormats.find((format: any) => format.mimeType.includes(preferredCodec));
      if (hasPreferredCodec) {
        r.streamingData.adaptiveFormats = r.streamingData.adaptiveFormats.filter((format: any) => {
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
            (elm: any) => !elm.feedNudgeRenderer
          );
      }

      // The promoted tiles these two loops used to strip -- the home section
      // list and each shelf's horizontal list -- are covered by AD_RULES above,
      // which reaches every other list as well.

      processShelves(r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer.contents);
    }

    if (
      r?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content
        ?.gridRenderer?.items
    ) {
      const grid = r.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.gridRenderer;
      // Grid surfaces -- a channel's videos, a playlist, the topic pages -- got
      // long-press and watched-hiding but no thumbnails and no previews, so the
      // same tile behaved differently depending on which surface you found it
      // on.
      grid.items = dropHidden(grid.items);
      deArrowify(grid.items);
      hqify(grid.items);
      addLongPress(grid.items);
      addPreviews(grid.items);
      grid.items = hideVideo(grid.items);
    }

    if (r.endscreen && configRead('enableHideEndScreenCards')) {
      r.endscreen = null;
    }

    if (r.messages && Array.isArray(r.messages) && !configRead('enableYouThereRenderer')) {
      r.messages = r.messages.filter(
        (msg: any) => !msg?.youThereRenderer
      );
    }

    // Patch settings

    // Array.isArray(r.items) is the precondition PatchSettings actually needs;
    // title.runs alone matched unrelated payloads.
    if (r?.title?.runs && Array.isArray(r.items)) {
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
      r.continuationContents.horizontalListContinuation.items = dropHidden(r.continuationContents.horizontalListContinuation.items);
      deArrowify(r.continuationContents.horizontalListContinuation.items);
      hqify(r.continuationContents.horizontalListContinuation.items);
      addLongPress(r.continuationContents.horizontalListContinuation.items);
      // Previews were never attached here. A shelf pages in more tiles as you
      // scroll along it, and every tile past that boundary arrived without an
      // onFocusCommand -- so previews worked for the first screenful of each
      // shelf and silently stopped, which reads as the feature being broken
      // rather than as a boundary. The indicator makes that boundary visible,
      // so it is closed in the same pass.
      addPreviews(r.continuationContents.horizontalListContinuation.items);
      r.continuationContents.horizontalListContinuation.items = hideVideo(r.continuationContents.horizontalListContinuation.items);
    }

    if (r?.continuationContents?.gridContinuation?.items) {
      // Grid continuations got neither thumbnails nor previews either.
      r.continuationContents.gridContinuation.items = dropHidden(r.continuationContents.gridContinuation.items);
      deArrowify(r.continuationContents.gridContinuation.items);
      hqify(r.continuationContents.gridContinuation.items);
      addLongPress(r.continuationContents.gridContinuation.items);
      addPreviews(r.continuationContents.gridContinuation.items);
      r.continuationContents.gridContinuation.items = hideVideo(r.continuationContents.gridContinuation.items);
    }

    if (r?.contents?.tvBrowseRenderer?.content?.tvSecondaryNavRenderer?.sections) {
      for (let i = 0; i < r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections.length; i++) {
        const section = r.contents.tvBrowseRenderer.content.tvSecondaryNavRenderer.sections[i].tvSecondaryNavSectionRenderer;
        if (!section || !section.tabs) continue;

        if (configRead('sortSubscriptionsByAlphabet')) {
          section.tabs.sort((a: any, b: any) => {
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
            content.gridRenderer.items = dropHidden(content.gridRenderer.items);
            deArrowify(content.gridRenderer.items);
            hqify(content.gridRenderer.items);
            addLongPress(content.gridRenderer.items);
            addPreviews(content.gridRenderer.items);
            content.gridRenderer.items = hideVideo(content.gridRenderer.items);
          }
        }
      }
    }

    if (r?.contents?.singleColumnWatchNextResults?.pivot?.sectionListRenderer) {
      if (!signinReminderEnabled) {
        r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents =
          r.contents.singleColumnWatchNextResults.pivot.sectionListRenderer.contents.filter(
            (elm: any) => !elm.alertWithActionsRenderer
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
        r.playerOverlays.playerOverlayRenderer.timelyActionRenderers.filter((a: any) => a?.timelyActionRenderer?.type !== 'TIMELY_ACTION_TYPE_SHOPPING' &&
                                                                                a?.timelyActionRenderer?.type !== 'TIMELY_ACTION_TYPE_NFL_WATERMARK');
      } else r.playerOverlays.playerOverlayRenderer.timelyActionRenderers = [];
      if (configRead('sponsorBlockManualSkips').length > 0) {
        const manualSkippedSegments = configRead('sponsorBlockManualSkips');
        if ((window?.sponsorblock as SponsorBlockSegments | null | undefined)?.segments) {
          for (const segment of (window.sponsorblock as SponsorBlockSegments).segments!) {
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
      if ((window?.sponsorblock as SponsorBlockSegments | null | undefined)?.segments) {
        const category = (window.sponsorblock as SponsorBlockSegments).segments!.find(seg => seg.category === 'poi_highlight');
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
}

const origParse = JSON.parse;
JSON.parse = function () {
  const r = origParse.apply(this, arguments as any);
  return processResponse(r, (arguments as any)[0]);
};

/**
 * A deep copy that does NOT re-enter this module.
 *
 * `JSON.parse(JSON.stringify(x))` is the idiom the tile helpers used, and after
 * the line above it means the patched parse -- so every clone of a single tile
 * ran the entire response pass again: the ad prune, the shelf walk, DeArrow.
 * The `processed` WeakSet cannot stop it either, because a clone is by
 * definition an object the set has never seen. Captured before the patch, so
 * this is the engine's own parse.
 */
function cloneJson<T>(value: T): T {
  return origParse(JSON.stringify(value));
}

/**
 * The same treatment for fetch responses read with .json().
 *
 * JSON.parse was the only interception point, which is fine only while
 * YouTube's TV app reads InnerTube responses by parsing text it already holds.
 * When it reads them with Response.json() the parsing happens inside the engine
 * and never touches JSON.parse -- so every payload taking that route arrived
 * with its ads intact and none of the mod's rewriting applied, with nothing on
 * screen to say so.
 *
 * Wrapped rather than replaced, and non-JSON bodies are left exactly as they
 * were: this sits in front of every fetch the page makes.
 */
const origResponseJson = Response.prototype.json;
Response.prototype.json = function (this: Response, ...args: unknown[]) {
  return (origResponseJson as any).apply(this, args).then((value: any) => {
    try {
      return processResponse(value);
    } catch (e) {
      console.error('An error occured while processing a fetch response:', e);
      return value;
    }
  });
};

// Fix playback issues

const origStringify = JSON.stringify;
JSON.stringify = function (value: any, replacer?: any, space?: any) {
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

  // Only count quiet passes once the registry actually exists -- otherwise the
  // passes taken before _yttv appears count as "needed nothing", and the loop
  // can settle on the very first pass that sees it.
  jsonPatchQuietPasses = !sawModules ? 0 : (applied ? 0 : jsonPatchQuietPasses + 1);

  // Modules keep appearing as the app boots and as surfaces are opened, so this
  // runs until the registry exists and has needed nothing for five seconds.
  // Capped at a minute, after which it either worked or never will.
  const settled = sawModules && jsonPatchQuietPasses >= 20;
  if (++jsonPatchAttempts < 240 && !settled) {
    setTimeout(patchYttvJson, 250);
  }
}

patchYttvJson();


function processShelves(shelves: any[], shouldAddPreviews = true) {
  // Walked backwards because the Shorts branch below splices this same array:
  // forwards, removing index i makes the iterator's next read skip what was at
  // i + 1, so the shelf after a removed Shorts shelf was never processed.
  for (let i = shelves.length - 1; i >= 0; i--) {
    const shelve = shelves[i];
    if (shelve.shelfRenderer) {
      if (!shelve.shelfRenderer.content?.horizontalListRenderer?.items) continue;
      shelve.shelfRenderer.content.horizontalListRenderer.items = dropHidden(shelve.shelfRenderer.content.horizontalListRenderer.items);
      deArrowify(shelve.shelfRenderer.content.horizontalListRenderer.items);
      hqify(shelve.shelfRenderer.content.horizontalListRenderer.items);
      addLongPress(shelve.shelfRenderer.content.horizontalListRenderer.items);
      if (shouldAddPreviews) {
        addPreviews(shelve.shelfRenderer.content.horizontalListRenderer.items);
      }
      shelve.shelfRenderer.content.horizontalListRenderer.items = hideVideo(shelve.shelfRenderer.content.horizontalListRenderer.items);
      if (!configRead('enableShorts')) {
        if (shelve.shelfRenderer.tvhtml5ShelfRendererType === 'TVHTML5_SHELF_RENDERER_TYPE_SHORTS') {
          shelves.splice(i, 1);
          continue;
        }
        shelve.shelfRenderer.content.horizontalListRenderer.items = shelve.shelfRenderer.content.horizontalListRenderer.items.filter((item: any) => item.tileRenderer?.tvhtml5ShelfRendererType !== 'TVHTML5_TILE_RENDERER_TYPE_SHORTS');

        shelve.shelfRenderer.content.horizontalListRenderer.items = shelve.shelfRenderer.content.horizontalListRenderer.items.filter((item: any) => !item.tileRenderer?.onSelectCommand?.reelWatchEndpoint);
      }

      // A shelf every filter emptied is worse than one that was never there:
      // the heading still renders, so "Continue watching" sits above a blank
      // strip and reads as a failed load rather than as a filter doing its job.
      // The Shorts branch above only splices shelves the app TYPED as Shorts, so
      // a mixed shelf whose items all turned out to be reels, or one whose tiles
      // hideVideo removed as watched, ends up here.
      //
      // Never the last one: a surface with no shelves at all is a worse outcome
      // than one empty heading, and it is indistinguishable from a broken feed.
      if (shelfIsEmpty(shelve) && shelves.length > 1) {
        shelves.splice(i, 1);
      }
    }
  }
}

function addPreviews(items: any[]) {
  if (!configRead('enablePreviews')) return;
  if (!Array.isArray(items)) return;
  const muted = configRead('mutePreviews');
  for (const item of items) {
    // Every guard now lives in previewableTile(), which a Node harness covers
    // directly. It also adds two the inline version did not have: a tile that
    // already carries our command (so a payload reaching both JSON.parse and
    // Response.json cannot be processed twice), and a tile whose select command
    // is not a watchEndpoint -- a channel or playlist tile, where an inline
    // playback command cannot start anything and, now that there is an
    // indicator, would claim something is playing when nothing is.
    if (!previewableTile(item)) continue;
    // Cloned through the captured parse, not the patched one.
    const endpoint = cloneJson(item.tileRenderer.onSelectCommand);
    item.tileRenderer.onFocusCommand = startInlinePlayback(endpoint, {
      durationMs: DEFAULT_PREVIEW_DURATION_MS,
      muted,
    });
  }
}

function deArrowify(items: any[]) {
  // Backwards, for the same reason as processShelves: splicing forwards skipped
  // an ad tile sitting directly after another ad tile.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.adSlotRenderer) {
      items.splice(i, 1);
      continue;
    }
    if (!item.tileRenderer) continue;
    if (configRead('enableDeArrow')) {
      const videoID = item.tileRenderer.contentId;
      // One request per video rather than one per tile. This used to fire an
      // uncached, undeduplicated fetch for every tile it walked -- on the order
      // of a hundred and fifty outbound requests for a first home screen, again
      // for every continuation, and twice for a video appearing on two shelves.
      //
      // The response shape is also read defensively now: `data.titles.length`
      // threw for the 404 that is the normal answer for a video nobody has
      // submitted branding for, and the throw landed in the .catch() below,
      // where it was indistinguishable from a network failure.
      fetchBranding(videoID).then(data => {
        if (!data) return;
        const title = bestTitle(data);
        if (title && item.tileRenderer?.metadata?.tileMetadataRenderer?.title) {
          item.tileRenderer.metadata.tileMetadataRenderer.title.simpleText = title;
        }

        if (configRead('enableDeArrowThumbnails')) {
          const time = bestThumbnailTime(data);
          if (time !== null && item.tileRenderer?.header?.tileHeaderRenderer?.thumbnail) {
            item.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails = [
              {
                url: `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${encodeURIComponent(videoID)}&time=${time}`,
                width: 1280,
                height: 720
              }
            ]
          }
        }
      }).catch(() => { });
    }
  }
}


function hqify(items: any[]) {
  if (!Array.isArray(items)) return;
  if (!configRead('enableHqThumbnails')) return;
  for (const item of items) {
    if (!item?.tileRenderer) continue;
    if (item.tileRenderer.style !== TILE_STYLE_DEFAULT) continue;
    const thumbnail = item.tileRenderer.header?.tileHeaderRenderer?.thumbnail;
    // Pick the largest entry YouTube actually served, rather than synthesising
    // a URL. The synthesised one was `.../sddefault.jpg` at a declared 640x480:
    // a 4:3 frame announced as fact to a renderer laying out a 16:9 tile, and
    // carrying a query string lifted from a DIFFERENT variant's URL -- an `sqp`
    // parameter is signed for the image it was issued for, so re-attaching one
    // can fail validation and render nothing at all. bestThumbnail returns
    // something the payload already contained, so it can neither 404 nor fail a
    // signature check; when the payload holds only one entry it is a no-op,
    // which is the right way for this to fail.
    const best = bestThumbnail(thumbnail?.thumbnails);
    if (!best) continue;
    thumbnail.thumbnails = [best];
  }
}

/**
 * The suppression rows the mod appends to a tile's long-press menu.
 *
 * The serviceEndpoint has to be one of six kinds the app will render --
 * RENDERABLE_SERVICE_ENDPOINTS lists them, resolved out of the shipped bundle --
 * or the row is dropped with nothing on screen to say so.
 * `playlistEditEndpoint.customAction` is the one ADD_TO_QUEUE already rides and
 * that resolveCommand.ts already intercepts, so it is the proven vehicle.
 */
function suppressionRows(tile: any): any[] {
  const offered = offeredRows(tile, configRead('enableHideRecommendations'));
  if (!offered.video && !offered.channel) return [];
  const identity = tileIdentity(tile);
  const rows: any[] = [];
  if (offered.video) {
    const title = tile?.metadata?.tileMetadataRenderer?.title?.simpleText;
    rows.push(MenuServiceItemRenderer(t('longPress.hideVideo'), {
      clickTrackingParams: null,
      playlistEditEndpoint: {
        customAction: {
          action: 'TT_HIDE_VIDEO',
          parameters: { videoId: identity.videoId, title: typeof title === 'string' ? title : '' },
        },
      },
    }));
  }
  if (offered.channel) {
    rows.push(MenuServiceItemRenderer(
      t('longPress.hideChannel', { channel: identity.channel?.name || identity.channel?.handle || '' }), {
      clickTrackingParams: null,
      playlistEditEndpoint: {
        customAction: {
          action: 'TT_HIDE_CHANNEL',
          parameters: { entry: channelEntry(identity.channel), videoId: identity.videoId },
        },
      },
    }));
  }
  return rows;
}

function addLongPress(items: any[]) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const tile = item?.tileRenderer;
    if (!tile) continue;
    if (tile.style !== TILE_STYLE_DEFAULT) continue;

    // The live path. Every one of the 223 default tiles in the captured browse
    // responses arrived with a server-supplied menu, so this branch is what
    // actually runs -- and it runs BEFORE the enableLongPress check below, which
    // is why that setting does not control whether long press works. It only
    // controls whether a menu is synthesised for a tile that arrived without one.
    //
    // Read through menuItems(), which prefers tileRenderer.menu exactly as the
    // app does: appending to the showMenuCommand's list on a tile that has both
    // adds rows to a list nothing renders.
    const existing = menuItems(tile);
    if (existing) {
      const copiedItem = cloneJson(item);
      existing.push(MenuServiceItemRenderer(t('longPress.addToQueue'), {
        clickTrackingParams: null,
        playlistEditEndpoint: {
          customAction: {
            action: 'ADD_TO_QUEUE',
            parameters: copiedItem
          }
        }
      }));
      for (const row of suppressionRows(tile)) existing.push(row);
      continue;
    }

    if (!configRead('enableLongPress')) continue;
    // A showMenuCommand with no items is left alone rather than overwritten: it
    // carries the server's own title, subtitle, thumbnail and contentId, and the
    // wholesale assignment at the end of this function would discard all of them.
    if (tile.onLongPressCommand?.showMenuCommand) continue;
    const metadata = tile.metadata?.tileMetadataRenderer;
    if (!metadata) continue;
    if (!tile.header?.tileHeaderRenderer?.thumbnail?.thumbnails) continue;
    if (!tile.onSelectCommand?.watchEndpoint) continue;
    const copiedItem = cloneJson(item);
    const subtitleNode = copiedItem.tileRenderer.metadata.tileMetadataRenderer.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text;
    if (!subtitleNode) continue;
    // Both of these were unguarded reads. `.title.simpleText` assumed a title on
    // a metadata object only proved to exist, and `subtitle.runs[0].text`
    // assumed a non-empty runs array -- an empty one is truthy. Either throw is
    // swallowed by processResponse's catch, which abandons EVERY remaining
    // transform for the whole payload: the grid pass, the endscreen removal, the
    // settings patch, the watch-next shelves. One malformed tile costs all of it.
    const title = copiedItem.tileRenderer.metadata.tileMetadataRenderer.title?.simpleText;
    if (typeof title !== 'string') continue;
    const subtitle = Array.isArray(subtitleNode.runs)
      ? subtitleNode.runs[0]?.text
      : subtitleNode.simpleText;
    if (typeof subtitle !== 'string') continue;
    const data = longPressData({
      videoId: copiedItem.tileRenderer.contentId,
      thumbnails: copiedItem.tileRenderer.header.tileHeaderRenderer.thumbnail.thumbnails,
      title,
      subtitle,
      watchEndpointData: copiedItem.tileRenderer.onSelectCommand.watchEndpoint,
      item: copiedItem,
      extraRows: suppressionRows(tile),
    });
    tile.onLongPressCommand = data;
  }
}

/**
 * Drops tiles the user has hidden from this television.
 *
 * Applied before every other per-tile pass, so a hidden tile never pays for a
 * synthesised menu, an inline-preview command or a DeArrow request. Separate
 * from hideVideo(), which is page-gated and about watched progress -- a
 * different question with a different answer.
 */
function dropHidden(items: any[]): any[] {
  if (!Array.isArray(items)) return items;
  // Two independent axes, so each is read on its own: the user's own hidden
  // lists, and the members-only filter. Either can be on without the other.
  const suppressing = configRead('enableHideRecommendations');
  const videos = suppressing ? configRead('hiddenVideos') : [];
  const channels = suppressing ? configRead('hiddenChannels') : [];
  const membersOnly = configRead('hideMembersOnlyVideos');
  const aiList = configRead('enableAiSList');
  if (!videos.length && !channels.length && !membersOnly && !aiList) return items;
  return items.filter((item) => {
    const tile = item?.tileRenderer;
    if (!tile) return true;
    // Cheapest test first: reading a badge off the metadata lines needs no
    // identity at all.
    if (membersOnly && hasMembersOnlyBadge(tile)) return false;
    if (!videos.length && !channels.length && !aiList) return true;
    // Derived ONCE. tileIsHidden() derives it internally too, so calling both
    // walked every tile's menu and subtitle twice per payload.
    const identity = tileIdentity(tile);
    if (isVideoHidden(identity.videoId, videos)) return false;
    if (isChannelHidden(identity.channel, channels)) return false;
    if (aiList && isAiChannel(identity.channel)) return false;
    return true;
  });
}

function hideVideo(items: any[]) {
  return items.filter(item => {
    if (!item.tileRenderer) return true;
    const progressBar = item.tileRenderer.header?.tileHeaderRenderer?.thumbnailOverlays?.find((overlay: any) => overlay.thumbnailOverlayResumePlaybackRenderer)?.thumbnailOverlayResumePlaybackRenderer;
    if (!progressBar) return true;
    if (!configRead('enableHideWatchedVideos')) return true;
    const pages = configRead('hideWatchedVideosPages');
    if (!pages.length) return true;
    // Same derivation, moved so a harness can reach it -- plus the one case it
    // was missing. An empty hash is the home page: it is what the app has on a
    // cold launch and after a launchToOnStartup navigation that leaves none.
    // It fell through every branch to '', which matches nothing in the list, so
    // "hide watched videos on the home page" did nothing until the user had
    // navigated away and come back.
    const pageName = pageNameFromHash(location.hash);
    if (!pages.includes(pageName)) return true;

    const percentWatched = (progressBar.percentDurationWatched || 0);
    return percentWatched <= configRead('hideWatchedVideosThreshold');
  });
}

// hideVideo now honours enableHideWatchedVideos, which nothing read before --
// the feature was gated on the page list alone. Anyone who picked pages while
// the master toggle sat at its default `false` had a working feature, and the
// new gate would switch it off underneath them, so adopt their existing state.
//
// Genuinely once, hence the marker: the condition "pages set, toggle off" is
// also exactly the state of a user who has since turned the toggle off on
// purpose, and re-running would flip it back on every launch and make the
// switch impossible to use.
const HIDE_WATCHED_MIGRATION_KEY = 'tizentube.hideWatchedVideosMigrated';
try {
  if (!localStorage.getItem(HIDE_WATCHED_MIGRATION_KEY)) {
    if (configRead('hideWatchedVideosPages').length > 0 && !configRead('enableHideWatchedVideos')) {
      configWrite('enableHideWatchedVideos', true);
    }
    localStorage.setItem(HIDE_WATCHED_MIGRATION_KEY, '1');
  }
} catch (e) {
  // Storage disabled or over quota. Skipping the migration only means the
  // feature stays off until the user toggles it; failing here would abort
  // every module imported after this one.
}
