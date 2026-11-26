#!/usr/bin/env bun
// Parity harness: how much of Bun 1.3.14's own test suite (`test/`) passes on a zun binary.
//
// Usage (run with any JS runtime that strips TS types; the real `bun` or `node` >= 23 both work):
//
//   export PATH=$PWD/vendor/llvm-21.1.8/bin:$PATH      # llvm-symbolizer, needed by the LSan suppressions
//   bun scripts/parity.ts --exec-path build/debug/bun-debug --out /tmp/parity-run
//
// Flags:
//   --exec-path <bin>   zun binary to test (default: build/debug/zun-debug, else build/debug/bun-debug)
//   --filter <glob>     only tests whose repo-relative path matches (repeatable; `*`, `**`, `?`;
//                       a pattern without glob characters is a substring match)
//   --jobs <n>          parallel test processes (default 5; the ASAN debug build is heavy)
//   --timeout <ms>      per-test timeout (default 60000, the same as runner.node.mjs for local debug runs)
//   --sample <n>        run a deterministic stratified sample of about n runnable tests (by area)
//   --out <dir>         output dir (default build/parity/<date>): results.json (full), parity.json (compact), summary.md
//   --compare <json>    an earlier parity.json; adds "newly passing / newly failing" to the summary
//   --reclassify <json> re-read a results.json, recompute crash kinds, causes and clusters from the stored
//                       output, and rewrite the reports into --out (no tests are run)
//   --list              classify only, do not run anything
//   --quiet             no per-test progress lines
//
// What it does:
//   1. Walks test/ with the same discovery rules as scripts/runner.node.mjs (isTest/isHidden).
//   2. Classifies each file by area (from its path) and by how it can run:
//        RUNNABLE  node-style tests (test/js/node/test/{parallel,sequential}, test/js/bun/test/parallel),
//                  run as `<bin> run --config=bunfig.node-test.toml <abs path>`, exactly like runner.node.mjs.
//        BLOCKED   everything else runs through `bun test` (bun:test), which is not restored yet, so its
//                  reason is "test-runner"; files that also need a module cruller removed (shell, install,
//                  css, sql, napi, ...) list that module as an extra blocker (static scan, heuristic).
//        SKIPPED   test/expectations.txt marks it SKIP for this platform (LINUX/X64/ASAN).
//   3. Runs negative/positive controls (a CJS and an ESM file that must fail, and two that must pass) through
//      the same spawn path. If a "must fail" control exits 0, passes of that module kind are UNRELIABLE.
//   4. Runs the RUNNABLE ones with a bounded pool and records PASS / UNRELIABLE / FAIL / TIMEOUT / CRASH
//      (exit status decides, like runner.node.mjs), plus a crash kind, a failure signature and a coarse cause.
//
// The environment matches runner.node.mjs spawnBun() for node tests, with three deliberate differences so
// the harness can never touch the owner's real Bun install: HOME/XDG dirs point at a throwaway dir, a
// `bun` shim pointing at --exec-path is first on PATH, and BUN_INSTALL points into the throwaway dir.
// Each pool slot also gets its own TEST_THREAD_ID (node's test/common/tmpdir.js keys its temp dir on it).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const repo = resolve(import.meta.dirname, "..");
const testRoot = join(repo, "test");

// ---------------------------------------------------------------------------------------------- args

