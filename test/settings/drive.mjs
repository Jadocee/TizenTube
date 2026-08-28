import { readFileSync } from 'fs';
import * as stubs from './stubs.mjs';
import modernUI, { optionShow } from './settings.generated.mts';
import { repoPath, readRepo } from '../lib/repo.mjs';

// Seed the store from the real defaultConfig.
const cfg = readRepo('mods', 'config.ts');
const body = cfg.match(/const defaultConfig = \{([\s\S]*?)\n\};/)[1];
for (const line of body.split('\n')) {
  const m = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*?),\s*$/);
  if (!m) continue;
  let [, k, v] = m;
  v = v.replace(/\s+as\s+[A-Za-z\[\]]+$/, '');
  try { stubs.store[k] = eval(`(${v})`); } catch { stubs.store[k] = v; }
}
globalThis.window = { h5vcc: undefined };
globalThis.localStorage = {};

// Walk every menu the way a user would, following OPTIONS_SHOW commands.
const problems = [];
const seenMenuIds = new Map();
let menus = 0, rows = 0, maxDepth = 0, radioRows = 0, radioWithParentRefresh = 0, radioSelfRefresh = 0;

function commandsOf(item) {
  return item?.compactLinkRenderer?.serviceEndpoint?.commandExecutorCommand?.commands || [];
}

function walk(render, label, depth, path, parentMenuId) {
  if (depth > 8) { problems.push(`depth>8 at ${label}`); return; }
  if (menus > 400) { return; }
  maxDepth = Math.max(maxDepth, depth);
  stubs.modals.length = 0;
  render();
  if (stubs.modals.length !== 1) { problems.push(`${label}: emitted ${stubs.modals.length} modals`); return; }
  const modal = stubs.modals[0];
  menus++;

  const header = modal.header;
  const title = typeof header === 'string' ? header : header?.title;
  if (!title) problems.push(`${label}: modal has no title`);
  if (title === 'TizenTube Settings' && depth > 0) problems.push(`${label}: submenu falls back to the root title`);
  if (modal.id) {
    const prev = seenMenuIds.get(modal.id);
    if (prev && prev !== label) problems.push(`menuId "${modal.id}" used by both "${prev}" and "${label}"`);
    seenMenuIds.set(modal.id, label);
  }

  const items = modal.content?.overlayPanelItemListRenderer?.items
             || modal.content?.scrollPaneRenderer?.content?.scrollPaneItemListRenderer?.items || [];
  const sel = modal.content?.overlayPanelItemListRenderer?.selectedIndex;
  if (sel !== undefined && (sel < 0 || (items.length && sel >= items.length)))
    problems.push(`${label}: selectedIndex ${sel} out of range (${items.length} items)`);

  for (const item of items) {
    const link = item.compactLinkRenderer;
    if (!link) continue;
    rows++;
    if (!link.title?.simpleText) problems.push(`${label}: a row has no title`);
    const cmds = commandsOf(item);
    if (!cmds.length) problems.push(`${label}/${link.title?.simpleText}: row has no commands`);
    for (const c of cmds) {
      if (c === null || c === undefined) problems.push(`${label}/${link.title?.simpleText}: null command survived`);
    }
    // A row that writes a setting also carries an OPTIONS_SHOW (self-refresh or
    // parent-refresh); only follow rows that purely navigate.
    const writes = cmds.some(c => c?.setClientSettingEndpoint);
    if (writes) {
      const back = cmds.some(c => c?.signalAction?.signal === 'POPUP_BACK');
      const refresh = cmds.find(c => c?.customAction?.action === 'OPTIONS_SHOW');
      if (link.secondaryIcon?.iconType?.startsWith('RADIO_BUTTON')) {
        radioRows++;
        if (back && refresh) { radioWithParentRefresh++;
          if (!refresh.customAction.parameters?.options) problems.push(`${label}/${link.title?.simpleText}: parent refresh has no options`);
          if (refresh.customAction.parameters?.update !== true) problems.push(`${label}/${link.title?.simpleText}: parent refresh is not an update`);
          if (refresh.customAction.parameters?.menuId === modal.id) problems.push(`${label}/${link.title?.simpleText}: parent refresh points at its own menu`);
          if (refresh.customAction.parameters?.menuId !== parentMenuId) problems.push(`${label}/${link.title?.simpleText}: parent refresh targets "${refresh.customAction.parameters?.menuId}" but was opened from "${parentMenuId}"`);
          const pi = refresh.customAction.parameters?.selectedIndex;
          if (typeof pi !== 'number' || pi < 0) problems.push(`${label}/${link.title?.simpleText}: parent refresh has a bad selectedIndex`);
        } else if (!back && refresh) { radioSelfRefresh++; }
        else problems.push(`${label}/${link.title?.simpleText}: radio row has neither refresh path`);
      }
      continue;
    }
    const open = cmds.find(c => c?.customAction?.action === 'OPTIONS_SHOW');
    if (!open) continue;
    const p = open.customAction.parameters;
    const child = `${label} > ${link.title.simpleText}`;
    if (path.includes(child)) continue;
    walk(() => optionShow(p, p.update), child, depth + 1, [...path, child], modal.id);
  }
}

walk(() => modernUI(), 'root', 0, ['root'], undefined);

console.log(`menus=${menus} rows=${rows} maxDepth=${maxDepth}`);
console.log(`radio rows=${radioRows}  refresh-parent=${radioWithParentRefresh}  refresh-self=${radioSelfRefresh}`);
console.log(`config keys read but absent from defaultConfig: ${[...stubs.missing].join(', ') || 'none'}`);
console.log(problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'NO STRUCTURAL PROBLEMS');
process.exit(problems.length ? 1 : 0);
