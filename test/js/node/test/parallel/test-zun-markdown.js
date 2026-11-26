// Bun.markdown smoke test for zun, runnable before bun:test is restored (docs/status/restore.md § md).
// Covers html/ansi/render/react, the CommonMark spec examples, and hostile input: deep nesting,
// delimiter bombs, huge input, invalid UTF-8 and NUL bytes (no crash, no hang, sane output).
//
// Written as ESM on purpose: until the CLI restore replaces cruller's launcher, an uncaught
// exception in a CommonJS entry file exits 0 silently, so CJS assertions cannot fail
// (docs/status/restore.md, "Known problem: CJS entry files hide failures").

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const md = Bun.markdown;
assert.strictEqual(typeof md, "object");
for (const fn of ["html", "ansi", "render", "react"]) assert.strictEqual(typeof md[fn], "function", fn);

// --- basic rendering ---------------------------------------------------------
assert.strictEqual(md.html("# Hi *there*\n"), "<h1>Hi <em>there</em></h1>\n");
assert.strictEqual(md.html(""), "");
assert.strictEqual(md.html(Buffer.from("**b**")), "<p><strong>b</strong></p>\n");
assert.strictEqual(md.html("- [x] done\n"), '<ul>\n<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled checked>done</li>\n</ul>\n');
assert.match(md.html("| a | b |\n|---|---|\n| 1 | 2 |\n"), /<table>[\s\S]*<td>1<\/td><td>2<\/td>[\s\S]*<\/table>/);
assert.strictEqual(md.html("a < b & c\n"), "<p>a &lt; b &amp; c</p>\n");
assert.strictEqual(md.html("﻿# bom\n"), "<h1>bom</h1>\n");

// Raw HTML passes through by default (CommonMark); the GFM tag filter and no-HTML options escape it.
// Documented in docs/security/known-issues.md § md: Bun.markdown is not a sanitizer.
assert.match(md.html("<script>alert(1)</script>\n"), /<script>alert\(1\)<\/script>/);
assert.doesNotMatch(md.html("<script>alert(1)</script>\n", { tagFilter: true }), /<script>/);
assert.doesNotMatch(md.html("<b>x</b> <script>y</script>\n", { noHtmlBlocks: true, noHtmlSpans: true }), /<(b|script)>/);

// ansi + render + react
const ansi = md.ansi("**bold** `code`");
assert.ok(ansi.includes("\x1b[1mbold"), JSON.stringify(ansi));
const rendered = md.render("# T\n\nhello *w*", {
  heading: (c, m) => `[h${m.level}:${c}]`,
  paragraph: c => `<${c}>`,
  emphasis: c => `_${c}_`,
});
assert.strictEqual(rendered, "[h1:T]<hello _w_>");
const el = md.react("# x", undefined, { reactVersion: 18 });
assert.ok(el && typeof el === "object");

// Callback errors propagate as JS exceptions.
assert.throws(() => md.render("# x", { heading: () => { throw new Error("cb"); } }), /cb/);
// Wrong input types are TypeErrors, not crashes.
for (const bad of [123, null, undefined, {}, Symbol("s")]) {
  assert.throws(() => md.html(bad), TypeError);
}

// --- CommonMark spec (test/js/bun/md/spec.txt) ---------------------------------
// Exact string compare without md4c's HTML normaliser: 649/652 on 2026-11-26. The 3 misses are
// whitespace-only differences the upstream test (md-spec.test.ts) normalises away. This is a
// regression floor; the real gate is md-spec.test.ts once bun:test is back.
{
  // The current launcher reports a relative entry's dir without the cwd ("/test/js/..."), and the
  // runner passes relative paths, so try both (docs/status/restore.md, launcher problems).
  const specPath = [import.meta.dir, path.join(process.cwd(), import.meta.dir)]
    .map(d => path.join(d, "../../../bun/md/spec.txt"))
    .find(p => fs.existsSync(p));
  assert.ok(specPath, "test/js/bun/md/spec.txt not found");
  const lines = fs.readFileSync(specPath, "utf8").replace(/\r\n?/g, "\n").split("\n");
  const fence = "`".repeat(32);
  let pass = 0, total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(fence + " example")) continue;
    i++;
    const input = [];
    while (lines[i] !== ".") input.push(lines[i++]);
    i++;
    const expected = [];
    while (!lines[i].startsWith(fence)) expected.push(lines[i++]);
    const out = md.html(input.join("\n").replaceAll("→", "\t") + "\n");
    total++;
    if (out.trimEnd() === expected.join("\n").replaceAll("→", "\t").trimEnd()) pass++;
  }
  assert.strictEqual(total, 652, "spec.txt example count");
  assert.ok(pass >= 649, `spec.txt: ${pass}/${total} exact matches (floor 649)`);
}

