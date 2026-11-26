#!/usr/bin/env bun
/**
 * restore-module: copy one module back from Bun 1.3.14 and run the mechanical migrations.
 *
 * Usage:
 *   bun scripts/restore-module.ts --from=<bun-v1.3.14 checkout> <module> [--force] [--no-codemod]
 *
 *   <module>      name of a manifest: scripts/restore/<module>.files (one repo-relative path per
 *                 line; a path ending in "/" means every git-tracked file under it upstream; "#" comments)
 *   --from=DIR    a clean `git clone --branch bun-v1.3.14` of oven-sh/bun (see AGENTS.md)
 *   --force       overwrite files that already exist here and differ from upstream
 *   --no-codemod  copy only (skip `scripts/fix_zig017.ts`)
 *
 * What it does (docs/status/restore.md, "Restore recipe"):
 *   1. checks that --from is exactly the pinned upstream commit (UPSTREAM_COMMIT) and that the
 *      listed paths are unmodified there (`git status --porcelain`);
 *   2. hashes every upstream file (sha256) and compares with scripts/restore/<module>.lock;
 *      the first run writes the lock, later runs fail if upstream bytes ever differ;
 *   3. copies the files into this repo (refuses to overwrite a different existing file without --force);
 *   4. runs `bun scripts/fix_zig017.ts` on the copied .zig files, then its `--report` mode.
 * Hand fixes come after, in their own commit, so `git show` of that commit is the replayable port patch.
 *
 * Cruller's scripts/fix_zig016_*.py are NOT run: they are exact, per-file replacements for files that
 * were already in cruller (all of them are applied in zun). For restored code they are a library of
 * worked 0.15 -> 0.16 examples, together with `diff U/src/<f> src/<f>` for kept files.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** `bun-v1.3.14`. Never restore from anything else: parity is measured against this release. */
export const UPSTREAM_COMMIT = "0d9b296af33f2b851fcbf4df3e9ec89751734ba4";

const ROOT = resolve(import.meta.dir, "..");

function die(msg: string): never {
  console.error(`restore-module: ${msg}`);
  process.exit(1);
}

function git(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) die(`git ${args.join(" ")} failed in ${dir}:\n${r.stderr}`);
  return r.stdout;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readManifest(module: string): string[] {
  if (!/^[a-z0-9_.-]+$/.test(module)) die(`bad module name: ${module}`);
  const path = join(ROOT, "scripts/restore", `${module}.files`);
  if (!existsSync(path)) die(`no manifest ${path}`);
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map(l => l.replace(/#.*/, "").trim())
    .filter(Boolean);
  for (const e of entries) {
    // repo-relative only: no absolute paths, no "..", no hidden tricks
    if (e.startsWith("/") || e.split("/").includes("..")) die(`manifest entry escapes the repo: ${e}`);
  }
  return entries;
}

function readLock(module: string): Map<string, string> | null {
  const path = join(ROOT, "scripts/restore", `${module}.lock`);
  if (!existsSync(path)) return null;
  const m = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [hash, file] = line.split(/\s+/, 2);
    m.set(file, hash);
  }
  return m;
}

function main() {
  const args = process.argv.slice(2);
  const from = args.find(a => a.startsWith("--from="))?.slice("--from=".length);
  const force = args.includes("--force");
  const codemod = !args.includes("--no-codemod");
  const module = args.find(a => !a.startsWith("--"));
  if (!module) die("usage: bun scripts/restore-module.ts --from=<bun-v1.3.14 checkout> <module>");
  const entries = readManifest(module);

  if (!from) die("--from=<bun-v1.3.14 checkout> is required");
  const up = resolve(from);
  const head = git(up, ["rev-parse", "HEAD"]).trim();
  if (head !== UPSTREAM_COMMIT) die(`${up} is at ${head}, expected bun-v1.3.14 = ${UPSTREAM_COMMIT}`);
  const dirty = git(up, ["status", "--porcelain", "--", ...entries]).trim();
  if (dirty) die(`upstream checkout has local changes in the listed paths:\n${dirty}`);

  // Expand directories to the git-tracked files under them (no build output, no untracked junk).
  const files: string[] = [];
  for (const e of entries) {
    const listed = git(up, ["ls-files", "-z", "--", e]).split("\0").filter(Boolean);
    if (listed.length === 0) die(`nothing tracked upstream at ${e}`);
    files.push(...listed);
  }
  files.sort();

  const lock = readLock(module);
  const hashes = new Map<string, string>();
  for (const f of files) {
    const h = sha256(join(up, f));
    hashes.set(f, h);
    if (lock) {
      const want = lock.get(f);
      if (!want) die(`${f} is not in scripts/restore/${module}.lock (manifest changed? delete the lock to re-pin)`);
      if (want !== h) die(`sha256 mismatch for upstream ${f}: lock ${want}, got ${h}`);
    }
  }
  if (lock && lock.size !== files.length) die(`lock lists ${lock.size} files, manifest expands to ${files.length}`);

  const copied: string[] = [];
  for (const f of files) {
    const src = join(up, f);
    const dst = join(ROOT, f);
    if (existsSync(dst)) {
      if (sha256(dst) === hashes.get(f)) continue; // already identical
      if (!force) die(`${f} exists here and differs from upstream (ported already?). Use --force to overwrite.`);
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied.push(f);
  }

  if (!lock) {
    const body =
      `# sha256 of the upstream files restored by scripts/restore/${module}.files\n` +
      `# upstream: oven-sh/bun bun-v1.3.14 = ${UPSTREAM_COMMIT}\n` +
      files.map(f => `${hashes.get(f)}  ${f}`).join("\n") +
      "\n";
    writeFileSync(join(ROOT, "scripts/restore", `${module}.lock`), body);
    console.log(`wrote scripts/restore/${module}.lock (${files.length} files)`);
  }
  console.log(`copied ${copied.length} of ${files.length} files`);

  const zigFiles = copied.filter(f => f.endsWith(".zig"));
  if (codemod && zigFiles.length > 0) {
    for (const extra of [[], ["--report"]]) {
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/fix_zig017.ts"), ...extra, ...zigFiles], {
        cwd: ROOT,
        stdio: "inherit",
      });
      if (r.status !== 0) die(`fix_zig017 ${extra.join(" ")} failed`);
    }
  }
  console.log("next: build (docs/build.md), fix the rest by hand in a separate commit, update docs/status/restore.md");
}

if (import.meta.main) main();
