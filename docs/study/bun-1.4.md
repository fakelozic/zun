# Bun 1.4.x: the Rust Bun ("current Bun", the parity target)

Latest tag checked: `bun-v1.4.5` (also installed locally as the dev `bun`).
There are **zero** Zig files. It's a Cargo workspace.

## Size by language (cloc, excluding `test/`)

| Language | 1.3.14 | 1.4.5 |
|----------|-------:|------:|
| Zig | 569,910 | 0 |
| Rust | 1,501 | **1,360,993** |
| C++ | 210,394 | 171,647 |
| C | 189,805 | 196,262 |
| TypeScript | 119,017 | 165,583 |

## Good news: mostly the same module map

Most Rust crates keep the Zig directory names (`src/runtime`, `src/install`, `src/bundler`,
`src/css`, `src/js_parser`, …), so `src/<x>/` usually lines up between 1.3.14 and 1.4.5. Known moves:

| 1.3.14 (Zig) | 1.4.5 (Rust) |
|--------------|--------------|
| `src/shell`, `src/test_runner`, `src/napi`, `src/bake` | under `src/runtime/` |
| `src/string` | `src/bun_core/string` |
| `src/interchange` (json/toml/yaml…) | `src/parsers` |
| `src/js_parser/ast/` | `src/ast` (the `bun_ast` crate) |

## Ported subsystems grew (Rust lines vs Zig 1.3.14 lines)

runtime 343k vs 126k · install 107k vs 54k · bundler 54k vs 31k · jsc 53k vs 35k ·
js_parser 49k + ast 18k vs 43k (the Zig number includes `ast/`) · http 19k vs 10k · resolver 16k vs 10k. Some of the growth is
Rust verbosity and some is new behaviour. We have to tell the two apart per module.

## New since 1.3.14 (none of this exists in Zig anywhere)

(`ast` and `parsers` are *not* new: they are split-out versions of Zig code, see the table above.)

| Crate | Rust lines | What it is (from its crate docs) |
|-------|-----------:|----------------------------------|
| `lint` | 326k | `bun lint`: ESLint-style linter with rule plugins (eslint, typescript, unicorn, react, jest, json, markdown, oxlint sets) |
| `sema` | 229k | `bun check`: a **TypeScript type checker**, largely ported from Microsoft's **typescript-go** (Go, Apache-2.0) |
| `format` | 117k | `bun format`: a Prettier-compatible formatter (Biome IR + port of `oxc_formatter`, MIT) |
| `react_compiler` | 61k | built-in React Compiler lowering |
| `spawn` | 5k | process spawning split into its own crate |

User docs for these are in `docs/lint/`, `docs/format/`, `docs/runtime/check.mdx` and `docs/typescript-6.mdx` in the 1.4.5 tree.

## What this means for zun

- Reaching **1.3.14 parity** means restoring and porting Zig we already have. That's mechanical.
- Reaching **1.4.x parity** means a second, much bigger effort: about 720k lines of new tooling (lint + sema + format + react_compiler)
  that exists only in Rust, plus behaviour drift in the ported modules.
- `bun check` is a port of typescript-go. Zun's end-state languages include **Go**, so zun could
  **use typescript-go directly** instead of porting a type checker to Zig. That's a big shortcut to keep in mind.
- Keep a changelog of 1.3.14 → 1.4.x behaviour differences (from release notes and the Bun test suite) as the parity checklist.
