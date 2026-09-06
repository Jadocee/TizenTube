// The two redraw entry points settings.js exports. Recorded rather than run:
// what this harness is about is whether the WRITE reaches the config, and a real
// redraw would drag the whole settings tree in behind it.
export const redraws = [];
export default function modernUI(update, parameters) {
    redraws.push({ kind: 'modernUI', update, parameters });
}
export function optionShow(parameters, update) {
    redraws.push({ kind: 'optionShow', parameters, update });
}