// --- hostile input -------------------------------------------------------------
// Each must return a string or throw a RangeError (stack guard), never crash or hang.
function survives(name, input, opts) {
  const t0 = performance.now();
  let out;
  try {
    out = md.html(input, opts);
  } catch (e) {
    assert.ok(e instanceof RangeError || /stack|recursion/i.test(String(e)), `${name}: unexpected ${e}`);
    return;
  }
  assert.strictEqual(typeof out, "string", name);
  const ms = performance.now() - t0;
  // Generous bound for an ASAN debug build; catches quadratic blow-ups, not micro-regressions.
  assert.ok(ms < 20000, `${name}: took ${ms | 0} ms`);
  return out;
}
const rep = (s, n) => Buffer.alloc(s.length * n, s).toString();

survives("deep blockquote", rep(">", 20000) + " x\n");
survives("deep list", Array.from({ length: 3000 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n"));
// KNOWN ISSUE (docs/security/known-issues.md § md): unmatched "[" and "[a](" runs are quadratic
// (40k "[" = 12 s, 20k "[a](" = 17 s on the ASAN debug build). Kept small here until fixed.
survives("open brackets", rep("[", 5000));
survives("close brackets", rep("]", 100000));
survives("link bomb", rep("[a](", 2500));
survives("emphasis bomb", rep("*a **a ", 30000));
survives("underscore bomb", rep("_", 100000));
survives("backtick bomb", rep("`", 100000));
survives("nested emphasis", rep("*", 5000) + "x" + rep("*", 5000));
survives("html bomb", rep("<a ", 50000));
survives("entity bomb", rep("&#", 50000) + rep("&amp;", 50000));
survives("table bomb", rep("|", 50000) + "\n" + rep("|-", 25000) + "\n" + rep("|x", 25000));
survives("many tables", rep("|a|b|\n|-|-|\n|1|2|\n\n", 5000));
// KNOWN ISSUE: link reference definitions are superlinear too (10k defs = 3.6 s on the debug build).
survives("ref def flood", Array.from({ length: 5000 }, (_, i) => `[r${i}]: /u${i}`).join("\n") + "\n" + rep("[r1] ", 5000));
survives("autolinks", rep("www.a.com https://b.c x@y.zz ", 20000), { autolinks: true });
survives("nul bytes", "a\0b\0\0# \0\n" + rep("\0", 10000));
survives("invalid utf8", Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xe2, 0x82, 0x0a, 0xf0, 0x28, 0x8c, 0xbc, 0x23, 0x20, 0xc0, 0x80]));
survives("lone surrogates", "\ud800 *\udfff* \ud83d");
survives("only newlines", rep("\n", 200000));
survives("long line", rep("a", 2_000_000));
const big = survives("5 MB document", rep("# Head\n\nSome *em* and **strong** text with `code` and [link](http://x).\n\n- item\n- item\n\n", 60000));
assert.ok(big.length > 5_000_000, "5 MB document rendered fully");

// The other entry points on hostile input.
for (const input of [rep(">", 5000) + "x", rep("*a **a ", 5000), rep("[", 2000)]) {
  for (const call of [() => md.ansi(input), () => md.render(input, {}), () => md.react(input, undefined, { reactVersion: 18 })]) {
    try {
      call();
    } catch (e) {
      assert.ok(e instanceof RangeError, String(e));
    }
  }
}

console.log("ok");
