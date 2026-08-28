// Built-ins newer than the `lib` in tsconfig.json that userScript.js explicitly
// polyfills via core-js. Declaring them here is the contract: if a polyfill
// import is ever removed, every use of it becomes a compile error.
//
// Keep this file in step with the core-js imports at the top of userScript.ts.

interface Array<T> {
    /** Polyfilled by `core-js/es/array/flat`. Native from Chrome 69. */
    flat<D extends number = 1>(depth?: D): FlatArray<T, D>[];
}

interface ObjectConstructor {
    /** Polyfilled by `core-js/es/object/values`. Native from Chrome 54. */
    values<T>(o: { [s: string]: T } | ArrayLike<T>): T[];
    values(o: {}): any[];

    /** Polyfilled by `core-js/es/object/entries`. Native from Chrome 54. */
    entries<T>(o: { [s: string]: T } | ArrayLike<T>): [string, T][];
    entries(o: {}): [string, any][];
}

type FlatArray<Arr, Depth extends number> = {
    done: Arr;
    recur: Arr extends ReadonlyArray<infer InnerArr>
        ? FlatArray<InnerArr, [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20][Depth]>
        : Arr;
}[Depth extends -1 ? 'done' : 'recur'];
