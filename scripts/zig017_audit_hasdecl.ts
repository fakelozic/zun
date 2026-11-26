#!/usr/bin/env bun
/**
 * Audit helper for Zig 0.17's `@hasDecl` change: it is now true only for `pub`
 * declarations (0.16 also saw non-pub decls in the same file). That can silently
 * flip a comptime branch, so every `@hasDecl(T, "name")` needs a look.
 *
 * Usage: bun scripts/zig017_audit_hasdecl.ts [paths...]   (default: src)
 *
 * 0.16 only saw a non-pub declaration when it was in the *same file* as the
 * `@hasDecl` call, so only those calls can change meaning. For each call with a
 * literal name it looks for declarations of that name and marks the call:
 *   ok        no non-pub declaration of `name` in the calling file: same answer as 0.16
 *   CHECK     the calling file declares `name` without `pub`: 0.16 may have said true,
 *             0.17 says false. Read it (and fix with `pub`) by hand.
 *   DYNAMIC   the name is not a string literal: read the call by hand
 * Output is meant to be pasted into docs/status/zig-017.md and finished by a human.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codeMask } from "./fix_zig017.ts";

function* zigFiles(p: string): Generator<string> {
  const st = statSync(p);
  if (st.isFile()) {
    if (p.endsWith(".zig")) yield p;
    return;
  }
  for (const e of readdirSync(p)) yield* zigFiles(join(p, e));
}

const roots = process.argv.slice(2).filter(a => !a.startsWith("--"));
if (roots.length === 0) roots.push("src");

const files = roots.flatMap(r => [...zigFiles(r)]);
const texts = new Map(files.map(f => [f, readFileSync(f, "utf8")]));

/** name -> list of "file:line pub?" for every container-level-looking declaration */
const decls = new Map<string, { at: string; pub: boolean }[]>();
const declRe = /^[ \t]*(pub\s+)?(?:export\s+|extern\s+(?:"[^"]*"\s+)?|inline\s+|noinline\s+|threadlocal\s+)*(const|var|fn)\s+(@"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/gm;
for (const [f, src] of texts) {
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) {
    let name = m[3];
    if (name.startsWith('@"')) name = name.slice(2, -1);
    const line = src.slice(0, m.index).split("\n").length;
    (decls.get(name) ?? decls.set(name, []).get(name)!).push({ at: `${f}:${line}`, pub: !!m[1] });
  }
}

const callRe = /@hasDecl\(\s*([^,]+?)\s*,\s*("([^"]+)"|[^)]+)\)/g;
const rows: string[] = [];
for (const [f, src] of texts) {
  const mask = codeMask(src);
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src))) {
    if (!mask[m.index]) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const where = `${f}:${line}`;
    if (!m[3]) {
      rows.push(`DYNAMIC  ${where}  @hasDecl(${m[1]}, ${m[2]})`);
      continue;
    }
    const ds = decls.get(m[3]) ?? [];
    const nonPub = ds.filter(d => !d.pub && d.at.startsWith(f + ":"));
    if (nonPub.length === 0) rows.push(`ok       ${where}  @hasDecl(${m[1]}, "${m[3]}")`);
    else rows.push(`CHECK    ${where}  @hasDecl(${m[1]}, "${m[3]}")  non-pub: ${nonPub.map(d => d.at).join(", ")}`);
  }
}
rows.sort();
for (const r of rows) console.log(r);
const count = (k: string) => rows.filter(r => r.startsWith(k)).length;
console.log(`\n${rows.length} calls: ${count("ok")} ok, ${count("CHECK")} CHECK, ${count("DYNAMIC")} DYNAMIC`);
