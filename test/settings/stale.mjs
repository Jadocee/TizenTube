import { readFileSync } from 'fs';
import * as stubs from './stubs.mjs';
import modernUI, { optionShow } from './settings.generated.mts';
import { repoPath, readRepo } from '../lib/repo.mjs';

const cfg = readRepo('mods', 'config.ts');
for (const line of cfg.match(/const defaultConfig = \{([\s\S]*?)\n\};/)[1].split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*?),\s*$/);
    if (!m) continue;
    const raw = m[2].replace(/\s+as\s+[A-Za-z[\]]+$/, '');
    try {
        stubs.store[m[1]] = eval(`(${raw})`);
    } catch {
        stubs.store[m[1]] = raw;
    }
}
globalThis.window = { h5vcc: undefined };

const render = (fn) => {
    stubs.modals.length = 0;
    fn();
    return stubs.modals[0];
};
const items = (m) => m.content?.overlayPanelItemListRenderer?.items || [];
const row = (m, name) => items(m).find((i) => i.compactLinkRenderer?.title?.simpleText === name);
const cmds = (r) => r.compactLinkRenderer.serviceEndpoint.commandExecutorCommand.commands;
const openParams = (r) =>
    cmds(r).find((c) => c?.customAction?.action === 'OPTIONS_SHOW').customAction.parameters;

// Apply a command list the way resolveCommand's loop does.
function apply(list) {
    const events = [];
    for (const c of list) {
        if (c?.setClientSettingEndpoint) {
            for (const d of c.setClientSettingEndpoint.settingDatas) {
                const vk = Object.keys(d).find((k) => k.includes('Value'));
                stubs.configWrite(
                    d.clientSettingEnum.item,
                    vk === 'intValue' ? Number(d[vk]) : d[vk],
                );
                events.push(`write ${d.clientSettingEnum.item}=${JSON.stringify(d[vk])}`);
            }
        } else if (c?.signalAction?.signal === 'POPUP_BACK') {
            events.push('POPUP_BACK');
        } else if (c?.customAction?.action === 'OPTIONS_SHOW') {
            events.push(
                `OPTIONS_SHOW(${c.customAction.parameters.menuId}, update=${c.customAction.parameters.update})`,
            );
            stubs.modals.length = 0;
            optionShow(c.customAction.parameters, c.customAction.parameters.update);
        }
    }
    return { events, modal: stubs.modals[0] };
}

let fail = 0;
function check(desc, got, want) {
    const ok = got === want;
    if (!ok) fail++;
    console.log(
        `${ok ? '  ok  ' : 'FAIL  '}${desc}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
    );
}

// --- Scenario: UI Settings > Screen Dimming > Dimming Timeout -------------
const root = render(() => modernUI());
const ui = render(() => {
    const p = openParams(row(root, 'User Interface Settings'));
    optionShow(p, p.update);
});
const dimRow = row(ui, 'Screen Dimming');
const dim = render(() => {
    const p = openParams(dimRow);
    optionShow(p, p.update);
});

const timeoutRow = row(dim, 'Dimming Timeout');
check(
    'Dimming Timeout row shows the stored value',
    timeoutRow.compactLinkRenderer.subtitle?.simpleText,
    '1 minute',
);

const timeoutMenuParams = openParams(timeoutRow);
check('its list opens on the stored value', timeoutMenuParams.selectedIndex, 3);

const timeoutMenu = render(() => optionShow(timeoutMenuParams, timeoutMenuParams.update));
check('the list header names the setting', timeoutMenu.header.title, 'Dimming Timeout');

const fiveMin = row(timeoutMenu, '5 minutes');
check(
    'the stored choice is the checked one',
    row(timeoutMenu, '1 minute').compactLinkRenderer.secondaryIcon.iconType,
    'RADIO_BUTTON_CHECKED',
);

const result = apply(cmds(fiveMin));
console.log('        command sequence:', result.events.join(' -> '));
check('picking 5 minutes stores it', stubs.store.dimmingTimeout, 300);
check('and redraws the menu it came from', result.modal.header.title, 'Screen Dimming');
check(
    'whose row now shows the NEW value',
    row(result.modal, 'Dimming Timeout').compactLinkRenderer.subtitle?.simpleText,
    '5 minutes',
);
check(
    'and keeps focus on that row',
    result.modal.content.overlayPanelItemListRenderer.selectedIndex,
    items(dim).findIndex((i) => i.compactLinkRenderer?.title?.simpleText === 'Dimming Timeout'),
);

// --- Scenario: the codec setting that used to write the wrong key ---------
const vp = render(() => {
    const p = openParams(row(root, 'Video Player Settings'));
    optionShow(p, p.update);
});
const codecRow = row(vp, 'Preferred Video Codec');
check('codec row shows its value', codecRow.compactLinkRenderer.subtitle?.simpleText, 'Any');
const codecMenu = render(() => {
    const p = openParams(codecRow);
    optionShow(p, p.update);
});
const r2 = apply(cmds(row(codecMenu, 'AV01')));
check(
    'picking AV01 writes the key adblock.js actually reads',
    stubs.store.videoPreferredCodec,
    'av01',
);
check(
    'and the row updates',
    row(r2.modal, 'Preferred Video Codec').compactLinkRenderer.subtitle?.simpleText,
    'AV01',
);

// --- Scenario: Launch To on Startup can be cleared again -------------------
const launchRow = row(ui, 'Launch To on Startup');
const launchMenu = render(() => {
    const p = openParams(launchRow);
    optionShow(p, p.update);
});
const r3 = apply(cmds(row(launchMenu, 'Home')));
check(
    'picking Home sets a launch target',
    JSON.parse(stubs.store.launchToOnStartup).browseEndpoint.browseId,
    'FEtopics',
);
const launchMenu2 = render(() => {
    const p = openParams(row(r3.modal, 'Launch To on Startup'));
    optionShow(p, p.update);
});
check(
    'the list now opens on Home',
    items(launchMenu2).findIndex(
        (i) => i.compactLinkRenderer.secondaryIcon.iconType === 'RADIO_BUTTON_CHECKED',
    ),
    items(launchMenu2).findIndex((i) => i.compactLinkRenderer.title.simpleText === 'Home'),
);
const r4 = apply(cmds(row(launchMenu2, 'None (open where YouTube normally starts)')));
check('and None clears it again', stubs.store.launchToOnStartup, '');

console.log(fail ? `\n${fail} FAILURES` : '\nALL SCENARIOS PASS');
process.exit(fail ? 1 : 0);
