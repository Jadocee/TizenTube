import { defineConfig } from 'rolldown';

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
