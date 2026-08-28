// Imports that carry no types of their own.

/** Loaded as text by rolldown's `moduleTypes` mapping. */
declare module '*.css' {
    const content: string;
    export default content;
}

declare module 'qrcode-npm' {
    interface QrCode {
        addData(data: string): void;
        make(): void;
        createImgTag(cellSize?: number, margin?: number): string;
    }
    export function qrcode(typeNumber: number, errorCorrectLevel: 'L' | 'M' | 'Q' | 'H'): QrCode;
    const _default: { qrcode: typeof qrcode };
    export default _default;
}

declare module 'tiny-sha256' {
    const sha256: (input: string) => string;
    export default sha256;
}

// Vendored spatial-navigation polyfill, kept as JavaScript. Spatial navigation
// is a draft spec that no Chromium implements, so unlike the built-in polyfills
// this one does not go away with the move to Chromium M120.
declare module '*/spatial-navigation-polyfill.js';

// estraverse ships no type definitions here. The parser walks a minified
// bundle, so the node shapes are whatever the input happens to be; what is
// declared is only the surface ASTParser.ts actually touches. acorn brings its
// own types and needs no declaration.
declare module 'estraverse' {
    interface EstraverseNode {
        type: string;
        range?: [number, number];
        [key: string]: any;
    }
    export interface Visitor {
        enter?(node: EstraverseNode, parent: EstraverseNode | null): void;
        leave?(node: EstraverseNode, parent: EstraverseNode | null): void;
        /** Required for modern syntax: without it estraverse throws on the
         *  first node type it has no visitor keys for. */
        fallback?: 'iteration' | ((node: EstraverseNode) => string[]);
    }
    export function traverse(root: EstraverseNode, visitor: Visitor): void;
    const _default: { traverse: typeof traverse };
    export default _default;
}
