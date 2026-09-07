import { readFileSync } from 'node:fs';
import { defineConfig } from 'rolldown';

// The version the SETTINGS PANEL shows, taken from the repository root's
// package.json rather than mods/ -- the root one is the npm package TizenBrew
// installs, so it is the number a user can compare against the registry.
//
// This exists because the Tizen build had no way to say what it was. The
// version row in the panel was gated on window.h5vcc, which is Cobalt only, so
// on a television the only way to answer "did my change actually reach the TV"
// was to unpack the published tarball and diff it -- which is exactly what it
// took to find that TizenBrew's service caches the module script in a Map it
// never invalidates, and replays it across app launches until the set reboots.
const version = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export default defineConfig({
    input: 'userScript.ts',

    // Browser resolution, and CommonJS interop for the vendored dependencies
    // (esprima, estraverse, qrcode-npm, tiny-sha256) -- both built in, so the
    // node-resolve and commonjs plugins are no longer needed.
    platform: 'browser',

    // ui.css and the other stylesheets are imported for their text. Replaces
    // rollup-plugin-string; JSON needs no mapping, rolldown parses it natively.
    moduleTypes: {
        '.css': 'text',
    },

    transform: {
        // Substituted into the source, so nothing has to import package.json and
        // drag the whole file into the bundle. INSIDE `transform`, not beside
        // it: a top-level `define` is accepted by the config object and
        // silently does nothing, which shipped a bundle carrying the literal
        // text `__TT_VERSION__` where the version should have been. The harness
        // asserts the BUILT bundle, not this file, for exactly that reason.
        define: {
            __TT_VERSION__: JSON.stringify(version),
        },

        // Tizen 9.0's web engine is Chromium M120, so lower to exactly that and
        // no further. Replaces @babel/preset-env, and unlike preset-env this
        // lowers syntax only by design -- there is nothing left to polyfill,
        // because tsconfig.json's `lib` already forbids anything M120 lacks.
        target: 'chrome120',
    },

    output: {
        file: '../dist/userScript.js',
        format: 'iife',
        // Oxc's minifier, in place of terser.
        minify: true,
    },
});
