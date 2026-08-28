import initPatches from "./features/standaloneUserscript.js";
if (window.location.hostname === 'localhost') {
    initPatches();
}
import "./features/userAgentSpoofing.js";
import "whatwg-fetch";
import "core-js/proposals/object-getownpropertydescriptors";
// The build targets Chrome 47 and preset-env transpiles syntax only, so
// anything newer than ES6 has to be polyfilled by hand. Array.prototype.flat
// is reached on every spatial-navigation search, i.e. every D-pad press
// inside the theme panel.
import "core-js/es/array/flat";
import "core-js/es/object/values";
import "core-js/es/object/entries";

import './translations/index.js'
import "./domrect-polyfill";
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