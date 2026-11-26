# SC-2: archives were verified and then re-opened by path (check/use race)

- **Status:** fixed (this commit) for downloads and archive extraction; publication into a shared `vendor/`/cache is SC-1
- **Severity:** high on a shared or multi-user cache, low on a single-user dev box; security-relevant (supply chain)
- **Found by / date:** security review `docs/security/review-2026-11-26-sol.md` (SC-2), confirmed 2026-11-26

## Symptom
A process able to write the build cache could replace an archive after its sha256 was checked and before `tar`
read it, and the build would extract and compile the replacement while stamping the tree with the *pinned* sha256.

## Root cause
Three verify-by-path / use-by-path pairs, all from `eaca93d` (which added verification on top of upstream's
download-then-extract code without changing how files were opened):
1. `downloadWithRetry` streamed into `<dest>.<pid>.partial` with `createWriteStream(path)` (O_TRUNC, not O_EXCL; a
   pre-planted file or symlink at that predictable name was followed), verified it by name, then renamed it by name.
2. `fetchDep` verified the shared cached tarball `cache/<name>-<hash>.tar.gz` in place, then (after deleting and
   recreating `dest`) `extractTarGz` opened the same *name* again.
3. `fetchPrebuilt` downloaded to `<dest>.<pid>.<t>.tar.gz` and staged in `<dest>.<pid>.<t>.staging`, both in the
   shared parent dir, created non-exclusively.
The verification proved something about the file at a path at one instant; tar consumed whatever was at that path later.

## Why it wasn't caught
The supply-chain checks (wrong/missing/correct pin) are single-process and sequential. None models a second writer.

## Fix
- `makePrivateDir(near)` (download.ts): `mkdtemp` next to the destination (same filesystem, mode 0700, unpredictable
  name). Only the build user can touch its contents.
- `downloadWithRetry` writes the body (or copies a prefetch file) into that directory with `flags: "wx"` /
  `COPYFILE_EXCL`, verifies it there, then renames it to `dest`.
- `fetchDep` copies the cached tarball into its own private directory (`COPYFILE_EXCL`), verifies **that copy** and
  extracts **that copy**. On a miss it downloads into the private directory, extracts from it, and refreshes the cache
  from the verified copy (exclusive temp + rename). The shared cache is never verified or read in place.
- `fetchPrebuilt` downloads, verifies, extracts and stamps inside one private directory and publishes with a single
  rename. Two hardening siblings in the same function: the hoisted top-level entry must be a real directory (not a
  symlink, which would be renamed to `dest`), and the concurrent-winner branch now also requires the landed `.sha256`
  to equal the pin, not just `.identity`.

Verified bytes and extracted bytes are now the same file in a directory the attacker (another user) can't write.
A process running as the build user can still change anything; that is the trust boundary in `supply-chain.md` (SC-1).

## Regression test
Scratch scripts (not in-tree; no zun build was run):
- `fetch-cli.ts dep picohttpparser …` with scratch `dest`/`cache`: fresh fetch; warm cache after removing `.ref`;
  a corrupted cached tarball ("failed verification; removing it and fetching again", cache re-populated with the
  pinned bytes); then "up to date". No `.zun-tmp-*` dirs left.
- `fetchPrebuilt` against a local HTTP server with a temporary pin: good tarball extracts and stamps; second run is
  "up to date"; a tarball whose single top-level entry is a symlink to `/etc` is rejected ("not a directory").
- `downloadWithRetry` with a wrong pin: `sha256 mismatch`, one request (no retry), destination dir left empty.

## Sibling search
`grep -n "createWriteStream\|\.partial\|extractTarGz\|extractZip" scripts/`: `scripts/prefetch-deps.ts` (legacy, SC-3)
extracts `by-url` hits without verification; listed in `supply-chain.md`, not changed. `record-pins.ts` (SC-5) already
uses mkdtemp + `wx`. Still open: publishing an extracted tree into a shared `vendor/` or cache dir is not serialized
across checkouts, and the published tree is trusted by its stamps afterwards (SC-1).

## Lessons
A checksum only protects the bytes you go on to use if you use the same file object, in storage no one else can write.
