// A json-prune matcher, in the shape uBlock Origin's scriptlet of that name uses.
//
// adblock.ts already described itself as "a minimal reimplementation" of uBO's
// YouTube rule -- ##+js(json-prune, playerAds adPlacements) -- but it was
// reimplemented as control flow: one `if` per property, each testing an exact
// place in the tree. That has two costs. Every shape YouTube invents needs
// another branch, and the branches only looked where they were written to look,
// so `adPlacements` nested inside a continuation went straight through while the
// top-level one was stripped.
//
// Expressing the same rules as paths makes them data. Adapting to a YouTube
// change becomes a line in a list instead of a change to the parse hook.
//
// Path grammar, deliberately small:
//     a.b.c   literal keys
//     *       any one key, or any one array index
//     **      any depth, including none
//
// COST. This runs inside JSON.parse, which YouTube calls constantly, so a `**`
// rule walking every node of a several-hundred-kilobyte payload several times a
// second is not free on a television's CPU. Two bounds keep it honest: callers
// skip the whole pass when the source text cannot contain a rule's key (see
// pruneTokens), and every traversal has a node budget it will not exceed.

/** One rule. Either replaces what a path resolves to, or filters an array. */
export interface PruneRule {
    /** Dotted path, with `*` and `**` as above. */
    path: string;
    /**
     * What to leave in place of the match. Omit to delete the key outright.
     *
     * Arrays are usually emptied rather than deleted, because YouTube's
     * renderers read `.length` off them and a missing property throws where an
     * empty array simply renders nothing.
     */
    replaceWith?: unknown;
    /**
     * When set, `path` is expected to resolve to an array, and elements are
     * removed when this sub-path is present on them -- rather than the array
     * itself being replaced. This is what strips a single promoted tile out of a
     * shelf while leaving the real videos beside it.
     */
    dropItemsWith?: string;
}

/** Ceiling on nodes visited per rule, per payload. */
const MAX_NODES = 20000;

/**
 * Ceiling on how deep a `**` will descend.
 *
 * Not a nicety: `**` recurses one frame per level, so without this a payload
 * nested a few thousand deep overflows the stack -- and this runs inside
 * JSON.parse, where the throw is swallowed by the surrounding catch and ad
 * blocking simply stops working for that response with nothing to show for it.
 * YouTube's renderers nest a few dozen levels at most, so this is far beyond any
 * real payload and far below the stack.
 */
const MAX_DEPTH = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Does `node` have something at `path`? Used by dropItemsWith. */
function hasPath(node: unknown, segments: string[]): boolean {
    let found = false;
    resolve(
        node,
        segments,
        0,
        { n: 0 },
        () => {
            found = true;
        },
        0,
    );
    return found;
}

/**
 * Walks `segments` from `node`, calling `onMatch(parent, key)` for every match.
 * The parent and key are handed over rather than the value, because a caller
 * that wants to delete or replace needs somewhere to write.
 */
function resolve(
    node: unknown,
    segments: string[],
    index: number,
    budget: { n: number },
    onMatch: (parent: Record<string, unknown> | unknown[], key: string | number) => void,
    depth: number,
): void {
    if (budget.n++ > MAX_NODES) return;
    if (depth > MAX_DEPTH) return;
    if (!isObject(node)) return;

    const segment = segments[index];
    const last = index === segments.length - 1;

    if (segment === '**') {
        // Zero segments consumed: try the rest of the pattern right here.
        if (index + 1 < segments.length) resolve(node, segments, index + 1, budget, onMatch, depth);
        // Or one level down, repeatedly.
        for (const key of Object.keys(node)) {
            resolve(
                (node as Record<string, unknown>)[key],
                segments,
                index,
                budget,
                onMatch,
                depth + 1,
            );
        }
        return;
    }

    const keys =
        segment === '*'
            ? Object.keys(node)
            : Object.prototype.hasOwnProperty.call(node, segment)
              ? [segment]
              : [];

    for (const key of keys) {
        if (budget.n++ > MAX_NODES) return;
        if (last) {
            onMatch(
                node as Record<string, unknown> | unknown[],
                Array.isArray(node) ? Number(key) : key,
            );
        } else {
            resolve(
                (node as Record<string, unknown>)[key],
                segments,
                index + 1,
                budget,
                onMatch,
                depth + 1,
            );
        }
    }
}

/** Applies one rule to a parsed payload. Returns how many matches it changed. */
export function applyRule(root: unknown, rule: PruneRule): number {
    const segments = rule.path.split('.');
    const dropSegments = rule.dropItemsWith ? rule.dropItemsWith.split('.') : null;
    const budget = { n: 0 };
    let changed = 0;

    // Collected before mutating: deleting keys while walking the same object
    // skips siblings.
    const matches: Array<[Record<string, unknown> | unknown[], string | number]> = [];
    resolve(
        root,
        segments,
        0,
        budget,
        (parent, key) => {
            matches.push([parent, key]);
        },
        0,
    );

    for (const [parent, key] of matches) {
        const current = (parent as Record<string | number, unknown>)[key];

        if (dropSegments) {
            if (!Array.isArray(current)) continue;
            const kept = current.filter((item) => !hasPath(item, dropSegments));
            if (kept.length !== current.length) {
                (parent as Record<string | number, unknown>)[key] = kept;
                changed++;
            }
            continue;
        }

        if (current === undefined) continue;
        if ('replaceWith' in rule) {
            (parent as Record<string | number, unknown>)[key] = rule.replaceWith;
        } else {
            delete (parent as Record<string, unknown>)[key as string];
        }
        changed++;
    }

    return changed;
}

/** Applies every rule. Returns the total number of changes. */
export function prune(root: unknown, rules: PruneRule[]): number {
    let changed = 0;
    for (const rule of rules) changed += applyRule(root, rule);
    return changed;
}

/**
 * The literal keys a rule set can possibly match, for the cheap pre-check.
 *
 * A key that does not appear anywhere in the source text cannot appear in the
 * object parsed from it, so a substring test over the raw string rules out the
 * whole pass far more cheaply than walking the tree. Wildcards contribute
 * nothing, which is the point: a rule of only wildcards would have no token and
 * would always be run.
 */
export function pruneTokens(rules: PruneRule[]): string[] {
    const tokens = new Set<string>();
    for (const rule of rules) {
        for (const segment of rule.path.split('.')) {
            if (segment !== '*' && segment !== '**') tokens.add(segment);
        }
        if (rule.dropItemsWith) {
            for (const segment of rule.dropItemsWith.split('.')) {
                if (segment !== '*' && segment !== '**') tokens.add(segment);
            }
        }
    }
    return [...tokens];
}

/** True when the raw text could contain any of these tokens. */
export function textCouldMatch(text: unknown, tokens: string[]): boolean {
    if (typeof text !== 'string') return true; // not a string source; cannot rule it out
    for (const token of tokens) {
        if (text.indexOf(token) !== -1) return true;
    }
    return false;
}
