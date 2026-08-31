// Which sidebar entries to remove.
//
// NO IMPORTS, deliberately: test/refresh.mjs lifts this file verbatim and the
// harness drives it against a REAL captured tvhtml5 guide response, so what is
// asserted is what YouTube actually sends.
//
// That capture settled something the previous code got wrong. A guide payload
// holds its entries in THREE places, not one:
//
//   items    9 entries -- Search, Home, Subscriptions, Library, Music, Live,
//            Gaming, News, Sports
//   footer   1 entry  -- Settings
//   topbar   1 entry  -- Sign in
//
// customGuideAction.ts walked only `items`, so anything in the footer was never
// filtered. Nothing in the settings list targets Settings today, so the practical
// cost was nil -- but the omission was real and it is the kind that only shows up
// once someone adds an option for an entry that happens to live down there.
//
// `topbar` is deliberately NOT filtered. It carries the account row, and on a
// television an account row you have removed is not recoverable without
// reinstalling: there is no address bar to navigate around it.

/** Watch Later's playlist id is "WL" -- the app's own code compares against that
 *  literal when deciding which toast to show for a playlist edit. A guide entry
 *  for a playlist browses "VL" + the playlist id.
 *
 *  Several forms are accepted because only the "WL" half is evidenced: a
 *  signed-out guide has no Watch Later row at all, so the exact browseId of the
 *  entry could not be captured. Being wrong about one of these costs the setting
 *  doing nothing, which is why it is a list rather than a guess. */
export const WATCH_LATER_BROWSE_IDS = ['VLWL', 'FEwatch_later', 'WL'];

/** ...and the icon, as a second independent signal. */
export const WATCH_LATER_ICONS = ['WATCH_LATER', 'TAB_WATCH_LATER'];

export interface GuideOptions {
    /** iconType values the user chose to hide. */
    disabledIcons?: unknown;
    /** Remove entries that are channels -- the app gives those a thumbnail. */
    hideChannels?: boolean;
    hideWatchLater?: boolean;
}

/** Is this entry the Watch Later playlist? */
export function isWatchLaterEntry(entry: any): boolean {
    if (!entry) return false;
    const browseId = entry.navigationEndpoint?.browseEndpoint?.browseId;
    if (typeof browseId === 'string' && WATCH_LATER_BROWSE_IDS.includes(browseId)) return true;
    const icon = entry.icon?.iconType;
    return typeof icon === 'string' && WATCH_LATER_ICONS.includes(icon);
}

/**
 * Whether one entry should be removed.
 *
 * Every branch is a reason to remove; the default is to keep, so an entry shape
 * this does not understand survives.
 */
export function shouldRemoveEntry(entry: any, options: GuideOptions | null | undefined): boolean {
    if (!entry || !options) return false;

    const icons = Array.isArray(options.disabledIcons) ? options.disabledIcons : [];
    const icon = entry.icon?.iconType;
    if (icons.length && typeof icon === 'string' && icons.includes(icon)) return true;

    // A channel row is the one the app gives a thumbnail rather than an icon.
    if (options.hideChannels && entry.thumbnail) return true;

    if (options.hideWatchLater && isWatchLaterEntry(entry)) return true;

    return false;
}

/** The sections of a guide payload that are safe to filter. `topbar` is absent
 *  on purpose -- see the note at the top of this file. */
function sections(payload: any): any[] {
    const out: any[] = [];
    if (Array.isArray(payload?.items)) {
        for (const item of payload.items) {
            if (item?.guideSectionRenderer && Array.isArray(item.guideSectionRenderer.items)) {
                out.push(item.guideSectionRenderer);
            }
        }
    }
    const footer = payload?.footer?.guideSectionRenderer;
    if (footer && Array.isArray(footer.items)) out.push(footer);
    return out;
}

/**
 * Removes the entries the settings ask for, in place.
 *
 * In place because the app reads the same object this was parsed into. Returns
 * how many were removed, which is what the harness measures.
 */
export function filterGuide(payload: any, options: GuideOptions | null | undefined): number {
    if (!payload || !options) return 0;
    let removed = 0;
    for (const section of sections(payload)) {
        // Backwards, so a splice cannot make the iterator skip the entry that
        // moved into the vacated index -- the same trap processShelves records.
        for (let i = section.items.length - 1; i >= 0; i--) {
            const entry = section.items[i]?.guideEntryRenderer;
            if (!entry) continue;
            if (shouldRemoveEntry(entry, options)) {
                section.items.splice(i, 1);
                removed++;
            }
        }
    }
    return removed;
}

/** Does this payload look like a guide response at all? */
export function isGuidePayload(payload: any): boolean {
    if (!payload || !Array.isArray(payload.items)) return false;
    return payload.items.some((item: any) => item?.guideSectionRenderer);
}
