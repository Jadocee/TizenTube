// Declarations that Chromium M120 silently drops.
//
// CSS nesting works on M120, which is what Tizen 9.0 runs, but
// CSSNestedDeclarations only shipped in Chrome 130. Before that, a bare
// declaration placed AFTER a nested rule inside the same block is not a
// declaration at all -- the parser discards it. So this:
//
//     .row {
//         color: red;
//         &:hover { color: blue; }
//         background: green;      <- gone, on a television
//     }
//
// renders with no background on the target device and a green one on every
// machine anyone develops or tests on.
//
// THAT ASYMMETRY IS WHY THIS FILE EXISTS. The browser harnesses drive a modern
// Chromium, which implements CSSNestedDeclarations and therefore CANNOT
// reproduce the bug -- they would report the dropped declaration as applying
// perfectly. Both previewIndicator.css and ui.css carry comments calling the
// ordering "a rule we keep rather than something a test catches". It is now
// something a test catches.
//
// The check is textual because the defect is textual: it is about where a
// declaration sits relative to a nested rule in the SOURCE, which is exactly
// what no DOM query can recover.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readRepo, repoPath, checker } from '../lib/repo.mjs';

const { check, done } = checker();

/**
 * Every declaration that follows a nested rule in the same block.
 *
 * A character scanner rather than a regex: nesting is recursive and the thing
 * being located is a position relative to a brace, which a regex cannot track.
 * Comments are stripped first -- both stylesheets explain this very trap in
 * prose, braces and semicolons included, and matching their own explanation
 * would be a fitting way to get this wrong.
 */
export function lateDeclarations(source) {
    const src = String(source).replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [];
    // depth -> has a nested rule already been opened at this depth
    const sawRule = new Map();
    let depth = 0;
    let buffer = '';
    let line = 1;

    for (const ch of src) {
        if (ch === '\n') line++;
        if (ch === '{') {
            // Opening a block INSIDE another one is the nested rule that makes
            // every later declaration in the parent unreachable.
            if (depth > 0) sawRule.set(depth, true);
            depth++;
            sawRule.set(depth, false);
            buffer = '';
        } else if (ch === '}') {
            if (depth > 0) depth--;
            buffer = '';
        } else if (ch === ';') {
            const declaration = buffer.trim();
            // A colon is what separates a declaration from an at-statement such
            // as `@layer a, b;`, which is not affected.
            if (depth > 0 && sawRule.get(depth) && declaration.includes(':')) {
                found.push({ line, declaration: declaration.replace(/\s+/g, ' ').slice(0, 80) });
            }
            buffer = '';
        } else {
            buffer += ch;
        }
    }
    return found;
}

// --- the scanner has to be able to fail -------------------------------------
// A checker nobody has seen fail is indistinguishable from one that returns the
// empty array. These two controls are the whole reason to trust the sweep below:
// without them "no stylesheet violates the rule" and "the scanner is broken"
// produce identical output.
const BAD = `.a {\n color: red;\n &:hover { color: blue; }\n background: green;\n}`;
const GOOD = `.a {\n color: red;\n background: green;\n &:hover { color: blue; }\n}`;
check('the scanner finds a declaration after a nested rule', lateDeclarations(BAD).length, 1);
check('  ...and names it', lateDeclarations(BAD)[0].declaration, 'background: green');
check('  ...and passes the same file reordered', lateDeclarations(GOOD).length, 0);

// Two levels down, which is where previewIndicator.css's speaker lives.
const NESTED = `.a {\n color: red;\n & .b {\n inline-size: 1px;\n &::before { content: ""; }\n block-size: 2px;\n }\n}`;
check('  ...and inside a nested block too', lateDeclarations(NESTED).length, 1);
check('  ...naming the inner one', lateDeclarations(NESTED)[0].declaration, 'block-size: 2px');

// A declaration before the nested rule at the same depth is fine even when a
// SIBLING block above it closed -- the counter is per depth, not per file.
const SIBLINGS = `.a { color: red; }\n.b { background: blue; }`;
check('a closed sibling does not poison the next block', lateDeclarations(SIBLINGS).length, 0);

// Prose is not code. Both real stylesheets describe this trap using braces and
// semicolons; a scanner that read comments would flag their explanations.
const COMMENTED = `.a {\n color: red;\n /* &:hover { color: blue; } */\n background: green;\n}`;
check('comments are not rules', lateDeclarations(COMMENTED).length, 0);

// An at-rule statement carries a semicolon but is not a declaration.
const ATRULE = `@layer base, ui;\n.a { color: red; &:hover { color: blue; } }`;
check('an at-rule statement is not a declaration', lateDeclarations(ATRULE).length, 0);

// --- every stylesheet the mod ships -----------------------------------------
function stylesheets(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(repoPath(dir));
    } catch (_e) {
        return out;
    }
    for (const name of entries) {
        if (name === 'node_modules' || name === 'dist') continue;
        const full = join(repoPath(dir), name);
        if (statSync(full).isDirectory()) stylesheets(relative(repoPath('.'), full), out);
        else if (name.endsWith('.css')) out.push(relative(repoPath('.'), full));
    }
    return out;
}

const files = [...stylesheets('mods'), ...stylesheets('standalone')].sort();
check('there are stylesheets to check', files.length > 0, true);

for (const file of files) {
    const hits = lateDeclarations(readRepo(...file.split('/')));
    if (hits.length) {
        for (const hit of hits) {
            console.log(`        ${file}:${hit.line}  ${hit.declaration}`);
        }
    }
    check(`${file} has no declaration M120 would drop`, hits.length, 0);
}

done();
