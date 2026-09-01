import { configChangeEmitter, configRead } from '../config.js';
import getCommandExecutor from './customCommandExecution.js';
import { filterGuide, isGuidePayload } from '../features/guideFilter.js';

const origParse = JSON.parse;
JSON.parse = function () {
    // `Function` is exactly right here: this forwards an unknown call verbatim to
    // the JSON.parse it wrapped, so the cast has to admit any signature. Naming
    // one would be a claim about a function this module does not own.
    // biome-ignore lint/complexity/noBannedTypes: forwards an unknown signature
    const r = (origParse as Function).apply(this, arguments);

    try {
        // The decision moved into features/guideFilter.ts so a harness can drive
        // it against a real captured guide payload. That capture is also what
        // established the footer section, which this walk used to miss entirely:
        // a guide response holds its entries in `items` (9), `footer` (Settings)
        // and `topbar` (the account row), and only the first was ever filtered.
        if (isGuidePayload(r)) {
            filterGuide(r, {
                disabledIcons: configRead('disabledSidebarContents'),
                hideChannels: configRead('disableChannelsOnSidebar'),
                hideWatchLater: configRead('hideWatchLaterInSidebar'),
            });
        }
    } catch (e) {
        console.error('An error occured while processing the guide JSON:', e);
    }

    return r;
};

configChangeEmitter.addEventListener('configChange', (e) => {
    if (
        e.detail.key === 'disabledSidebarContents' ||
        e.detail.key === 'disableChannelsOnSidebar' ||
        e.detail.key === 'hideWatchLaterInSidebar'
    ) {
        const commandExecutor = getCommandExecutor();
        if (commandExecutor) {
            commandExecutor.executeFunction(
                new commandExecutor.commandFunction('reloadGuideAction'),
            );
        }
    }
});
