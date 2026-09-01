// Shared helpers for the harnesses. Everything resolves from this file's own
// location, so the suite runs from any working directory.

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

export const testRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const repoRoot = dirname(testRoot);

/** Absolute path to something in the repository. */
export const repoPath = (...parts) => join(repoRoot, ...parts);

/** Read a repository file as UTF-8. */
export const readRepo = (...parts) => readFileSync(repoPath(...parts), 'utf8');

/**
 * Playwright, if this machine has it. Two of the harnesses load the real
 * bundle in a real browser; on a machine without one they report as skipped
 * rather than failing, because a missing browser is not a defect in the code
 * under test.
 */
export async function chromium() {
    const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'];
    for (const spec of candidates) {
        try {
            const mod = await import(spec);
            const launcher = mod.chromium || (mod.default && mod.default.chromium);
            if (launcher) return launcher;
        } catch (e) {
            // Try the next one.
        }
    }
    return null;
}

/**
 * An explicit executable path, when the environment pins one. Returns undefined
 * so it can be spread into launch() and let Playwright resolve its own browser
 * when nothing is pinned.
 */
export function chromiumExecutable() {
    const pinned = process.env.CHROMIUM_PATH;
    if (pinned && existsSync(pinned)) return pinned;
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (base) {
        for (const rel of [
            'chromium/chrome-linux/chrome',
            'chromium-1194/chrome-linux/chrome',
            'chromium',
        ]) {
            const p = resolve(base, rel);
            if (existsSync(p)) return p;
        }
    }
    return undefined;
}

/** Tiny assertion helper. Every harness reports the same way. */
export function checker() {
    const state = { failures: 0 };
    const check = (description, got, want) => {
        const ok = JSON.stringify(got) === JSON.stringify(want);
        if (!ok) state.failures++;
        console.log(
            `${ok ? '  ok  ' : 'FAIL  '}${description.padEnd(56)} ${JSON.stringify(got)}${ok ? '' : '  want ' + JSON.stringify(want)}`,
        );
    };
    const done = (label) => {
        console.log(`\n${state.failures ? state.failures + ' FAILURES' : label || 'ALL PASS'}`);
        process.exit(state.failures ? 1 : 0);
    };
    return { check, done, state };
}

/** Marks a harness as skipped: the runner treats exit code 2 as "not run". */
export function skip(reason) {
    console.log(`SKIPPED: ${reason}`);
    process.exit(2);
}
