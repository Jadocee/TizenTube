import { defineConfig } from 'rolldown';

/**
 * node-fetch@2 needs two changes to work as this app's proxy. Both used to be
 * regexes run over ncc's bundled output; doing it in `transform` instead means
 * matching node-fetch's own source, which is stable, rather than whatever shape
 * the bundler happened to leave it in.
 *
 * Both patches fail the build if they stop matching. Silently dropping either
 * one breaks video playback on a TV, with no console to find out why.
 */
function patchNodeFetch() {
    let patched = false;
    return {
        name: 'patch-node-fetch',
        transform(code, id) {
            if (!/[\\/]node-fetch[\\/]/.test(id)) return null;

            // 1. node-fetch normalises absolute URLs through `new URL().toString()`,
            //    which re-encodes them. YouTube's TV entry point carries a
            //    percent-encoded additionalDataUrl that has to survive verbatim,
            //    so pass the string through untouched.
            const normalisation =
                /if \(\/\^\[a-zA-Z\]\[a-zA-Z\\d\+\\-\.\]\*:\/\.exec\(urlStr\)\) \{\s*urlStr = new URL\(urlStr\)\.toString\(\);\s*\}/;

            // 2. YouTube's responses carry headers far past Node's 16 KB default,
            //    which otherwise aborts the request with HPE_HEADER_OVERFLOW.
            //    This must land on the options object handed to http.request --
            //    NOT on the redirect Request bag, which also has `method:
            //    request.method`. Anchoring on the Object.assign picks the right one.
            const requestOptions =
                /(return Object\.assign\(\{\}, parsedURL, \{\s*method: request\.method,)/;

            if (!normalisation.test(code) || !requestOptions.test(code)) {
                this.error(
                    'patch-node-fetch could not find its anchors in ' +
                        id +
                        ' -- node-fetch changed. Both patches are required: URLs must not be ' +
                        're-encoded, and maxHeaderSize must be raised. Fix the patterns in rolldown.config.js.',
                );
            }

            patched = true;
            return {
                code: code
                    .replace(normalisation, '')
                    .replace(requestOptions, '$1 maxHeaderSize: 5 * 1024 * 1024,'),
                map: null,
            };
        },
        // Without this the plugin fails open: if node-fetch is ever renamed,
        // replaced or dropped, `transform` simply never fires and the build
        // succeeds having patched nothing.
        buildEnd() {
            if (!patched) {
                this.error(
                    'patch-node-fetch never ran -- node-fetch is no longer in the bundle. Whatever replaced it needs the same two changes, or this plugin should go.',
                );
            }
        },
    };
}

/**
 * adbhost's packet dispatcher opens with `packet = this._packet;` -- no
 * declaration anywhere in the file. Under Node's per-file module semantics that
 * is a sloppy-mode implicit global and it works, which is why the package has
 * shipped that way for years.
 *
 * Rolldown inlines every dependency into ONE file and hoists the entry's
 * directive prologue to line 1 of it. index.ts begins with "use strict", so the
 * whole bundle -- adbhost included -- becomes strict, and that assignment
 * becomes a ReferenceError on the FIRST packet sdbd sends back. The service dies
 * uncaught, the debugger is never attached, and the userscript is never
 * injected. ncc, which rolldown replaced, gave each dependency its own wrapper,
 * so the directive never reached it; this is a regression from that migration.
 *
 * Declaring the variable is the fix rather than dropping the directive: every
 * reference to `packet` lives inside _onPacket, so a local is exactly
 * equivalent, and it keeps strict mode -- and its error checking -- for the rest
 * of the bundle instead of leaving the whole thing depending on sloppy scoping
 * that the next tooling change would break again.
 */
function fixAdbhostImplicitGlobal() {
    let patched = false;
    return {
        name: 'fix-adbhost-implicit-global',
        transform(code, id) {
            if (!/[\\/]adbhost[\\/]/.test(id)) return null;

            const implicitGlobal = /(\n\s*)packet = this\._packet;/;
            if (!implicitGlobal.test(code)) return null;

            patched = true;
            return {
                code: code.replace(implicitGlobal, '$1var packet = this._packet;'),
                map: null,
            };
        },
        buildEnd() {
            if (!patched) {
                this.error(
                    'fix-adbhost-implicit-global never matched. Either adbhost is gone from the ' +
                        'bundle -- in which case delete this plugin -- or it was updated and the ' +
                        'implicit global moved. It cannot simply be dropped: the bundle is strict, ' +
                        "and an undeclared assignment there kills the service on sdbd's first packet, " +
                        'which silently disables debugger injection on every launch.',
                );
            }
        },
    };
}

export default defineConfig({
    input: 'index.ts',
    platform: 'node',

    // Matches the `lib` in tsconfig.json. ncc, which this replaces, did not
    // downlevel at all -- rolldown does, so the output is if anything safer.
    transform: {
        target: 'es2018',
    },

    plugins: [patchNodeFetch(), fixAdbhostImplicitGlobal()],

    output: {
        file: 'dist/index.js',
        format: 'cjs',
        // ncc did not minify, and the .wgt has room. Keep it readable so a
        // crash on-device can be traced from the line number alone.
        minify: false,
    },
});
