// Fixture for test-bzrt-esm-import.js: a TypeScript module loaded through a static import.
interface Pair {
  a: number;
  b: number;
}

export enum Kind {
  Sum = 1,
}

export function add({ a, b }: Pair): number {
  return a + b;
}

export default "esm-lib";
