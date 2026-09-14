// Every setting the panel is supposed to expose, reachable by walking it.
//
// WRITTEN BEFORE THE SETTINGS TREE WAS REORGANISED, deliberately, so that what
// it asserts was not shaped by the result. Moving seventy-six rows between
// categories is exactly the operation that drops one on the floor, and nothing
// else in the suite would notice: drive.mjs checks that the menus it CAN reach
// are well-formed, which is silent about a row that stopped being reachable at
// all. A setting still in defaultConfig, still read by its feature, and no
// longer anywhere in the panel is invisible from the inside.
//
// The expected set is defaultConfig minus the keys that are deliberately not
// user-facing, each named with its reason. A new setting therefore fails this
// harness until it is either put in the panel or declared internal here -- which
// is the useful default, because "I added the setting and forgot the row" is the
// common mistake and it is otherwise only found on a television.
import * as stubs from './stubs.mjs';
import modernUI, { optionShow } from './settings.generated.mts';
import { readRepo, checker } from '../lib/repo.mjs';

const cfg = readRepo('mods', 'config.ts');
const body = cfg.match(/const defaultConfig = \{([\s\S]*?)\n\};/)[1];
const ALL = [];
for (const line of body.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*?),\s*$/);
    if (!m) continue;
    let [, k, v] = m;
    v = v.replace(/\s+as\s+[A-Za-z[\]]+$/, '');
    ALL.push(k);
    try {
        stubs.store[k] = eval(`(${v})`);
    } catch {
        stubs.store[k] = v;
    }
}
globalThis.window = { h5vcc: undefined };
globalThis.localStorage = {};

// Not rows, and why. Written by the mod itself rather than chosen by anyone, so
// absence from the panel is correct.
const INTERNAL = {
    videoSpeed: 'the current playback rate, set from the player, not a preference',
    dontCheckUpdateUntil: 'a timestamp the updater writes to back off after a check',
    lastAnnouncementCheck: 'a timestamp the announcement fetch writes',
};

// Rows that exist but cannot appear in THIS environment, and why. Kept separate
// from INTERNAL because the reason is different and so is what a change means:
// an internal key should never gain a row, whereas one of these is a row a real
// television may or may not show.
const PLATFORM = {
    autoFrameRate: 'gated on window.h5vcc.tizentube.SetFrameRate, the Cobalt bridge',
    autoFrameRatePauseVideoFor: 'same gate as autoFrameRate',
    // Checked rather than assumed, because the row being absent on Tizen looks
    // exactly like the version-row bug that was fixed earlier: features/updater.ts
    // reads window.h5vcc.tizentube.GetVersion() to learn what is installed and
    // dispatches the Cobalt CHECK_FOR_UPDATES action, and its startup check at
    // updater.ts:30 is itself gated the same way. Without that bridge the setting
    // would do nothing, so hiding the whole category is right, not a defect.
    enableUpdater: 'the updater needs window.h5vcc.tizentube.GetVersion; inert without it',
};

// Some rows only exist once their list has a member -- an empty "Hidden videos"
// submenu has nothing to walk. Seeded rather than exempted, so the assertion
// stays real: an exemption would pass just as happily if the row were deleted.
stubs.store.hiddenVideos = ['dQw4w9WgXcQ A video'];
stubs.store.hiddenChannels = ['UCuAXFkgsw1L7xaCfnd5JJOw A channel'];
stubs.store.captionsOnChannels = ['UCuAXFkgsw1L7xaCfnd5JJOw A channel'];
stubs.store.captionsOffChannels = ['UCBJycsmduvYEL83R_U4JriQ Another channel'];
stubs.store.sponsorBlockDisabledChannels = ['UCBJycsmduvYEL83R_U4JriQ Another channel'];

const { check, done } = checker();

// Walk the panel the way a user does, following OPTIONS_SHOW, and collect every
// setting any row writes.
const found = new Set();
let menus = 0;
function walk(render, path, depth) {
    // Bounded the way drive.mjs bounds it. A row's title can carry its current
    // value, so a visited-set keyed on the label does not converge -- the path
    // does, and the counter is the backstop for a menu that rebuilds itself.
    if (depth > 8 || menus > 400) return;
    menus++;
    stubs.modals.length = 0;
    render();
    const modal = stubs.modals[0];
    if (!modal) return;
    const items =
        modal.content?.overlayPanelItemListRenderer?.items ||
        modal.content?.scrollPaneRenderer?.content?.scrollPaneItemListRenderer?.items ||
        [];
    for (const item of items) {
        const link = item.compactLinkRenderer;
        if (!link) continue;
        const cmds = link.serviceEndpoint?.commandExecutorCommand?.commands || [];

        // A row that writes a setting is a leaf for this walk. It ALSO carries an
        // OPTIONS_SHOW -- that is how a radio row repaints its own menu or its
        // parent after a choice -- so following it re-renders the menu we are
        // already in and never terminates. The first draft of this did exactly
        // that: 401 menus visited, four settings found, the cap doing the only
        // stopping. Record what it writes and do not descend.
        const keys = cmds
            .map((c) => c?.setClientSettingEndpoint?.settingDatas?.[0]?.clientSettingEnum?.item)
            .filter(Boolean);
        if (keys.length) {
            for (const k of keys) found.add(k);
            continue;
        }

        const open = cmds.find((c) => c?.customAction?.action === 'OPTIONS_SHOW');
        if (!open) continue;
        const child = [...path, link.title?.simpleText];
        if (path.includes(link.title?.simpleText)) continue;
        const p = open.customAction.parameters;
        walk(() => optionShow(p, p.update), child, depth + 1);
    }
}
walk(() => modernUI(), ['root'], 0);

// The walk has to actually reach things, or every assertion below is vacuous.
check('the walk reaches the panel', found.size > 40, true);

const expected = ALL.filter((k) => !Object.hasOwn(INTERNAL, k) && !Object.hasOwn(PLATFORM, k));
check(
    'every user-facing setting has a row',
    expected.filter((k) => !found.has(k)),
    [],
);
// The other direction: a row writing something defaultConfig does not declare is
// a typo that silently does nothing, which is the defect ConfigKey exists for.
check(
    '  ...and every row writes a real setting',
    [...found].filter((k) => !ALL.includes(k)),
    [],
);
// A key parked in INTERNAL that has since been given a row means the exemption
// outlived its reason; one that left defaultConfig entirely means it is stale.
check(
    'no internal exemption is stale',
    Object.keys(INTERNAL).filter((k) => !ALL.includes(k) || found.has(k)),
    [],
);
check(
    '  ...nor any platform one',
    Object.keys(PLATFORM).filter((k) => !ALL.includes(k) || found.has(k)),
    [],
);

done(
    `ALL PASS (${found.size} settings reachable, ` +
        `${Object.keys(INTERNAL).length} internal, ${Object.keys(PLATFORM).length} platform-gated)`,
);
