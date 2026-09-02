// Declarations Chromium M120 quietly REORDERS.
//
// CSS nesting works on M120, which is what Tizen 9.0 runs, but
// CSSNestedDeclarations only shipped in Chrome 130. Before that, a bare
// declaration placed AFTER a nested rule inside the same block does not keep
// its source position: the parser HOISTS it above the nested rule.
//
// MEASURED against real Chrome for Testing 120.0.6099.109 driven beside the
// harness Chromium, because the first version of this file asserted the wrong
// mechanism -- it said the declaration was discarded, and it is not:
//
//     .e { &:hover { color: blue; } background: green; }
//        M120 serialises  .e { background: green; &:hover { color: blue; } }
//        both engines     background is green
//
// So a declaration whose property NOTHING nested touches is harmless. The one
// that bites is a nested rule setting the SAME property:
//
//     .d { & { background: red; } background: green; }
//        M120      red     (the hoisted green is overridden by the nested rule)
//        Chrome130 green   (source order preserved, green wins)
//
// One block, two different colours, decided by which engine reads it.
//
// THAT ASYMMETRY IS WHY THIS FILE EXISTS. The browser harnesses drive a modern
// Chromium, which implements CSSNestedDeclarations and therefore resolves the
// conflict the OTHER way -- so they report the television's losing declaration
// as winning. Both previewIndicator.css and ui.css carry comments calling the
// ordering "a rule we keep rather than something a test catches". It is now
// something a test catches.
//
// The check flags EVERY declaration after a nested rule, not only the ones
// whose property collides. That is deliberate: whether a collision exists
// depends on the whole cascade, including YouTube's own stylesheet, and a rule
// that is merely reordered today is one edit away from being overridden.
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
            // A block can close on a declaration that has no trailing semicolon.
            // Only checking at ';' walked straight past the last declaration in
            // every such block -- and the last one is exactly where a trailing
            // declaration sits.
            const trailing = buffer.trim();
            if (depth > 0 && sawRule.get(depth) && trailing.includes(':')) {
                found.push({ line, declaration: trailing.replace(/\s+/g, ' ').slice(0, 80) });
            }
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

// The case that actually changes what a television renders: a nested rule
// setting the SAME property as the trailing declaration. On M120 the hoisted
// declaration loses to it; on Chrome 130+ source order preserves it and it wins.
const COLLIDING = `.d {\n & { background: red; }\n background: green;\n}`;
check('a colliding trailing declaration is flagged', lateDeclarations(COLLIDING).length, 1);
check('  ...and named', lateDeclarations(COLLIDING)[0].declaration, 'background: green');

// A declaration with no trailing semicolon -- legal CSS, and the scanner used to
// walk straight past it because it only inspected text before a ';'.
const NOSEMI = `.a {\n &:hover { color: blue; }\n background: green\n}`;
check('a final declaration without a semicolon still counts', lateDeclarations(NOSEMI).length, 1);

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

/** Inline <style> blocks. standalone/index.html ships one, and a stylesheet is
 *  a stylesheet wherever it lives -- scanning only .css files left a shipped one
 *  outside the sweep entirely. */
export function styleBlocks(html) {
    return [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}
check('style blocks are extracted', styleBlocks('<style>.a{color:red}</style>').length, 1);
check('  ...and none is found where there are none', styleBlocks('<p>hi</p>').length, 0);

const files = [...stylesheets('mods'), ...stylesheets('standalone')].sort();
check('there are stylesheets to check', files.length > 0, true);

// The shipped HTML, whose <style> blocks are as much a stylesheet as any file.
// test/ pages are excluded on purpose: old.html deliberately reproduces a fixed
// bug and is not shipped anywhere.
for (const page of ['standalone/index.html']) {
    const blocks = styleBlocks(readRepo(...page.split('/')));
    let hits = 0;
    for (const block of blocks) {
        for (const hit of lateDeclarations(block)) {
            hits++;
            console.log(`        ${page} (inline): ${hit.declaration}`);
        }
    }
    check(`${page} has no declaration M120 would reorder`, hits, 0);
}

for (const file of files) {
    const hits = lateDeclarations(readRepo(...file.split('/')));
    if (hits.length) {
        for (const hit of hits) {
            console.log(`        ${file}:${hit.line}  ${hit.declaration}`);
        }
    }
    check(`${file} has no declaration M120 would reorder`, hits.length, 0);
}

done();
