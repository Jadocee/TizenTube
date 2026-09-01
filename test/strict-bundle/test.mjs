// The standalone service bundle is STRICT, and that changes what its inlined
// dependencies are allowed to do.
//
// Rolldown flattens every dependency into one file and hoists the entry's
// directive prologue to line 1. standalone/service/index.ts opens with
// "use strict", so third-party code that was written for sloppy per-file module
// scope -- and worked for years under ncc, which wrapped each dependency
// separately -- is now strict too.
//
// The failure mode this guards is an assignment to an undeclared identifier.
// Sloppy mode creates a global and carries on; strict mode throws a
// ReferenceError. adbhost's packet dispatcher did exactly that
// (`packet = this._packet;`), so the service died on the first packet sdbd sent
// back, the debugger was never attached, and the userscript was never injected
// -- on every launch, with nothing on screen to say why.
//
// So: parse the shipped bundle and fail on any assignment to a name that is
// never declared in an enclosing scope.
import { createRequire } from 'node:module';
import { checker, readRepo, repoPath, skip } from '../lib/repo.mjs';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
let acorn;
try {
    acorn = require(repoPath('mods', 'node_modules', 'acorn'));
} catch {
    skip('acorn is not installed (run npm install in mods/); this harness needs a parser');
}

const BUNDLE = ['standalone', 'service', 'dist', 'index.js'];
if (!existsSync(repoPath(...BUNDLE))) {
    skip('standalone/service/dist/index.js is not built; run npm run build in standalone/service');
}

const src = readRepo(...BUNDLE);
const { check, done } = checker();

// The directive is what makes this matter. If it ever goes away the risk goes
// with it -- but so does strict-mode checking for our own code, so assert it is
// still there rather than letting it drift silently either way.
check('the bundle is strict', /^\s*(["'])use strict\1;/.test(src), true);

const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', locations: true });

// Names a script may assign to without declaring them itself.
const AMBIENT = new Set([
    'globalThis',
    'global',
    'window',
    'self',
    'module',
    'exports',
    'require',
    '__dirname',
    '__filename',
    'process',
    'console',
    'Buffer',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'queueMicrotask',
    'fetch',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'AbortSignal',
    'Event',
    'EventTarget',
    'MessageChannel',
    'structuredClone',
    'Object',
    'Array',
    'Function',
    'String',
    'Number',
    'Boolean',
    'Symbol',
    'Math',
    'JSON',
    'Date',
    'RegExp',
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'EvalError',
    'URIError',
    'Promise',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'WeakRef',
    'Proxy',
    'Reflect',
    'BigInt',
    'Intl',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Atomics',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'FinalizationRegistry',
    'escape',
    'unescape',
    'encodeURI',
    'decodeURI',
    'encodeURIComponent',
    'decodeURIComponent',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'eval',
    'NaN',
    'Infinity',
    'undefined',
]);

// --- scope model ------------------------------------------------------------
const scopes = [{ fn: true, names: new Set(AMBIENT) }];
const declare = (name, kind) => {
    if (!name) return;
    if (kind === 'var' || kind === 'function') {
        for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].fn) {
                scopes[i].names.add(name);
                return;
            }
        }
    }
    scopes[scopes.length - 1].names.add(name);
};
const bindPattern = (node, kind) => {
    if (!node) return;
    switch (node.type) {
        case 'Identifier':
            declare(node.name, kind);
            break;
        case 'ObjectPattern':
            node.properties.forEach((p) => bindPattern(p.value || p.argument, kind));
            break;
        case 'ArrayPattern':
            node.elements.forEach((e) => bindPattern(e, kind));
            break;
        case 'AssignmentPattern':
            bindPattern(node.left, kind);
            break;
        case 'RestElement':
            bindPattern(node.argument, kind);
            break;
    }
};
const resolved = (name) => scopes.some((s) => s.names.has(name));

// Hoist var/function declarations into the function scope they belong to before
// walking its body -- otherwise an assignment textually above the declaration
// reads as undeclared.
function hoist(body) {
    const seen = [];
    const visit = (n) => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'VariableDeclaration' && n.kind === 'var')
            n.declarations.forEach((d) => bindPattern(d.id, 'var'));
        if (n.type === 'FunctionDeclaration') {
            declare(n.id && n.id.name, 'function');
            return;
        }
        if (
            /Function(Expression|Declaration)|ArrowFunctionExpression|ClassDeclaration|ClassExpression/.test(
                n.type,
            )
        )
            return;
        for (const k of Object.keys(n)) {
            const v = n[k];
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v.type === 'string') visit(v);
        }
    };
    (Array.isArray(body) ? body : [body]).forEach(visit);
    return seen;
}

const offenders = [];
const lineOf = (node) => (node.loc ? node.loc.start.line : 0);

function walk(node, parent) {
    if (!node || typeof node.type !== 'string') return;

    const opensFnScope = /FunctionDeclaration|FunctionExpression|ArrowFunctionExpression/.test(
        node.type,
    );
    const opensBlockScope =
        node.type === 'BlockStatement' && !(parent && /Function|ArrowFunction/.test(parent.type));

    if (opensFnScope) {
        scopes.push({ fn: true, names: new Set() });
        if (node.id && node.type === 'FunctionExpression') declare(node.id.name, 'let');
        node.params.forEach((p) => bindPattern(p, 'let'));
        declare('arguments', 'let');
        declare('this', 'let');
        if (node.body.type === 'BlockStatement') hoist(node.body.body);
    } else if (opensBlockScope) {
        scopes.push({ fn: false, names: new Set() });
    } else if (node.type === 'CatchClause') {
        scopes.push({ fn: false, names: new Set() });
        bindPattern(node.param, 'let');
    }

    if (node.type === 'VariableDeclaration')
        node.declarations.forEach((d) => bindPattern(d.id, node.kind));
    if (node.type === 'ClassDeclaration' && node.id) declare(node.id.name, 'let');

    // The check itself: assigning to a bare name nothing declared.
    if (
        node.type === 'AssignmentExpression' &&
        node.left.type === 'Identifier' &&
        !resolved(node.left.name)
    ) {
        offenders.push({ name: node.left.name, line: lineOf(node) });
    }
    if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
        if (node.left.type === 'Identifier' && !resolved(node.left.name))
            offenders.push({ name: node.left.name, line: lineOf(node) });
    }

    for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => walk(c, node));
        else if (v && typeof v.type === 'string') walk(v, node);
    }

    if (opensFnScope || opensBlockScope || node.type === 'CatchClause') scopes.pop();
}

hoist(ast.body);
ast.body.forEach((n) => walk(n, ast));

const unique = [...new Map(offenders.map((o) => [`${o.name}:${o.line}`, o])).values()];
for (const o of unique.slice(0, 20)) {
    console.log(`      -> ${o.name} assigned but never declared, at dist/index.js:${o.line}`);
}
check('no assignment to an undeclared name (each one is a ReferenceError here)', unique.length, 0);

done();
