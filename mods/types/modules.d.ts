// Imports that carry no types of their own.

/** Loaded as a string by rollup-plugin-string. */
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

// Vendored third-party polyfills, kept as JavaScript.
declare module '*/spatial-navigation-polyfill.js';
declare module '*/domrect-polyfill';
declare module '*/domrect-polyfill.js';

// esprima and estraverse ship no type definitions here. The parser walks a
// minified bundle, so the node shapes are whatever the input happens to be;
// what is declared is only the surface ASTParser.ts actually touches.
declare module 'esprima' {
    export interface Node {
        type: string;
        range?: [number, number];
        [key: string]: any;
    }
    export interface Program extends Node {
        type: 'Program';
        body: Node[];
    }
    export interface ParseOptions {
        range?: boolean;
        loc?: boolean;
        tolerant?: boolean;
        comment?: boolean;
        sourceType?: 'script' | 'module';
    }
    export function parse(code: string, options?: ParseOptions): Program;
    const _default: { parse: typeof parse };
    export default _default;
}

declare module 'estraverse' {
    import type { Node } from 'esprima';
    export interface Visitor {
        enter?(node: Node, parent: Node | null): void;
        leave?(node: Node, parent: Node | null): void;
    }
    export function traverse(root: Node, visitor: Visitor): void;
    const _default: { traverse: typeof traverse };
    export default _default;
}
