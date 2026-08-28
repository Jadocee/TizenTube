import initPatches from "./features/standaloneUserscript.js";
if (window.location.hostname === 'localhost') {
    initPatches();
}
import "./features/userAgentSpoofing.js";

// No built-in polyfills. The target is Tizen 9.0, whose engine is Chromium
// M120, and rolldown lowers syntax to chrome120 -- fetch, DOMRect,
// Object.values/entries/getOwnPropertyDescriptors and Array.prototype.flat are
// all native there. tsconfig.json pins `lib` to ES2023 so that using anything
// M120 does NOT have is a compile error rather than a black screen on a TV.
//
// spatial-navigation-polyfill is not in this category: spatial navigation is a
// draft spec that no Chromium ships, so it stays.

import './translations/index.js'
import "./features/adblock.js";
import "./features/sponsorblock.js";
import "./ui/ui.js";
import "./ui/speedUI.js";
import "./ui/theme.js";
import "./ui/settings.js";
import "./ui/disableWhosWatching.js";
import "./features/moreSubtitles.js";
import "./features/updater.js";
import "./features/pictureInPicture.js";
import "./features/preferredVideoQuality.js";
import "./features/videoQueuing.js";
import "./features/enableFeatures.js";
import "./ui/customUI.js";
import "./ui/customGuideAction.js";
import "./features/autoFrameRate.js";
import "./ui/clock.js";
