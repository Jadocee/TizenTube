import { readRepo } from '../lib/repo.mjs';
import { readFileSync } from 'fs';
const en = JSON.parse(readRepo('mods', 'translations', 'resources', 'en.json'));
export function t(key, opts) {
  let node = en;
  for (const part of key.split('.')) { node = node?.[part]; if (node === undefined) return key; }
  if (typeof node !== 'string') return key;
  return opts ? node.replace(/\{\{(\w+)\}\}/g, (_, k) => opts[k]) : node;
}

export const store = {};
export function configRead(k) {
  if (!(k in store)) { missing.add(k); }
  return store[k];
}
export const missing = new Set();
export function configWrite(k, v) { store[k] = v; }
export const configChangeEmitter = { addEventListener(){}, removeEventListener(){}, dispatchEvent(){} };

export const modals = [];
export function showModal(header, content, id, update) { modals.push({ header, content, id, update }); }
export function overlayPanelItemListRenderer(items, selectedIndex) { return { overlayPanelItemListRenderer: { items, selectedIndex } }; }
export function buttonItem(title, icon, commands) {
  const b = { compactLinkRenderer: { serviceEndpoint: { commandExecutorCommand: { commands } } } };
  if (title) b.compactLinkRenderer.title = { simpleText: title.title };
  if (title.subtitle) b.compactLinkRenderer.subtitle = { simpleText: title.subtitle };
  if (icon) b.compactLinkRenderer.icon = { iconType: icon.icon };
  if (icon && icon.secondaryIcon) b.compactLinkRenderer.secondaryIcon = { iconType: icon.secondaryIcon };
  return b;
}
export const scrollPaneRenderer = (items) => ({ scrollPaneRenderer: { content: { scrollPaneItemListRenderer: { items } } } });
export const overlayMessageRenderer = (simpleText) => ({ overlayMessageRenderer: { title: { simpleText } } });
export const QrCodeRenderer = (url) => ({ qrCodeRenderer: { qrCodeImage: { thumbnails: [{ url }] } } });
export const qrcode = { qrcode: () => ({ addData(){}, make(){}, createImgTag: () => 'src="data:image/gif;base64,AAA"' }) };

// --- videoContext -----------------------------------------------------------
// The SponsorBlock channel opt-out builds its rows from whatever is playing, so
// the walk needs a channel to find. Set nowPlaying to null to exercise the
// nothing-is-playing case.
export let nowPlaying = { id: 'UCtestchannelid00000001', name: 'Test Channel' };
export const setNowPlaying = (v) => { nowPlaying = v; };
export const channelOf = () => nowPlaying;
export const channelEntry = (c) => `${c.id} ${c.name}`;
export const parseChannelEntry = (entry) => {
    const space = entry.indexOf(' ');
    return space < 0 ? { id: entry, name: entry } : { id: entry.slice(0, space), name: entry.slice(space + 1) };
};

// features/aisList.js -- the settings screen reads its status for a subtitle.
export const aisListStatus = () => ({ block: 0, warn: 0, lastModified: null, fetchedAt: 0 });
