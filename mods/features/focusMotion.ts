// The switches that decide whether the home page glides between tiles or jumps.
//
// These six writes lived in one bare try/catch in ui.ts, and the first of them
// dereferenced `window.tectonicConfig!`. When YouTube had not published that
// object by the time ui.ts's <video> poll fired, line one threw and the other
// five never happened -- silently, on a device with no console. The two that
// matter most to how the surface feels, enableAnimations and
// enableListAnimations, are fourth and sixth in that list, so they were the
// first casualties.
//
// Each write is now attempted on its own, and the whole set is retried the way
// every other feature in the mod retries for the registry filling in
// progressively. Strictly subtractive: with enableFixedUI off, nothing is
// written at all, exactly as before.

import { configRead } from '../config.js';

/** One switch: where it lives on tectonicConfig, and what it should become. */
const SWITCHES: { group: 'featureSwitches' | 'clientData'; key: string; value: unknown }[] = [
    { group: 'featureSwitches', key: 'isLimitedMemory', value: false },
    { group: 'clientData', key: 'legacyApplicationQuality', value: 'full-animation' },
    { group: 'featureSwitches', key: 'enableAnimations', value: true },
    { group: 'featureSwitches', key: 'enableOnScrollLinearAnimation', value: true },
    { group: 'featureSwitches', key: 'enableListAnimations', value: true },
    { group: 'featureSwitches', key: 'supportsLongPress', value: true },
];

export const SWITCH_COUNT = SWITCHES.length;

/**
 * Applies every switch that can be applied, and reports how many landed.
 *
 * Pure with respect to everything except the object handed in, so the harness
 * drives it directly. A throwing property on one switch costs that switch and
 * nothing else -- which is the whole point, and is exactly what the previous
 * shape got wrong.
 */
export function applyFocusMotion(tectonicConfig: any, enabled: boolean): number {
    if (!enabled) return 0;
    if (!tectonicConfig || typeof tectonicConfig !== 'object') return 0;

    let applied = 0;
    for (const settings of SWITCHES) {
        try {
            const group = tectonicConfig[settings.group];
            // Absent rather than throwing: an older app build may simply not
            // have one of these groups, and that is not an error worth a warning
            // on every launch.
            if (!group || typeof group !== 'object') continue;
            group[settings.key] = settings.value;
            applied++;
        } catch (e) {
            // A getter-only or frozen property. Keep going; the rest are
            // independent.
        }
    }
    return applied;
}

let attempts = 0;

/**
 * Applies the switches, retrying while tectonicConfig is still filling in.
 *
 * Sixty seconds at 250ms, the same budget pipLoad and the JSON patcher use.
 * Stops as soon as every switch has landed, so the common case is one pass.
 */
export function startFocusMotion(): void {
    const enabled = configRead('enableFixedUI');
    if (!enabled) return;

    const applied = applyFocusMotion((window as any).tectonicConfig, true);
    if (applied === SWITCH_COUNT) return;
    if (++attempts > 240) return;
    setTimeout(startFocusMotion, 250);
}
