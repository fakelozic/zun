#!/usr/bin/env bun
/**
 * fix_zig017: mechanical Zig 0.16 -> 0.17 rewrites for zun / Bun sources.
 *
 * Usage:
 *   bun scripts/fix_zig017.ts [--check] [--report] [--only=rule,rule] [paths...]
 *
 *   paths      files or directories (default: src). Only *.zig files are touched.
 *   --check    don't write; exit 1 if any file would change (CI / idempotency check)
 *   --report   also list the sites that need a human (see REPORT_RULES below)
 *   --only=    run only the named rewrite rules
 *
 * Run it on code restored from Bun 1.3.14 *after* cruller's scripts/fix_zig016_*.py.
 * It is idempotent: a second run changes nothing (`--check` proves it).
 *
 * Every rewrite only fires on code: comments, string literals and `\\` multiline
 * strings are masked out first. Rules that cannot be done safely by text are
 * report-only. Some rewrites target small compat helpers in zun
 * (bun.meta.fieldsOf/declsOf/paramsOf, bun.allocators.stackFallback,
 * bun.strings.repeatComptime); see docs/zig/migration-to-0.17.md.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Masking: which characters are code?
// ─────────────────────────────────────────────────────────────────────────────

/** true at index i when src[i] is code (not in a comment, string, char literal or \\ line). */
export function codeMask(src: string): Uint8Array {
  const m = new Uint8Array(src.length).fill(1);
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // line comment (also //! and ///)
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") m[i++] = 0;
      continue;
    }
    // multiline string line: \\ ... to end of line
    if (c === "\\" && src[i + 1] === "\\") {
      while (i < n && src[i] !== "\n") m[i++] = 0;
      continue;
    }
    // string literal; @"ident" is an identifier but its inside is still not code
    if (c === '"') {
      m[i++] = 0;
      while (i < n && src[i] !== '"' && src[i] !== "\n") {
        if (src[i] === "\\") m[i++] = 0;
        m[i++] = 0;
      }
      if (i < n) m[i++] = 0;
      continue;
    }
    if (c === "'") {
      m[i++] = 0;
      while (i < n && src[i] !== "'" && src[i] !== "\n") {
        if (src[i] === "\\") m[i++] = 0;
        m[i++] = 0;
      }
      if (i < n) m[i++] = 0;
      continue;
    }
    i++;
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny expression scanners (enough for postfix chains like @typeInfo(T).@"struct")
// ─────────────────────────────────────────────────────────────────────────────

