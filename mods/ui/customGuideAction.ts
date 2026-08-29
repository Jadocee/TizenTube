import { configChangeEmitter, configRead } from "../config.js";
import getCommandExecutor from "./customCommandExecution.js";

const origParse = JSON.parse;
JSON.parse = function () {
    const r = (origParse as Function).apply(this, arguments);

    try {
        const disabledSidebarContents = configRead('disabledSidebarContents');
        const disableChannelsOnSidebar = configRead('disableChannelsOnSidebar');
        // Any section, not just element zero. The loop below already skips
        // anything that is not a section with an items array, so the index-zero
        // test bought nothing -- and PatchSettings unshifts into this same
        // parsed object, so element zero is not reliably a guideSectionRenderer.
        if (r && Array.isArray(r.items) && r.items.some((i: any) => i?.guideSectionRenderer)) {
            for (let i = 0; i < r.items.length; i++) {
                const section = r.items[i].guideSectionRenderer;
                if (!section || !Array.isArray(section.items)) continue;
                for (let j = 0; j < section.items.length; j++) {
                    const item = section.items[j].guideEntryRenderer;
                    if (!item) continue;
                    if ((disabledSidebarContents?.length && disabledSidebarContents.includes(item.icon?.iconType))
                        || (disableChannelsOnSidebar && item?.thumbnail)) {
                        section.items.splice(j, 1);
                        j--;
                    }
                }
            }
        }

    } catch (e) {
        console.error('An error occured while processing the guide JSON:', e);
    }

    return r;
}

configChangeEmitter.addEventListener('configChange', (e) => {
    if (e.detail.key === 'disabledSidebarContents' || e.detail.key === 'disableChannelsOnSidebar') {
        const commandExecutor = getCommandExecutor();
        if (commandExecutor) {
            commandExecutor.executeFunction(new commandExecutor.commandFunction('reloadGuideAction'));
        }
    }
});