const { values: args } = parseArgs({
  options: {
    "exec-path": { type: "string" },
    filter: { type: "string", multiple: true },
    jobs: { type: "string", default: "5" },
    timeout: { type: "string", default: "60000" },
    sample: { type: "string" },
    out: { type: "string" },
    compare: { type: "string" },
    reclassify: { type: "string" },
    list: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

function defaultExecPath(): string {
  for (const p of ["build/debug/zun-debug", "build/debug/bun-debug"]) if (existsSync(join(repo, p))) return join(repo, p);
  return join(repo, "build/debug/zun-debug");
}

const execPath = resolve(args["exec-path"] ?? defaultExecPath());
const jobs = Math.max(1, Math.min(Number(args.jobs), availableParallelism()));
const timeoutMs = Number(args.timeout);
const outDir = resolve(args.out ?? join(repo, "build/parity", new Date().toISOString().slice(0, 10)));

// ------------------------------------------------------------------------------------ discovery
// Same rules as scripts/runner.node.mjs (isJavaScript, isNodeTest, isClusterTest, isTestStrict, isHidden).

const isJavaScript = (p: string) => /\.(c|m)?(j|t)sx?$/.test(basename(p));
const isNodeTest = (p: string) =>
  isJavaScript(p) &&
  (p.includes("js/node/test/parallel/") || p.includes("js/node/test/sequential/") || p.includes("js/bun/test/parallel/"));
const isClusterTest = (p: string) => p.includes("js/node/cluster/test-") && p.endsWith(".ts");
const isTestStrict = (p: string) => isJavaScript(p) && /\.test|spec\./.test(basename(p));
const isTest = (p: string) => isNodeTest(p) || isClusterTest(p) || isTestStrict(p);
const isHidden = (p: string) => /node_modules|node.js/.test(dirname(p)) || /^\./.test(basename(p));

function* walk(rel: string): Generator<string> {
  for (const e of readdirSync(join(testRoot, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (isHidden(p)) continue;
    if (e.isFile() && isTest(p)) yield p;
    else if (e.isDirectory()) yield* walk(p);
  }
}

// ------------------------------------------------------------------------------------------ areas

// Node's own test files are named test-<module>-<what>.js. Map the leading tokens to a node module.
const nodePrefixes: [string, string][] = [
  ["child-process", "child_process"],
  ["async-hooks", "async_hooks"],
  ["async-local-storage", "async_hooks"],
  ["async-wrap", "async_hooks"],
  ["diagnostics-channel", "diagnostics_channel"],
  ["diagnostic-channel", "diagnostics_channel"],
  ["string-decoder", "string_decoder"],
  ["perf-hooks", "perf_hooks"],
  ["trace-events", "trace_events"],
  ["worker", "worker_threads"],
  ["webcrypto", "crypto"],
  ["crypto", "crypto"],
  ["event-emitter", "events"],
  ["eventemitter", "events"],
  ["eventtarget", "events"],
  ["events", "events"],
  ["event", "events"],
  ["stream2", "stream"],
  ["stream3", "stream"],
  ["streams", "stream"],
  ["stream", "stream"],
  ["readable", "stream"],
  ["http2", "http2"],
  ["https", "https"],
  ["http", "http"],
  ["fs", "fs"],
  ["path", "path"],
  ["buffer", "buffer"],
  ["util", "util"],
  ["url", "url"],
  ["whatwg-url", "url"],
  ["whatwg", "web"],
  ["webstream", "web"],
  ["webstreams", "web"],
  ["web", "web"],
  ["blob", "web"],
  ["file", "web"],
  ["abortcontroller", "web"],
  ["abortsignal", "web"],
  ["structuredclone", "web"],
  ["messagechannel", "worker_threads"],
  ["messageport", "worker_threads"],
  ["broadcastchannel", "worker_threads"],
  ["net", "net"],
  ["tls", "tls"],
  ["dgram", "dgram"],
  ["dns", "dns"],
  ["timers", "timers"],
  ["timer", "timers"],
  ["process", "process"],
  ["os", "os"],
  ["vm", "vm"],
  ["zlib", "zlib"],
  ["assert", "assert"],
  ["readline", "readline"],
  ["repl", "repl"],
  ["module", "module"],
  ["require", "module"],
  ["esm", "module"],
  ["cluster", "cluster"],
  ["console", "console"],
  ["querystring", "querystring"],
  ["punycode", "punycode"],
  ["tty", "tty"],
  ["v8", "v8"],
  ["domain", "domain"],
  ["inspector", "inspector"],
  ["sqlite", "sqlite"],
  ["wasm", "wasi"],
  ["wasi", "wasi"],
  ["single-executable", "sea"],
  ["performance", "perf_hooks"],
  ["errors", "errors"],
  ["global", "globals"],
  ["queue-microtask", "globals"],
  ["mime", "util"],
  ["sys", "util"],
  ["binding", "internals"],
  ["internal", "internals"],
  ["primordials", "internals"],
];

function nodeModuleOf(file: string): string {
  const name = basename(file).replace(/^test-/, "").replace(/\.[cm]?[jt]sx?$/, "").toLowerCase();
  let best = "";
  let mod = "other";
  for (const [prefix, m] of nodePrefixes) {
    if ((name === prefix || name.startsWith(prefix + "-") || name.startsWith(prefix + ".")) && prefix.length > best.length) {
      best = prefix;
      mod = m;
    }
  }
  return mod;
}

function areaOf(p: string): string {
  const s = p.split("/");
  if (p.startsWith("js/node/test/parallel/") || p.startsWith("js/node/test/sequential/")) return `node-suite/${nodeModuleOf(p)}`;
  if (p.startsWith("js/bun/test/parallel/")) return "bun-suite/" + (basename(p).includes("docker") ? "docker" : "http");
  if (s[0] === "js" && ["node", "bun", "web", "third_party", "deno", "sql", "valkey", "workerd", "first_party"].includes(s[1]))
    return s.length > 3 ? `js/${s[1]}/${s[2]}` : `js/${s[1]}`;
  if (s[0] === "js") return "js/other";
  if (s[0] === "cli" || s[0] === "bundler" || s[0] === "integration") return s.length > 2 ? `${s[0]}/${s[1]}` : s[0];
  if (s[0] === "napi" || s[0] === "v8") return "napi";
  if (s[0] === "regression") return "regression";
  if (s[0] === "bake") return "bake";
  return s.length > 1 ? s[0] : "other";
}

// ------------------------------------------------------------------------------------- blockers
// Modules cruller removed (docs/plan/restore-1.3.14.md, docs/GAP.md). A rule matches by path prefix
// or by a content regex. This is a static, heuristic scan: it marks a file as needing the module
// when the file plainly uses it, not when some helper deep inside does.

type Rule = { blocker: string; paths?: string[]; re?: RegExp };
const blockerRules: Rule[] = [
  { blocker: "shell", paths: ["js/bun/shell/"], re: /\bBun\.\$|import\s*\{[^}]*(?<![\w$])\$(?![\w$])[^}]*\}\s*from\s*["']bun["']|\bbun\s+exec\b|"exec",/ },
  {
    blocker: "install",
    paths: ["cli/install/", "cli/update_interactive", "cli/pm/", "cli/outdated", "cli/publish", "integration/", "js/third_party/"],
    re: /\b(bunExe\(\)|bunExe)\s*,\s*["'`](install|add|remove|update|link|unlink|pm|outdated|publish|audit|why|info|patch|patch-commit)["'`]|runBunInstall|\bbun (install|add)\b|bun_install|\bbunx\b|\bBun\.Archive\b/,
  },
  { blocker: "css", paths: ["bundler/css/", "js/bun/css/"], re: /\bBun\.color\(|css_internals|\.css["']\s*[,)]\s*$/m },
  {
    blocker: "bundler",
    paths: ["bundler/"],
    re: /\bBun\.build\(|\bitBundled\(|\bexpectBundled\(|\bBun\.plugin\(|bunExe\(\)\s*,\s*["'`]build["'`]|--compile\b|\bregisterMacro\b|with\s*\{\s*type:\s*["']macro["']/,
  },
  { blocker: "transpiler", paths: ["bundler/transpiler/", "js/bun/transpiler/"], re: /\bBun\.Transpiler\b|new Transpiler\(/ },
  { blocker: "md", paths: ["js/bun/md/"], re: /\bBun\.markdown\b/ },
  { blocker: "napi", paths: ["napi/", "v8/"], re: /node-gyp|napi\.node|\.node["']\)|process\.dlopen/ },
  { blocker: "sql", paths: ["js/sql/"], re: /["']bun:sql["']|\bBun\.sql\b|\bnew SQL\(|\bBun\.SQL\b/ },
  { blocker: "bake", paths: ["bake/"], re: /\bdevTest\(|\bBun\.serve\([^)]*development:\s*\{?\s*hmr/ },
  { blocker: "internal-for-testing", re: /["']bun:internal-for-testing["']/ },
  {
    blocker: "cli",
    paths: ["cli/run/", "cli/hot/", "cli/watch/", "cli/init/", "cli/create/", "cli/inspect/", "cli/env/", "cli/bun.test", "cli/bunfig"],
    re: /\b(bunExe\(\)|bunExe)\s*,\s*["'`](init|create|repl|upgrade|completions|x|--hot|--watch|--filter|--eval|-e|--print|-p)["'`]/,
  },
];

function blockersFor(p: string, src: string): string[] {
  const out: string[] = [];
  for (const r of blockerRules) {
    if (r.paths?.some(x => p.startsWith(x)) || (r.re && r.re.test(src))) out.push(r.blocker);
  }
  return out;
}

// ---------------------------------------------------------------------------------- expectations

const myModifiers = ["LINUX", "X64", "LINUX-X64", ...(basename(execPath).includes("debug") || basename(execPath).includes("asan") ? ["ASAN"] : [])];

function readExpectations(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const f = join(testRoot, "expectations.txt");
  if (!existsSync(f)) return m;
  for (let line of readFileSync(f, "utf8").split(/\r?\n/)) {
    line = line.replace(/#.*$/, "").trim();
    if (!line) continue;
    const mm = line.match(/^(?:\[\s*([^\]]+)\]\s*)?(\S+)\s*\[\s*([^\]]+)\]/);
    if (!mm) continue;
    const mods = mm[1]?.trim().split(/\s+/) ?? [];
    if (mods.length && !mods.some(x => myModifiers.includes(x.toUpperCase()))) continue;
    m.set(mm[2].replace(/^test\//, ""), mm[3].trim().split(/\s+/));
  }
  return m;
}

function readList(name: string): Set<string> {
  const f = join(testRoot, name);
  if (!existsSync(f)) return new Set();
  return new Set(
    readFileSync(f, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"))
      .map(l => l.replace(/^test\//, "")),
  );
}

// --------------------------------------------------------------------------------------- filters

function globToRegExp(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const filters = (args.filter ?? []).map(f => {
  const pat = f.replace(/^test\//, "");
  if (!/[*?]/.test(pat)) return (p: string) => p.includes(pat);
  const re = globToRegExp(pat);
  return (p: string) => re.test(p);
});

// ------------------------------------------------------------------------------------- classify

// UNRELIABLE = the test exited 0, but the negative control for its module kind (CJS/ESM) also exited 0,
// so a pass cannot be told apart from a swallowed failure (see runControls).
type Status = "PASS" | "UNRELIABLE" | "FAIL" | "TIMEOUT" | "CRASH" | "BLOCKED" | "SKIPPED" | "NOT_RUN";
const RAN: Status[] = ["PASS", "UNRELIABLE", "FAIL", "TIMEOUT", "CRASH"];
type Entry = {
  path: string; // relative to repo, e.g. test/js/node/test/parallel/test-fs-stat.js
  area: string;
  kind: "node" | "bun-test";
  importsBunTest: boolean;
  module: "cjs" | "esm";
  status: Status;
  blockers?: string[];
  expected?: string[];
  ms?: number;
  exitCode?: number | null;
  signal?: string | null;
  crashKind?: string;
  sanitizerNote?: string;
  signature?: string;
  cause?: string;
  output?: string;
};

const expectations = readExpectations();
const noValidateExceptions = readList("no-validate-exceptions.txt");
const noValidateLeaks = readList("no-validate-leaksan.txt");

// How the runtime will load the file: .mjs/.mts → ESM, .cjs/.cts → CJS, else nearest package.json "type",
// else ESM if the file has import/export statements (Bun's auto-detection), else CJS.
const pkgTypeCache = new Map<string, string | undefined>();
function pkgTypeOf(dir: string): string | undefined {
  if (pkgTypeCache.has(dir)) return pkgTypeCache.get(dir);
  let t: string | undefined;
  const pj = join(dir, "package.json");
  if (existsSync(pj)) {
    try {
      t = JSON.parse(readFileSync(pj, "utf8")).type ?? "none";
    } catch {}
  }
  if (t === undefined && dir !== repo && dir.startsWith(repo)) t = pkgTypeOf(dirname(dir));
  pkgTypeCache.set(dir, t);
  return t;
}
function moduleKindOf(abs: string, src: string): "cjs" | "esm" {
  if (/\.m[jt]sx?$/.test(abs)) return "esm";
  if (/\.c[jt]sx?$/.test(abs)) return "cjs";
  const t = pkgTypeOf(dirname(abs));
  if (t === "module") return "esm";
  if (t === "commonjs") return "cjs";
  return /^\s*(import\s*[\w*{"'`]|export\s+(default|const|let|var|function|class|async|\{|\*))/m.test(src) ? "esm" : "cjs";
}

const importsBunTestOf = (src: string) => /["']bun:test["']|from\s+["'](node-)?harness["']|require\(["'](node-)?harness["']\)/.test(src);

let entries: Entry[] = [];
for (const p of walk("")) {
  if (filters.length && !filters.some(f => f(p) || f("test/" + p))) continue;
  const src = readFileSync(join(testRoot, p), "utf8");
  const importsBunTest = importsBunTestOf(src);
  const exp = expectations.get(p);
  const e: Entry = { path: "test/" + p, area: areaOf(p), kind: isNodeTest(p) ? "node" : "bun-test", importsBunTest, module: moduleKindOf(join(testRoot, p), src), status: "BLOCKED" };
  if (exp) e.expected = exp;
  if (e.kind === "node") {
    // runner.node.mjs runs these through `bun test` instead of `bun run`:
    const needsBunTest =
      p.includes("needs-test") ||
      src.includes("node:test") ||
      ["js/node/test/parallel/test-fs-append-file-flush.js", "js/node/test/parallel/test-fs-write-file-flush.js", "js/node/test/parallel/test-fs-write-stream-flush.js"].includes(p);
    if (needsBunTest) {
      e.status = "BLOCKED";
      e.blockers = ["test-runner"];
    } else if (exp?.includes("SKIP")) e.status = "SKIPPED";
    else e.status = "NOT_RUN"; // runnable; set by runOne
  } else {
    e.blockers = ["test-runner", ...blockersFor(p, src)];
  }
  entries.push(e);
}

let runnable = entries.filter(e => e.kind === "node" && e.status === "NOT_RUN");

// Deterministic stratified sample: per area, keep ceil(n * share) tests chosen by hash order.
if (args.sample) {
  const want = Number(args.sample);
  const byArea = new Map<string, Entry[]>();
  for (const e of runnable) byArea.set(e.area, [...(byArea.get(e.area) ?? []), e]);
  const h = (s: string) => createHash("sha1").update(s).digest("hex");
  const keep = new Set<Entry>();
  for (const list of byArea.values()) {
    const n = Math.max(1, Math.round((want * list.length) / runnable.length));
    for (const e of [...list].sort((a, b) => (h(a.path) < h(b.path) ? -1 : 1)).slice(0, n)) keep.add(e);
  }
  // tests left out of the sample stay NOT_RUN
  runnable = runnable.filter(e => keep.has(e));
}

// ------------------------------------------------------------------------------------------- run

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_CAPTURE = 1 << 20;

function crashKindOf(out: string, signal: string | null, exitCode: number | null): string | undefined {
  if (/ERROR: LeakSanitizer|LeakSanitizer: detected memory leaks/.test(out)) return "leak";
  if (/ERROR: AddressSanitizer/.test(out)) return "asan";
  if (/AddressSanitizer: CHECK failed/.test(out)) return "asan-check";
  if (/(^|\n)panic(\(main thread\)|\(thread \d+\))?: |Bun has crashed|oh no: Bun/.test(out)) return "panic";
  if (/UndefinedBehaviorSanitizer|: runtime error: /.test(out)) return "ubsan";
  if (/ASSERTION FAILED|SHOULD NEVER BE REACHED|RELEASE_ASSERT/.test(out)) return "jsc-assert";
  if (/validateExceptionChecks|Unchecked exception|ERROR: Unchecked JS exception/.test(out)) return "exception-check";
  if (signal) return `signal:${signal}`;
  if (exitCode !== null && exitCode >= 128 + 1 && exitCode <= 128 + 31 && exitCode !== 128 + 9) return `signal:${exitCode - 128}`;
  return undefined;
}

// A short, normalized "why it failed" string used to cluster failures.
function signatureOf(out: string, status: Status, crashKind?: string): string {
  const lines = out
    .replace(ANSI, "")
    .split("\n")
    .filter(l => !l.startsWith("DEBUG: "));
  const norm = (s: string) =>
    s
      .replace(/\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, "<path>")
      .replace(/0x[0-9a-f]+/gi, "<addr>")
      .replace(/\b\d+(\.\d+)?\b/g, "N")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
  if (status === "TIMEOUT") return "TIMEOUT";
  if (crashKind === "asan") {
    const l = lines.find(l => /ERROR: AddressSanitizer/.test(l));
    const loc = lines.find(l => /^SUMMARY: AddressSanitizer/.test(l));
    return norm(`ASAN ${l?.replace(/.*ERROR: AddressSanitizer: /, "").replace(/ on (unknown )?address.*/, "") ?? ""} ${loc?.replace(/^SUMMARY: AddressSanitizer: \S+ /, "") ?? ""}`);
  }
  if (crashKind === "leak") return "LSAN leak";
  if (crashKind === "asan-check") return norm(`ASAN CHECK failed ${lines.find(l => /AddressSanitizer: CHECK failed/.test(l))?.replace(/.*CHECK failed: /, "").replace(/\(0x.*$/, "") ?? ""}`);
  if (crashKind === "ubsan") return norm(`UBSan ${lines.find(l => /: runtime error: /.test(l))?.replace(/^.*\/(\w+\.\w+:\d+):\d+: runtime error: /, "$1 ") ?? ""}`);
  if (crashKind === "panic") {
    const l = lines.find(l => /^panic(\(.*?\))?: /.test(l));
    return norm(`panic: ${l?.replace(/^panic(\(.*?\))?: /, "") ?? ""}`);
  }
  if (crashKind === "jsc-assert") return norm(`JSC ${lines.find(l => /ASSERTION FAILED|SHOULD NEVER|RELEASE_ASSERT/.test(l)) ?? ""}`);
  if (crashKind === "exception-check") return "JSC exception-check validation";
  const pats: RegExp[] = [
    /Cannot find (?:module|package) ['"][^'"]+['"]/,
    /^\s*(?:Uncaught )?(?:error: )?([A-Z]\w*Error)(?: \[(\w+)\])?: (.+)$/,
    /^error: (.+)$/,
    /^\s*(?:Uncaught )?(Error|TypeError|RangeError|SyntaxError|ReferenceError|AssertionError)\b.*$/,
    /\b(ERR_[A-Z_]+)\b/,
    /Mismatched .* function calls/,
    /not (yet )?implemented/i,
  ];
  for (const re of pats) {
    for (const l of lines) {
      const m = l.match(re);
      if (m) return norm(m[0]);
    }
  }
  if (crashKind) return crashKind;
  const last = lines.map(l => l.trim()).filter(Boolean).at(-1);
  return last ? norm(`exit ${last}`) : "no output";
}


// A coarse, human-meaningful root cause on top of the signature. The patterns come from reading
// failures by hand (docs/status/parity.md); anything unmatched falls back to its signature.
function causeOf(e: Entry): string {
  const out = e.output ?? "";
  if (e.status === "TIMEOUT") return "timeout";
  if (/Failed to load runtime entrypoint/.test(out)) return "launcher: CLI flag / -e / non-file argv not supported (cli)";
  if (/['"`]DEBUG: Resolving|DEBUG: Resolving[^\n]*\\n/.test(out)) return "debug build prints 'DEBUG: Resolving' on stderr";
  if (/(ENOENT|Cannot find module|no such file|ModuleNotFound resolving)[^\n]*\[eval\]/.test(out)) return "entry runs as '[eval]' (__filename / argv wrong)";
  if (e.crashKind === "ubsan" && e.importsBunTest) return "imports bun:test (test runner not restored)";
  if (/\bgc is not a function/.test(out)) return "globalThis.gc missing: process.argv[1] absent, so common/index.js skips its --expose-gc shim (cli)";
  const mod = out.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/);
  if (mod) return `missing module: ${mod[1].replace(/^\/.*\//, "<path>/")}`;
  if (/is not (yet )?implemented|NotImplementedError|ERR_NOT_IMPLEMENTED/i.test(out)) return "not implemented";
  if (e.crashKind) return `crash: ${e.crashKind}`;
  let src = "";
  try {
    src = readFileSync(join(repo, e.path), "utf8");
  } catch {}
  if (/process\.argv\[2\]|(fork|spawn|spawnSync|execFile|execFileSync)\(\s*(process\.execPath|process\.argv\[0\]|node)?\s*,?\s*\[?\s*__filename/.test(src))
    return "likely launcher: test re-spawns itself via __filename / argv[2] (cli)";
  if (/(process\.execPath|process\.argv\[0\])\s*,\s*\[\s*(\.\.\.[\w.]+\s*,\s*)?['"`]-/.test(src)) return "likely launcher: spawns execPath with node flags (cli)";
  if (/^\/\/ Flags:\s+--/m.test(src)) return "likely launcher: needs its '// Flags:' (common/index.js re-spawns only when argv[1] is set) (cli)";
  if (/Usage: .* path\/to\/script/.test(out)) return "launcher: CLI flag / -e / non-file argv not supported (cli)";
  if (/ERR_ASSERTION|AssertionError/.test(out)) return "assertion failed (behaviour differs)";
  return "other error";
}

function classifyOutcome(e: Entry) {
  const clean = (e.output ?? "").replace(ANSI, "");
  if (e.status !== "TIMEOUT") {
    const ck = crashKindOf(clean, e.signal ?? null, e.exitCode ?? null);
    delete e.crashKind;
    delete e.sanitizerNote;
    if (e.exitCode === 0 && !e.signal) {
      // Like runner.node.mjs, exit status decides. A sanitizer report in a run that still exited 0
      // (e.g. ASAN "CHECK failed" on a terminating Worker thread) is kept as a note, not a failure.
      e.status = "PASS";
      if (ck) e.sanitizerNote = ck;
    } else if (ck) {
      e.status = "CRASH";
      e.crashKind = ck;
    } else e.status = "FAIL";
  }
  if (e.status !== "PASS") {
    e.signature = signatureOf(clean, e.status, e.crashKind);
    e.cause = causeOf(e);
  } else {
    delete e.signature;
    delete e.cause;
  }
}

function makeShimDir(base: string): string {
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  for (const n of ["bun", "zun", basename(execPath)]) {
    const l = join(bin, n);
    rmSync(l, { force: true });
    symlinkSync(execPath, l);
  }
  return bin;
}

async function runOne(e: Entry, shimBin: string, home: string, slot: number): Promise<void> {
  const abs = e.path.startsWith("/") ? e.path : join(repo, e.path);
  const rel = e.path.replace(/^test\//, "");
  const tmp = mkdtempSync(join(tmpdir(), "zunparity-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${shimBin}:${dirname(execPath)}:${process.env.PATH}`,
    TMPDIR: tmp,
    BUN_TMPDIR: tmp,
    TEST_TMPDIR: tmp,
    USER: userInfo().username,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    BUN_INSTALL: join(home, ".zun"),
    BUN_INSTALL_CACHE_DIR: tmp,
    SHELL: process.env.SHELL || "/bin/sh",
    BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING: "1",
    BUN_GARBAGE_COLLECTOR_LEVEL: "1",
    BUN_JSC_randomIntegrityAuditRate: "1.0",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    BUN_ENABLE_CRASH_REPORTING: "0",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    BUN_DEBUG_QUIET_LOGS: "1",
    // node's test/common/tmpdir.js uses `<test root>/.tmp.<TEST_THREAD_ID>`; one id per pool slot keeps
    // parallel tests from deleting each other's files (node's own tools/test.py does the same)
    TEST_THREAD_ID: String(slot),
  };
  if (!noValidateExceptions.has(rel)) {
    env.BUN_JSC_validateExceptionChecks = "1";
    env.BUN_JSC_dumpSimulatedThrows = "1";
  }
  if (!noValidateLeaks.has(rel)) {
    env.BUN_DESTRUCT_VM_ON_EXIT = "1";
    env.ASAN_OPTIONS = "allow_user_segv_handler=1:disable_coredump=1:detect_leaks=1:abort_on_error=1";
    env.LSAN_OPTIONS = `malloc_context_size=100:print_suppressions=0:suppressions=${join(testRoot, "leaksan.supp")}`;
  }
  const start = performance.now();
  let out = "";
  let timedOut = false;
  const append = (b: Buffer) => {
    if (out.length < MAX_CAPTURE) out += b.toString("utf8");
  };
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(res => {
    const child = spawn(execPath, ["run", `--config=${join(repo, "bunfig.node-test.toml")}`, abs], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so a timeout kills grandchildren too
    });
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    const t = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("error", err => {
      out += `\nspawn error: ${err}`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(t);
      // reap anything left in the group (servers the test forgot to close, etc.)
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      res({ code, signal });
    });
  });
  e.ms = Math.round(performance.now() - start);
  e.exitCode = code;
  e.signal = signal;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
  const clean = out.replace(ANSI, "");
  e.status = timedOut ? "TIMEOUT" : "FAIL";
  e.output = clean.length > 6000 ? clean.slice(0, 3000) + "\n[...]\n" + clean.slice(-3000) : clean;
  classifyOutcome(e);
  if (e.status === "PASS" && !e.sanitizerNote) delete e.output;
}

function makeSandbox() {
  const work = mkdtempSync(join(tmpdir(), "zunparity-home-"));
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  return { work, home, shimBin: makeShimDir(work) };
}

// Negative/positive controls, run with the exact same spawn path as the tests. A test result is only
// trusted if the binary demonstrably reports a failure for its module kind. Known bug (2026-11-26, cruller
// launcher): a synchronous top-level throw in an entry that uses require() exits 0 with no output.
type Control = { name: string; module: "cjs" | "esm"; expect: "fail" | "pass"; exitCode: number | null; status: string; ok: boolean };
const controlSources: { name: string; file: string; module: "cjs" | "esm"; expect: "fail" | "pass"; src: string }[] = [
  { name: "cjs-sync-assert-fails", file: "cjs-fail.js", module: "cjs", expect: "fail", src: "'use strict';\nconst assert = require('assert');\nassert.strictEqual(1, 2);\n" },
  { name: "cjs-sync-throw-fails", file: "cjs-throw.js", module: "cjs", expect: "fail", src: "const path = require('path');\nthrow new Error('control ' + path.sep);\n" },
  { name: "esm-sync-assert-fails", file: "esm-fail.mjs", module: "esm", expect: "fail", src: "import assert from 'node:assert';\nassert.strictEqual(1, 2);\n" },
  { name: "cjs-ok-passes", file: "cjs-ok.js", module: "cjs", expect: "pass", src: "const assert = require('assert');\nassert.strictEqual(1, 1);\n" },
  { name: "esm-ok-passes", file: "esm-ok.mjs", module: "esm", expect: "pass", src: "import assert from 'node:assert';\nassert.strictEqual(1, 1);\n" },
];

async function runControls(): Promise<Control[]> {
  const sb = makeSandbox();
  const dir = join(sb.work, "controls");
  mkdirSync(dir, { recursive: true });
  const out: Control[] = [];
  for (const c of controlSources) {
    writeFileSync(join(dir, c.file), c.src);
    const e: Entry = { path: join(dir, c.file), area: "control", kind: "node", importsBunTest: false, module: c.module, status: "NOT_RUN" };
    await runOne(e, sb.shimBin, sb.home, 0);
    const failed = e.exitCode !== 0 || e.status === "TIMEOUT";
    out.push({ name: c.name, module: c.module, expect: c.expect, exitCode: e.exitCode ?? null, status: e.status, ok: c.expect === "fail" ? failed : !failed });
  }
  rmSync(sb.work, { recursive: true, force: true });
  return out;
}

// A module kind is reliable only if every "must fail" control for it failed.
function reliability(controls: Control[]) {
  const r = { cjs: true, esm: true };
  for (const c of controls) if (c.expect === "fail" && !c.ok) r[c.module] = false;
  return r;
}

function applyReliability(controls: Control[]) {
  const rel = reliability(controls);
  for (const e of entries) {
    if (e.status === "UNRELIABLE") e.status = "PASS";
    if (e.status === "PASS" && !rel[e.module]) e.status = "UNRELIABLE";
  }
}

async function runAll(list: Entry[]) {
  mkdirSync(outDir, { recursive: true });
  const { work, home, shimBin } = makeSandbox();
  let next = 0;
  let done = 0;
  const t0 = Date.now();
  const worker = async (slot: number) => {
    while (next < list.length) {
      const e = list[next++];
      await runOne(e, shimBin, home, slot);
      done++;
      if (!args.quiet) {
        const eta = Math.round((((Date.now() - t0) / done) * (list.length - done)) / 1000);
        console.log(`[${done}/${list.length} eta ${eta}s] ${e.status.padEnd(7)} ${(e.ms! / 1000).toFixed(1).padStart(5)}s ${e.path}${e.signature ? "  — " + e.signature.slice(0, 80) : ""}`);
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, (_, i) => worker(i)));
  rmSync(work, { recursive: true, force: true });
}

function revisionOf(bin: string): string {
  try {
    const r = spawnSync(bin, ["--revision"], { encoding: "utf8", env: { ...process.env, BUN_DEBUG_QUIET_LOGS: "1" } });
    return (r.stdout || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------------------- report

function count<T>(xs: T[], key: (x: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
}

// parity.json is committed: one line per top-level scalar, per area and per test, so diffs stay readable.
function stringifyCompact(o: Record<string, unknown>): string {
  const lines = Object.entries(o).map(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v) && ["areas", "results", "causes", "blockedByReason", "blockedByModule", "byModule"].includes(k)) {
      const inner = Object.entries(v).map(([ik, iv]) => `  ${JSON.stringify(ik)}: ${JSON.stringify(iv)}`);
      return `${JSON.stringify(k)}: {\n${inner.join(",\n")}\n}`;
    }
    if (Array.isArray(v)) return `${JSON.stringify(k)}: [\n${v.map(x => "  " + JSON.stringify(x)).join(",\n")}\n]`;
    return `${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

// Short per-test key for parity.json (keeps the committed file small): test/js/node/test/X → node/X.
const shortKey = (p: string) => p.replace(/^test\/js\/node\/test\//, "node/").replace(/^test\/js\/bun\/test\//, "bun/").replace(/^test\//, "");

function pct(a: number, b: number) {
  return b ? `${((100 * a) / b).toFixed(1)}%` : "–";
}

type Meta = { revision: string; date: string; wallSeconds: number; binary: string; jobs: number; timeoutMs: number; sample: number | null; filter: string[] | null; controls: Control[] };

function writeReports(meta: Meta) {
  const ran = entries.filter(e => RAN.includes(e.status));
  const st = (s: Status) => entries.filter(e => e.status === s).length;
  const blocked = entries.filter(e => e.status === "BLOCKED");
  const reasonOf = (e: Entry) => (e.blockers!.length === 1 ? "test-runner only" : `test-runner + ${e.blockers!.slice(1).join(" + ")}`);
  const perBlocker = new Map<string, number>();
  for (const e of blocked) for (const b of e.blockers!) perBlocker.set(b, (perBlocker.get(b) ?? 0) + 1);

  // areas
  const areaRows = new Map<string, Record<string, number>>();
  for (const e of entries) {
    const r = areaRows.get(e.area) ?? { total: 0, PASS: 0, UNRELIABLE: 0, FAIL: 0, TIMEOUT: 0, CRASH: 0, BLOCKED: 0, SKIPPED: 0, NOT_RUN: 0 };
    r.total++;
    r[e.status]++;
    areaRows.set(e.area, r);
  }

  // clusters
  const failing = ran.filter(e => e.status !== "PASS" && e.status !== "UNRELIABLE");
  const clusters = [...count(failing, e => e.signature ?? "?")].sort((a, b) => b[1] - a[1]);
  const causes = [...count(failing, e => e.cause ?? "?")].sort((a, b) => b[1] - a[1]);

  const compact = {
    schema: 1,
    date: meta.date,
    target: "Bun 1.3.14 test suite (test/ as kept by cruller)",
    binary: meta.binary,
    revision: meta.revision,
    jobs: meta.jobs,
    timeoutMs: meta.timeoutMs,
    sample: meta.sample,
    filter: meta.filter,
    wallSeconds: meta.wallSeconds,
    controls: meta.controls,
    reliable: reliability(meta.controls),
    totals: {
      files: entries.length,
      runnable: entries.filter(e => e.kind === "node" && e.status !== "BLOCKED" && e.status !== "SKIPPED").length,
      ran: ran.length,
      pass: st("PASS"),
      unreliable: st("UNRELIABLE"),
      passWithSanitizerNote: entries.filter(e => e.sanitizerNote).length,
      fail: st("FAIL"),
      timeout: st("TIMEOUT"),
      crash: st("CRASH"),
      skipped: st("SKIPPED"),
      notRun: st("NOT_RUN"),
      blocked: blocked.length,
    },
    byModule: Object.fromEntries(
      (["cjs", "esm"] as const).map(m => {
        const xs = ran.filter(e => e.module === m);
        return [m, Object.fromEntries([["ran", xs.length], ...RAN.map(s => [s.toLowerCase(), xs.filter(e => e.status === s).length])])];
      }),
    ),
    blockedByReason: Object.fromEntries([...count(blocked, reasonOf)].sort((a, b) => b[1] - a[1])),
    blockedByModule: Object.fromEntries([...perBlocker].sort((a, b) => b[1] - a[1])),
    areas: Object.fromEntries([...areaRows].sort()),
    causes: Object.fromEntries(causes),
    clusters: clusters.slice(0, 40).map(([signature, n]) => ({ signature, n })),
    // per-test status for runs, so later runs can be diffed (paths are relative to test/)
    resultKeys: { "node/": "test/js/node/test/", "bun/": "test/js/bun/test/" },
    results: Object.fromEntries(ran.map(e => [shortKey(e.path), e.status === "CRASH" ? `CRASH:${e.crashKind}` : e.status])),
  };

  writeFileSync(join(outDir, "results.json"), JSON.stringify({ ...compact, entries }, null, 1));
  writeFileSync(join(outDir, "parity.json"), stringifyCompact(compact));

  // markdown
  const t = compact.totals;
  const md: string[] = [];
  md.push(`# Parity run ${meta.date}`, "");
  md.push(`Binary \`${meta.binary}\` revision \`${meta.revision}\`, ${meta.jobs} jobs, timeout ${meta.timeoutMs / 1000}s, wall ${meta.wallSeconds}s.`);
  if (meta.sample) md.push(`**Sample:** ${t.ran} of ${t.runnable} runnable tests (stratified by area).`);
  if (meta.filter) md.push(`Filter: ${meta.filter.join(", ")}`);
  md.push("");
  md.push("| Test files | Runnable | Ran | Pass | Unreliable pass | Fail | Timeout | Crash | Not run | Skipped | Blocked |");
  md.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  md.push(`| ${t.files} | ${t.runnable} | ${t.ran} | ${t.pass} (${pct(t.pass, t.ran)}) | ${t.unreliable} (${pct(t.unreliable, t.ran)}) | ${t.fail} | ${t.timeout} | ${t.crash} | ${t.notRun} | ${t.skipped} | ${t.blocked} |`);
  if (t.passWithSanitizerNote) md.push("", `${t.passWithSanitizerNote} passing tests printed a sanitizer report but exited 0 (see \`sanitizerNote\` in results.json).`);
  md.push("", "## Controls", "", "| Control | Module | Expect | Exit | OK |", "|---|---|---|---:|---|");
  for (const c of meta.controls) md.push(`| ${c.name} | ${c.module} | ${c.expect} | ${c.exitCode} | ${c.ok ? "✅" : "❌"} |`);
  md.push("", `Reliable: CJS ${compact.reliable.cjs ? "yes" : "**NO**"}, ESM ${compact.reliable.esm ? "yes" : "**NO**"}. A run's passes for an unreliable module kind are reported as UNRELIABLE, not PASS.`);
  md.push("", "## By module kind", "", "| Kind | Ran | Pass | Unreliable | Fail | Timeout | Crash |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const [m, r] of Object.entries(compact.byModule) as [string, Record<string, number>][])
    md.push(`| ${m} | ${r.ran} | ${r.pass} | ${r.unreliable} | ${r.fail} | ${r.timeout} | ${r.crash} |`);
  md.push("", "## Blocked by reason", "", "| Reason | Files |", "|---|---:|");
  for (const [k, v] of Object.entries(compact.blockedByReason)) md.push(`| ${k} | ${v} |`);
  md.push("", "## Per area", "", "| Area | Files | Pass | Unreliable | Fail | Timeout | Crash | Not run | Skipped | Blocked | Pass rate (of ran) | Pass + unreliable |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [a, r] of [...areaRows].sort()) {
    const ranN = r.PASS + r.UNRELIABLE + r.FAIL + r.TIMEOUT + r.CRASH;
    md.push(`| ${a} | ${r.total} | ${r.PASS} | ${r.UNRELIABLE} | ${r.FAIL} | ${r.TIMEOUT} | ${r.CRASH} | ${r.NOT_RUN} | ${r.SKIPPED} | ${r.BLOCKED} | ${pct(r.PASS, ranN)} | ${pct(r.PASS + r.UNRELIABLE, ranN)} |`);
  }
  md.push("", "## Failure causes", "", "| Tests | Cause | Examples |", "|---:|---|---|");
  for (const [c, n] of causes) {
    const ex = failing.filter(e => e.cause === c).slice(0, 3).map(e => basename(e.path)).join(", ");
    md.push(`| ${n} | ${c} | ${ex} |`);
  }
  md.push("", "## Failure clusters (by signature)", "", "| Tests | Signature | Examples |", "|---:|---|---|");
  for (const [sig, n] of clusters.slice(0, 40)) {
    const ex = failing.filter(e => e.signature === sig).slice(0, 3).map(e => basename(e.path)).join(", ");
    md.push(`| ${n} | \`${sig.replace(/\|/g, "\\|").replace(/`/g, "'")}\` | ${ex} |`);
  }
  if (args.compare && existsSync(args.compare)) {
    const prev = JSON.parse(readFileSync(args.compare, "utf8"));
    const now = compact.results as Record<string, string>;
    // older files used keys relative to test/; normalize to the short form
    const before: Record<string, string> = {};
    for (const [k, v] of Object.entries(prev.results ?? {}) as [string, string][]) before[k.startsWith("js/") ? shortKey("test/" + k) : k] = v;
    // "ok" = exited 0 (PASS or UNRELIABLE), so runs stay comparable while a module kind is unreliable
    const ok = (v?: string) => v === "PASS" || v === "UNRELIABLE";
    const gained = Object.keys(now).filter(k => ok(now[k]) && before[k] && !ok(before[k]));
    const lost = Object.keys(now).filter(k => !ok(now[k]) && ok(before[k]));
    const prevOk = Object.values(before).filter(ok).length;
    md.push("", `## Compared with ${prev.date} (\`${prev.revision}\`)`, "");
    md.push(`Exited 0 (pass + unreliable): ${prevOk} → ${t.pass + t.unreliable}. Verified pass: ${prev.totals?.pass} → ${t.pass}. Newly exiting 0: ${gained.length}. Newly failing: ${lost.length}.`, "");
    for (const k of lost) md.push(`- ❌ ${k} (${now[k]})`);
    for (const k of gained) md.push(`- ✅ ${k}`);
  }
  writeFileSync(join(outDir, "summary.md"), md.join("\n") + "\n");
  console.log(md.slice(0, 8).join("\n"));
  console.log(`\nwrote ${join(outDir, "summary.md")}, parity.json, results.json`);
}

// ------------------------------------------------------------------------------------------ main

mkdirSync(outDir, { recursive: true });
if (args.reclassify) {
  const prev = JSON.parse(readFileSync(args.reclassify, "utf8"));
  entries = prev.entries;
  for (const e of entries) {
    if (existsSync(join(repo, e.path))) {
      const src = readFileSync(join(repo, e.path), "utf8");
      e.importsBunTest = importsBunTestOf(src);
      e.module = moduleKindOf(join(repo, e.path), src);
    }
    if (RAN.includes(e.status)) classifyOutcome(e);
  }
  // Controls belong to the binary that produced the results. Older results.json files have none;
  // then run them now against --exec-path, which must be that same binary.
  let controls: Control[] = prev.controls ?? [];
  if (!controls.length) {
    if (!args["exec-path"] || !existsSync(execPath)) {
      console.error("results have no controls; pass --exec-path <the same binary> so they can be run now");
      process.exit(2);
    }
    const rev = revisionOf(execPath);
    if (rev !== prev.revision) {
      console.error(`--exec-path revision ${rev} != results revision ${prev.revision}`);
      process.exit(2);
    }
    controls = await runControls();
  }
  applyReliability(controls);
  writeReports({
    revision: prev.revision,
    date: prev.date,
    wallSeconds: prev.wallSeconds,
    binary: prev.binary,
    jobs: prev.jobs,
    timeoutMs: prev.timeoutMs,
    sample: prev.sample,
    filter: prev.filter,
    controls,
  });
} else {
  const date = new Date().toISOString();
  if (!args.list && !existsSync(execPath)) {
    console.error(`no binary at ${execPath} (pass --exec-path)`);
    process.exit(2);
  }
  const revision = existsSync(execPath) ? revisionOf(execPath) : "none";
  console.log(`zun parity: ${entries.length} test files, ${runnable.length} to run, ${jobs} jobs, binary ${execPath} (${revision})`);
  const t0 = Date.now();
  const controls = existsSync(execPath) ? await runControls() : [];
  for (const c of controls) console.log(`control ${c.name}: exit ${c.exitCode} ${c.ok ? "ok" : "WRONG (results for " + c.module + " will be UNRELIABLE)"}`);
  if (!args.list) await runAll(runnable);
  applyReliability(controls);
  writeReports({
    revision,
    date,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    binary: basename(execPath),
    jobs,
    timeoutMs,
    sample: args.sample ? Number(args.sample) : null,
    filter: args.filter ?? null,
    controls,
  });
}
