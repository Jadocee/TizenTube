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
            const normalisation = /if \(\/\^\[a-zA-Z\]\[a-zA-Z\\d\+\\-\.\]\*:\/\.exec\(urlStr\)\) \{\s*urlStr = new URL\(urlStr\)\.toString\(\);\s*\}/;

            // 2. YouTube's responses carry headers far past Node's 16 KB default,
            //    which otherwise aborts the request with HPE_HEADER_OVERFLOW.
            //    This must land on the options object handed to http.request --
            //    NOT on the redirect Request bag, which also has `method:
            //    request.method`. Anchoring on the Object.assign picks the right one.
            const requestOptions = /(return Object\.assign\(\{\}, parsedURL, \{\s*method: request\.method,)/;

            if (!normalisation.test(code) || !requestOptions.test(code)) {
                this.error(
                    'patch-node-fetch could not find its anchors in ' + id +
                    ' -- node-fetch changed. Both patches are required: URLs must not be ' +
                    're-encoded, and maxHeaderSize must be raised. Fix the patterns in rolldown.config.js.'
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
                this.error('patch-node-fetch never ran -- node-fetch is no longer in the bundle. Whatever replaced it needs the same two changes, or this plugin should go.');
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

    plugins: [patchNodeFetch()],

    output: {
        file: 'dist/index.js',
        format: 'cjs',
        // ncc did not minify, and the .wgt has room. Keep it readable so a
        // crash on-device can be traced from the line number alone.
        minify: false,
    },
});
