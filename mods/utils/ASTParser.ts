// AST Parser for TizenTube, used for finding code patterns
// You may call me insane for this.

import * as acorn from 'acorn';
import estraverse from 'estraverse';

/**
 * The parse is deliberately untyped past this. The input is a minified YouTube
 * component read back through Function.prototype.toString, so its shape is
 * whatever that release happens to emit.
 */
interface AstNode {
    type: string;
    range?: [number, number];
    [key: string]: any;
}

/** One assignment or class member found in the parsed source, as raw source text. */
export interface AssignedFunction {
    left: string | null;
    rhs: string;
    returned: string | null;
}

// This used to use esprima 4, which stops at ES2017: object spread, optional
// chaining, nullish coalescing, class fields and logical assignment all fail it
// outright. That was survivable only while the Chrome 47 target forced YouTube
// to serve an ES5 bundle. On the Chromium M120 target it does not, so the
// parser has to keep up -- acorn tracks the living standard.
function parse(code: string): { ast: AstNode; wrapOffset: number } | null {
    // A component stringifies as `class{...}` or `function(){...}`, neither of
    // which is a valid statement, hence the parenthesised second attempt.
    for (const [source, wrapOffset] of [
        [code, 0],
        ['(' + code + ')', 1],
    ] as const) {
        for (const sourceType of ['script', 'module'] as const) {
            try {
                const ast = acorn.parse(source, {
                    ecmaVersion: 'latest',
                    ranges: true,
                    sourceType,
                    allowReturnOutsideFunction: true,
                }) as unknown as AstNode;
                return { ast, wrapOffset };
            } catch (e) {
                // Try the next shape.
            }
        }
    }
    return null;
}

// Extract assignment RHS sources, class members, and inner returned functions (IIFEs)
export function extractAssignedFunctions(code: string): AssignedFunction[] {
    const original = code;
    // Returning empty rather than throwing: the caller resolves every name
    // through a `find` that already copes with a miss, so an unparseable
    // component degrades to "no patches" instead of taking the whole module
    // down from inside a setTimeout, where nothing retries.
    const parsed = parse(code);
    if (!parsed) return [];

    const { ast, wrapOffset } = parsed;
    const out: AssignedFunction[] = [];
    const slice = (node: AstNode | null | undefined): string | null =>
        node && node.range
            ? original.slice(node.range[0] - wrapOffset, node.range[1] - wrapOffset)
            : null;

    // The returned function of an IIFE, which is how the ES5 bundles wrapped
    // their methods.
    const innerOf = (rhs: AstNode): string | null => {
        if (
            rhs.type === 'CallExpression' &&
            rhs.callee &&
            rhs.callee.type === 'FunctionExpression' &&
            rhs.callee.body
        ) {
            for (const s of (rhs.callee.body.body || []) as AstNode[]) {
                if (s.type === 'ReturnStatement' && s.argument && s.argument.range)
                    return slice(s.argument);
            }
            return null;
        }
        if (rhs.type === 'FunctionExpression' || rhs.type === 'ArrowFunctionExpression')
            return slice(rhs);
        return null;
    };

    estraverse.traverse(ast, {
        // Modern syntax produces node types estraverse has no visitor keys for;
        // without this it throws on the first one it does not recognise.
        fallback: 'iteration',
        enter: function (node: AstNode) {
            if (node.type === 'AssignmentExpression') {
                const rhs = node.right as AstNode;
                if (!rhs || !rhs.range) return;
                out.push({
                    left: slice(node.left as AstNode),
                    rhs: slice(rhs)!,
                    returned: innerOf(rhs),
                });
                return;
            }

            // Class members. An ES5 bundle assigned its methods
            // (`this.foo = function(){}`), which is the only shape the walk used
            // to recognise; the same component delivered as a real class puts
            // them on the prototype as MethodDefinition instead, and the walk
            // came back empty -- so every caller silently patched nothing.
            // Reported as `this.<name>` so the callers' `split('.')[1]` still
            // resolves to the member name.
            if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
                const key = node.key as AstNode | undefined;
                // Skip the constructor: it is not a patchable member, and
                // reporting it as `this.constructor` invites a caller to assign
                // over it.
                if (!key || node.computed || node.kind === 'constructor') return;
                const name = (key.name ?? key.value) as string | undefined;
                const value = node.value as AstNode | undefined;
                if (name === undefined || !value || !value.range) return;
                out.push({ left: 'this.' + name, rhs: slice(value)!, returned: innerOf(value) });
            }
        },
    });

    return out;
}