const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** index of the bracket matching the closer at `end` (scanning back), or -1. */
function matchBack(src: string, mask: Uint8Array, end: number): number {
  const close = src[end];
  const open = OPEN[close];
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (!mask[i]) continue;
    if (src[i] === close) depth++;
    else if (src[i] === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** index just past the bracket matching the opener at `start`, or -1. */
function matchFwd(src: string, mask: Uint8Array, start: number): number {
  const open = src[start];
  const close = CLOSE[open];
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (!mask[i]) continue;
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Start index of the postfix chain that ends just before `end` (exclusive), e.g.
 * `@typeInfo(T).@"struct"`, `info.@"union"`, `std.meta.Child(T)`. Returns -1 if
 * there is no chain.
 */
export function chainStart(src: string, mask: Uint8Array, end: number): number {
  let i = end;
  for (;;) {
    // suffix groups: calls and index expressions
    while (src[i - 1] === ")" || src[i - 1] === "]") {
      const o = matchBack(src, mask, i - 1);
      if (o < 0) return -1;
      i = o;
    }
    // base: @"quoted", word (possibly @builtin), or nothing (parenthesized primary)
    if (src[i - 1] === '"') {
      let j = i - 2;
      while (j >= 0 && src[j] !== '"') j--;
      if (j < 1 || src[j - 1] !== "@") return -1;
      i = j - 1;
    } else if (isWord(src[i - 1])) {
      while (isWord(src[i - 1])) i--;
      if (src[i - 1] === "@") i--;
    } else if (src[i] !== "(") {
      return i === end ? -1 : i;
    }
    if (src[i - 1] === "." && src[i - 2] !== ".") {
      i--;
      continue;
    }
    return i === end ? -1 : i;
  }
}

/** End (exclusive) of the prefix expression starting at `start` (right operand of `**`). */
function prefixExprEnd(src: string, mask: Uint8Array, start: number): number {
  let i = start;
  if (src[i] === "(") return matchFwd(src, mask, i);
  if (src[i] === "@" && src[i + 1] === '"') {
    i += 2;
    while (i < src.length && src[i] !== '"') i++;
    i++;
  } else {
    if (src[i] === "@") i++;
    if (!isWord(src[i])) return -1;
    while (isWord(src[i])) i++;
  }
  for (;;) {
    if (src[i] === "(" || src[i] === "[") {
      const e = matchFwd(src, mask, i);
      if (e < 0) return -1;
      i = e;
    } else if (src[i] === "." && (isWord(src[i + 1]) || src[i + 1] === "@")) {
      i++;
      if (src[i] === "@" && src[i + 1] === '"') {
        i += 2;
        while (i < src.length && src[i] !== '"') i++;
        i++;
      } else {
        while (isWord(src[i])) i++;
      }
    } else return i;
  }
}

/** Split `a, b, c` at top-level commas (ignores a trailing comma). */
function splitTopLevel(src: string, mask: Uint8Array, start: number, end: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = start;
  for (let i = start; i < end; i++) {
    if (!mask[i]) continue;
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(src.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(src.slice(last, end));
  return parts.map(p => p.trim()).filter((p, idx, all) => !(p === "" && idx === all.length - 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

type Edit = { start: number; end: number; text: string };
type Rule = { name: string; desc: string; run: (src: string, mask: Uint8Array) => Edit[] };

/** Regex-driven rule; `replace` returns null to skip a match. Matches must start in code. */
function regexRule(
  name: string,
  desc: string,
  re: RegExp,
  replace: (m: RegExpExecArray, src: string, mask: Uint8Array) => string | null,
): Rule {
  return {
    name,
    desc,
    run(src, mask) {
      const edits: Edit[] = [];
      const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m: RegExpExecArray | null;
      while ((m = r.exec(src))) {
        if (!mask[m.index]) continue;
        const text = replace(m, src, mask);
        if (text !== null && text !== m[0]) edits.push({ start: m.index, end: m.index + m[0].length, text });
      }
      return edits;
    },
  };
}

/**
 * `X ** N` (array multiplication, removed in 0.17):
 *   `[_]T{x} ** N`  -> `@splat(x)` when the declaration has a type, else `@as([N]T, @splat(x))`
 *   `.{x} ** N`     -> `@splat(x)`  (an anonymous literal already needed a result type)
 *   `"s" ** N`      -> `bun.strings.repeatComptime("s", N)`
 * Multi-element arrays and named operands are left alone and reported.
 */
const arrayMul: Rule = {
  name: "array-mul",
  desc: "`[_]T{x} ** n` / `.{x} ** n` / `\"s\" ** n` -> @splat / repeatComptime",
  run(src, mask) {
    const edits: Edit[] = [];
    const re = /\*\*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const op = m.index;
      if (!mask[op] || !mask[op + 1]) continue;
      if (src[op - 1] === "*" || src[op + 2] === "*") continue; // `***`: not this operator
      // left operand ends before optional whitespace
      let le = op;
      while (src[le - 1] === " ") le--;
      let rs = op + 2;
      while (src[rs] === " ") rs++;
      const re_ = prefixExprEnd(src, mask, rs);
      if (re_ < 0) continue;
      const count = src.slice(rs, re_);

      // string literal on the left
      if (src[le - 1] === '"') {
        let j = le - 2;
        while (j >= 0 && !(src[j] === '"' && src[j - 1] !== "\\")) j--;
        if (j < 0 || src[j - 1] === "@") continue;
        edits.push({ start: j, end: re_, text: `bun.strings.repeatComptime(${src.slice(j, le)}, ${count})` });
        continue;
      }
      if (src[le - 1] !== "}") continue;
      const ob = matchBack(src, mask, le - 1);
      if (ob < 0) continue;
      const elems = splitTopLevel(src, mask, ob + 1, le - 1);
      if (elems.length !== 1) continue; // multi-element: report-only
      const elem = elems[0];

      if (src[ob - 1] === "." && !isWord(src[ob - 2]) && src[ob - 2] !== ")") {
        edits.push({ start: ob - 1, end: re_, text: `@splat(${elem})` });
        continue;
      }
      // `[_]T{x}`: find `[_]` before `{`
      const head = src.slice(Math.max(0, ob - 200), ob);
      const k = head.lastIndexOf("[_]");
      if (k < 0) continue;
      const tStart = ob - head.length + k;
      const T = src.slice(tStart + 3, ob);
      if (/[=;,]/.test(T)) continue;
      // Is there a declared type? `name: Type = <here>` (var/const/field) on this line.
      const lineStart = src.lastIndexOf("\n", tStart) + 1;
      const before = src.slice(lineStart, tStart);
      const typed = /^\s*(?:(?:pub\s+)?(?:var|const)\s+)?[A-Za-z_][A-Za-z0-9_]*\s*:\s*[^=]+=\s*$/.test(before);
      const n = /^[A-Za-z0-9_.@"]+$/.test(count) || count.startsWith("(") ? count : `(${count})`;
      edits.push({ start: tStart, end: re_, text: typed ? `@splat(${elem})` : `@as([${n}]${T}, @splat(${elem}))` });
    }
    return edits;
  },
};

const voidInit = regexRule("void-init", "`void{}` -> `{}`", /\bvoid\{\}/, () => "{}");

const stackFallback = regexRule(
  "stack-fallback",
  "std.heap.stackFallback/StackFallbackAllocator -> bun.allocators.* (0.16 shape kept)",
  /\bstd\.heap\.(stackFallback|StackFallbackAllocator)\(/,
  m => `bun.allocators.${m[1]}(`,
);

/** std.fmt.allocPrint(A, fmt, args) -> A.print(fmt, args); same for allocPrintSentinel. */
const allocPrint: Rule = {
  name: "alloc-print",
  desc: "std.fmt.allocPrint(a, ...) -> a.print(...) (Sentinel too)",
  run(src, mask) {
    const edits: Edit[] = [];
    const re = /\bstd\.fmt\.allocPrint(Sentinel)?\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (!mask[m.index]) continue;
      const open = m.index + m[0].length - 1;
      const close = matchFwd(src, mask, open);
      if (close < 0) continue;
      const args = splitTopLevel(src, mask, open + 1, close - 1);
      if (args.length < 2) continue;
      // first argument up to its top-level comma
      let depth = 0;
      let comma = -1;
      for (let i = open + 1; i < close - 1; i++) {
        if (!mask[i]) continue;
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === "," && depth === 0) {
          comma = i;
          break;
        }
      }
      if (comma < 0) continue;
      let a = src.slice(open + 1, comma).trim();
      if (!/^[A-Za-z0-9_.@"()\[\]]+$/.test(a)) a = `(${a})`;
      let rest = comma + 1;
      while (src[rest] === " " || src[rest] === "\n") rest++;
      // keep the original layout of the remaining arguments
      edits.push({ start: m.index, end: rest, text: `${a}.print${m[1] ?? ""}(` });
    }
    return edits;
  },
};

const builtinTarget = regexRule(
  "builtin-target",
  "builtin.os/cpu/abi/object_format -> builtin.target.os/cpu/abi/ofmt",
  /(?<![\w.])(builtin|@import\("builtin"\))\.(os|cpu|abi|object_format)\b/,
  m => `${m[1]}.target.${m[2] === "object_format" ? "ofmt" : m[2]}`,
);

const OPT: Record<string, string> = { Debug: "debug", ReleaseSafe: "safe", ReleaseFast: "fast", ReleaseSmall: "small" };
const optimizeCompare = regexRule(
  "optimize-mode",
  "`mode == .Debug`, `OptimizeMode.ReleaseSafe` -> `.debug`, `Optimize.safe`",
  /\b(mode|optimize|optimize_mode)(\s*[!=]=\s*)\.(Debug|ReleaseSafe|ReleaseFast|ReleaseSmall)\b|\b(?:std\.(?:builtin|lang)\.)?OptimizeMode\.(Debug|ReleaseSafe|ReleaseFast|ReleaseSmall)\b|\.(Debug|ReleaseSafe|ReleaseFast|ReleaseSmall)(\s*[!=]=\s*(?:@import\("builtin"\)|builtin)\.mode)\b/,
  m => {
    if (m[1]) return `${m[1]}${m[2]}.${OPT[m[3]]}`;
    if (m[4]) return `std.lang.Optimize.${OPT[m[4]]}`;
    return `.${OPT[m[5]]}${m[6]}`;
  },
);
const optimizeType = regexRule(
  "optimize-type",
  "std.builtin.OptimizeMode -> std.lang.Optimize",
  /\bstd\.(?:builtin|lang)\.OptimizeMode\b/,
  () => "std.lang.Optimize",
);

/** Type-name renames in std.builtin.Type (must run before std-builtin). */
const TYPE_RENAMES: [RegExp, string][] = [
  [/\bstd\.(?:builtin|lang)\.Type\.StructField\.Attributes\b/, "std.lang.Type.Struct.FieldAttributes"],
  [/\bstd\.(?:builtin|lang)\.Type\.UnionField\.Attributes\b/, "std.lang.Type.Union.FieldAttributes"],
  [/\bstd\.(?:builtin|lang)\.Type\.Fn\.Param\.Attributes\b/, "std.lang.Type.Fn.ParamAttributes"],
  [/\bstd\.(?:builtin|lang)\.Type\.StructField\b/, "bun.meta.StructField"],
  [/\bstd\.(?:builtin|lang)\.Type\.UnionField\b/, "bun.meta.UnionField"],
  [/\bstd\.(?:builtin|lang)\.Type\.EnumField\b/, "bun.meta.EnumField"],
  [/\bstd\.(?:builtin|lang)\.Type\.Declaration\b/, "bun.meta.Declaration"],
  [/\bstd\.(?:builtin|lang)\.Type\.Fn\.Param\b/, "bun.meta.Param"],
];
const typeRenames: Rule = {
  name: "type-renames",
  desc: "std.builtin.Type.StructField & co -> bun.meta.* / Type.Struct.FieldAttributes",
  run(src, mask) {
    const edits: Edit[] = [];
    const taken = new Uint8Array(src.length);
    for (const [re, to] of TYPE_RENAMES) {
      for (const e of regexRule("x", "", re, () => to).run(src, mask)) {
        if (taken[e.start]) continue;
        for (let i = e.start; i < e.end; i++) taken[i] = 1;
        edits.push(e);
      }
    }
    return edits;
  },
};

const stdBuiltin = regexRule("std-builtin", "std.builtin. -> std.lang.", /\bstd\.builtin\./, () => "std.lang.");

const BITSET: Record<string, string> = {
  "std.bit_set.IntegerBitSet": "std.bit_set.Integer",
  "std.bit_set.ArrayBitSet": "std.bit_set.Array",
  "std.bit_set.StaticBitSet": "std.bit_set.Static",
  "std.StaticBitSet": "std.bit_set.Static",
  "std.bit_set.DynamicBitSetUnmanaged": "std.bit_set.Dynamic",
  "std.DynamicBitSetUnmanaged": "std.bit_set.Dynamic",
  "std.bit_set.DynamicBitSet": "std.bit_set.DynamicManaged",
  "std.DynamicBitSet": "std.bit_set.DynamicManaged",
};
const bitSet = regexRule(
  "bit-set",
  "std bit_set renames (IntegerBitSet -> Integer, ...)",
  /\bstd\.(?:bit_set\.)?(?:IntegerBitSet|ArrayBitSet|StaticBitSet|DynamicBitSetUnmanaged|DynamicBitSet)\b/,
  m => BITSET[m[0]] ?? null,
);

/**
 * Reflection on `@typeInfo` (struct-of-arrays in 0.17):
 *   CHAIN.@"struct"|"union"|"enum".fields -> bun.meta.fieldsOf(CHAIN.@"…")
 *   CHAIN.@"…".decls                      -> bun.meta.declsOf(CHAIN.@"…")
 *   CHAIN.@"fn".params                    -> bun.meta.paramsOf(CHAIN.@"fn")
 *   std.meta.fields(T)                    -> bun.meta.fieldsOf(T)
 * plus attribute moves: .@"fn".is_var_args -> .@"fn".attrs.varargs,
 * .@"fn".calling_convention -> .@"fn".attrs.@"callconv",
 * .@"pointer".is_const/is_volatile/is_allowzero/address_space -> .@"pointer".attrs.@"…".
 */
const reflection: Rule = {
  name: "reflection",
  desc: "@typeInfo .fields/.decls/.params and pointer/fn attribute moves",
  run(src, mask) {
    const edits: Edit[] = [];
    const re =
      /\.@"(struct|union|enum|opaque|fn|pointer)"\.(fields|decls|params|is_var_args|calling_convention|is_const|is_volatile|is_allowzero|address_space)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (!mask[m.index]) continue;
      const [, kind, member] = m;
      const tagEnd = m.index + 2 + kind.length + 2; // end of .@"kind"
      const end = m.index + m[0].length;
      const wrap = (fn: string) => {
        const s = chainStart(src, mask, m!.index);
        if (s < 0) return;
        edits.push({ start: s, end, text: `bun.meta.${fn}(${src.slice(s, tagEnd)})` });
      };
      if (member === "fields" && (kind === "struct" || kind === "union" || kind === "enum")) wrap("fieldsOf");
      else if (member === "decls" && kind !== "fn" && kind !== "pointer") wrap("declsOf");
      else if (member === "params" && kind === "fn") wrap("paramsOf");
      else if (kind === "fn" && member === "is_var_args") edits.push({ start: tagEnd, end, text: ".attrs.varargs" });
      else if (kind === "fn" && member === "calling_convention")
        edits.push({ start: tagEnd, end, text: '.attrs.@"callconv"' });
      else if (kind === "pointer" && member.startsWith("is_"))
        edits.push({ start: tagEnd, end, text: `.attrs.@"${member.slice(3)}"` });
      else if (kind === "pointer" && member === "address_space")
        edits.push({ start: tagEnd, end, text: '.attrs.@"addrspace"' });
    }
    const re2 = /\bstd\.meta\.fields\(/g;
    while ((m = re2.exec(src))) {
      if (!mask[m.index]) continue;
      edits.push({ start: m.index, end: m.index + m[0].length, text: "bun.meta.fieldsOf(" });
    }
    return edits;
  },
};

const REWRITE_RULES: Rule[] = [
  arrayMul,
  voidInit,
  stackFallback,
  allocPrint,
  builtinTarget,
  optimizeCompare,
  optimizeType,
  typeRenames,
  stdBuiltin,
  bitSet,
  reflection,
];

/** Sites a human must look at: printed with --report, never rewritten. */
const REPORT_RULES: { name: string; re: RegExp; why: string }[] = [
  { name: "array-mul-left", re: /\s\*\*\s/, why: "`**` left after the codemod (multi-element array or named operand)" },
  { name: "needs-bun", re: /@typeInfo\(.*\.@"(?:struct|union|enum|opaque|fn)"\.(?:fields|decls|params)\b|\bstd\.heap\.(?:stackFallback|StackFallbackAllocator)\(|\bstd\.meta\.fields\(|\bstd\.(?:builtin|lang)\.Type\.(?:StructField|UnionField|EnumField|Declaration)\b/, why: "file has no @import(\"bun\"): port this reflection/allocator use to std 0.17 by hand" },
  { name: "errdefer-capture", re: /\berrdefer\s*\|/, why: "errdefer |err| removed: split into an inner fn + catch" },
  { name: "i0", re: /\bi0\b/, why: "i0 removed: use u0" },
  { name: "decl-info", re: /\bstd\.meta\.declarationInfo\b/, why: "compile error in 0.17: use @hasDecl / @typeInfo" },
  { name: "get-last", re: /\.getLast(OrNull)?\(\)/, why: "std ArrayList: getLast -> last().?, getLastOrNull -> last() (bun's own lists keep getLast)" },
  { name: "pointer-alignment", re: /\.@"pointer"\.alignment\b|\.pointer\.alignment\b/, why: "Pointer.alignment -> attrs.@\"align\" (now ?usize, null = natural)" },
  { name: "info-var-fields", re: /\b(?:info|ti|type_info|tyinfo|struct_info|union_info|enum_info|fn_info)\.(?:fields|decls|params)\b/, why: "reflection through a variable: wrap with bun.meta.fieldsOf/declsOf/paramsOf" },
  { name: "has-decl", re: /@hasDecl\(/, why: "0.17: @hasDecl is true only for pub decls (audit: can silently flip comptime branches)" },
  { name: "bit-cast", re: /@bitCast\(/, why: "0.17: @bitCast on arrays/vectors uses logical bits; extern struct/union rejected (audit)" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

function applyEdits(src: string, edits: Edit[]): string {
  // Outer edits win over inner ones that overlap (e.g. nested `**`).
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Edit[] = [];
  let lastEnd = -1;
  for (const e of edits) {
    if (e.start < lastEnd) continue;
    kept.push(e);
    lastEnd = e.end;
  }
  let out = "";
  let pos = 0;
  for (const e of kept) {
    out += src.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + src.slice(pos);
}

/**
 * Files that are not part of the `bun` module (std-only tools such as
 * src/unicode/uucode_lib) cannot use the bun.* compat helpers. In those files the
 * edits that would introduce `bun.` are dropped and show up as `needs-bun` in --report.
 */
const hasBun = (src: string) => /@import\("bun"\)|\bconst bun = @This\(\)/.test(src);
const usesBunHelper = (text: string) => /\bbun\.(meta|allocators|strings)\./.test(text);

export function fixSource(src: string, only?: Set<string>): { out: string; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const withBun = hasBun(src);
  let cur = src;
  // Run rules one at a time so later rules see earlier output (e.g. std.builtin.Type
  // renames before the generic std.builtin -> std.lang rule). Repeat until stable so
  // nested rewrites settle (and so the result is idempotent).
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const rule of REWRITE_RULES) {
      if (only && !only.has(rule.name)) continue;
      const mask = codeMask(cur);
      let edits = rule.run(cur, mask);
      if (!withBun) edits = edits.filter(e => !usesBunHelper(e.text));
      if (edits.length === 0) continue;
      const next = applyEdits(cur, edits);
      if (next !== cur) {
        counts.set(rule.name, (counts.get(rule.name) ?? 0) + edits.length);
        cur = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { out: cur, counts };
}

export function reportSource(src: string): { rule: string; line: number; text: string; why: string }[] {
  const mask = codeMask(src);
  const lines = src.split("\n");
  const out: { rule: string; line: number; text: string; why: string }[] = [];
  let off = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (const r of REPORT_RULES) {
      const re = new RegExp(r.re.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const at = r.name === "array-mul-left" ? off + m.index + m[0].indexOf("**") : off + m.index;
        if (mask[at]) {
          out.push({ rule: r.name, line: li + 1, text: line.trim(), why: r.why });
          break;
        }
      }
    }
    off += line.length + 1;
  }
  return out;
}

function* zigFiles(p: string): Generator<string> {
  const st = statSync(p);
  if (st.isFile()) {
    if (p.endsWith(".zig")) yield p;
    return;
  }
  for (const e of readdirSync(p)) {
    if (e === "node_modules" || e === ".zig-cache" || e === "zig-out") continue;
    yield* zigFiles(join(p, e));
  }
}

function main(argv: string[]): number {
  const check = argv.includes("--check");
  const report = argv.includes("--report");
  const onlyArg = argv.find(a => a.startsWith("--only="));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : undefined;
  const paths = argv.filter(a => !a.startsWith("--"));
  if (paths.length === 0) paths.push("src");

  const total = new Map<string, number>();
  let changedFiles = 0;
  const reports: string[] = [];
  for (const root of paths) {
    for (const f of zigFiles(root)) {
      const src = readFileSync(f, "utf8");
      const { out, counts } = fixSource(src, only);
      if (out !== src) {
        changedFiles++;
        for (const [k, v] of counts) total.set(k, (total.get(k) ?? 0) + v);
        if (!check) writeFileSync(f, out);
        else console.log(`would change: ${f}`);
      }
      if (report) for (const r of reportSource(out)) reports.push(`${f}:${r.line}: [${r.rule}] ${r.text}`);
    }
  }
  for (const [k, v] of [...total].sort()) console.log(`${k.padEnd(16)} ${v}`);
  console.log(`${check ? "would change" : "changed"} ${changedFiles} file(s)`);
  if (report) {
    console.log(`\n# needs a human (${reports.length}):`);
    for (const r of reports) console.log(r);
    console.log("\nwhy:");
    for (const r of REPORT_RULES) console.log(`  ${r.name.padEnd(18)} ${r.why}`);
  }
  return check && changedFiles > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
