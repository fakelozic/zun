# Zig knowledge bank

This is zun's shared memory for writing Zig: **Zig 0.17.1**, which is the latest
stable release as of 2026-11-26. Zig breaks APIs in every release, and most model
training data and blog posts describe 0.11–0.14. Trust this folder over memory.

## The one rule

**Verify before you write it down.** A fact goes into this bank only after one of
these checks:

1. It compiles and passes in `probes/` (`zig test docs/zig/probes/<file>.zig`).
2. You read it in the installed std source:
   `$(dirname $(readlink -f $(which zig)))/lib/std/`.
3. You read it in `upstream/` (the official langref or release notes).

When a fact turns out wrong, fix it here in the same change.

## Contents

| File | What it is |
|------|------------|
| [cheatsheet-0.17.md](cheatsheet-0.17.md) | Verified idioms for everyday 0.17 code (main, Io, writers, containers, allocators, tests, build.zig) |
| [migration-to-0.17.md](migration-to-0.17.md) | What broke in 0.15 → 0.16 → 0.17, with how often each pattern shows up in the cruller code |
| [probes/](probes/) | Small runnable tests. Each one checks a cheatsheet claim |
| [upstream/](upstream/) | Official langref 0.17.1 and the 0.15.1 / 0.16.0 / 0.17.0 release notes as Markdown. Re-fetch with `scripts/fetch-zig-docs.sh` |
| [lessons.md](lessons.md) | Running log of things we learned the hard way while working on zun |

## Searching upstream docs

```sh
grep -n "^## \|^### " docs/zig/upstream/release-notes-0.17.0.md   # table of contents
grep -n -i "ArrayList" docs/zig/upstream/release-notes-0.1*.md     # when/how an API changed
grep -n "^## \|^### " docs/zig/upstream/langref-0.17.1.md | less   # language reference sections
```

For std APIs the source is the documentation. Read
`lib/std/<module>.zig` directly. `zig std` also serves browsable std docs locally.

## Checking the probes

```sh
for f in docs/zig/probes/*.zig; do zig test "$f" || echo "FAILED: $f"; done   # hello.zig: use `zig run`
```

Run this whenever the Zig version changes. A failing probe means a cheatsheet line is out of date.
