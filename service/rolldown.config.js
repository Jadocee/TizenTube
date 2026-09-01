import { defineConfig } from 'rolldown';
import fs from 'fs';

/**
 * `gate`, a transitive dependency of peer-dial, defines
 * `Gate.prototype.await = function await(callback)`. A function *expression*
 * named `await` is legal in sloppy-mode script but not in a module, so every
 * modern parser rejects it -- Oxc included. Strip the name; nothing reads it.
 */
function fixReservedAwait() {
    return {
        name: 'fix-reserved-await',
        transform(code, id) {
            if (!/[\\/]gate[\\/]/.test(id)) return null;
            const fixed = code
                .replace(
                    'Gate.prototype.await = function await(callback)',
                    'Gate.prototype.await = function (callback)',
                )
                .replace(
                    'Async.prototype.await = function await(callback)',
                    'Async.prototype.await = function (callback)',
                );
            return fixed === code ? null : { code: fixed, map: null };
        },
    };
}

/**
 * peer-dial reads its DDD/DIAL XML templates off disk at require time, relative
 * to __dirname. Once bundled there is no such directory, so the reads are
 * replaced with the file contents inlined as string literals.
 *
 * The pattern is deliberately loose about the local variable name: bundlers
 * rename deduplicated imports (`fs$3`, `fs_default`, ...) and that name is not
 * something to depend on.
 */
function injectXmlContent() {
    return {
        name: 'inject-xml-content',
        renderChunk(code) {
            const pattern =
                /var\s+(\w+)_TEMPLATE\s*=\s*[\w$]+(?:\.default)?\.readFileSync\(\s*__dirname\s*\+\s*['"]\/\.\.\/xml\/([^'"]+)['"]\s*,\s*['"]utf8['"]\s*\)/g;
            let injected = 0;
            const modifiedCode = code.replace(pattern, (_match, varName, fileName) => {
                const xml = fs.readFileSync(
                    `node_modules/@patrickkfkan/peer-dial/xml/${fileName}`,
                    'utf8',
                );
                injected++;
                return `var ${varName}_TEMPLATE = ${JSON.stringify(xml)}`;
            });
            // Shipping a service that reads XML off a path that does not exist
            // would fail at runtime, on a TV, with no console. Fail the build.
            if (injected === 0) {
                this.error(
                    'inject-xml-content matched nothing -- peer-dial changed how it loads its XML templates, or the bundler changed how it emits the readFileSync calls. Fix the pattern in rolldown.config.js.',
                );
            }
            return { code: modifiedCode, map: null };
        },
    };
}

export default defineConfig({
    input: 'service.ts',

    // Node built-ins stay external-free and CommonJS deps are handled natively,
    // so node-resolve, commonjs and json are no longer needed as plugins.
    platform: 'node',

    // The Tizen web-service runtime is old; this matches the `lib` in
    // tsconfig.json rather than assuming a modern Node.
    transform: {
        target: 'es2018',
    },

    plugins: [fixReservedAwait(), injectXmlContent()],

    output: {
        file: '../dist/service.js',
        format: 'cjs',
    },
});
