# Supply chain: every download the build performs

**Date:** 2026-11-26. **Rule** (`AGENTS.md` rule 6): every download must be **pinned** (commit or version) **and**
**checksum-verified**. This file lists what the build fetches today, and the gaps.

## Status after `security: supply chain` (2026-11-26)

**Enforced now** (`scripts/build/download.ts`, `fetch-cli.ts`, `source.ts`):
- `scripts/build/deps/sha256sums.txt` pins `<sha256>  <url>` for every download the build makes. `downloadWithRetry`
  refuses an unpinned URL **before** any network access and verifies the bytes before publishing them. A mismatch deletes
  the file and stops the build (no retry).
- Cached tarballs (`fetchDep`) are re-verified when used. Extracted trees (deps and prebuilts) carry a `.sha256` stamp
  and are reused only if it equals the pin. Both the pins file (implicit input) and the stamp (implicit output) are in
  the ninja graph, so changing a pin or deleting a stamp re-runs the fetch and re-verifies.
- Prefetch: only an explicit `BUN_BUILD_PREFETCH_DIR` is used (no `/opt/bun-prefetch` auto-detection), its by-url files are
  verified like downloads, and pre-extracted prefetch trees are never used (they can't be checked against a pin).
- The oven-sh/zig download path is unpinned, so it now fails closed. zun uses `BUN_ZIG_PATH` (vanilla Zig 0.17.1).
- Recording new pins is explicit and reviewable: `ZUN_PIN_RECORD=1` (trust on first use; cross-check, then review the diff).

**Provenance of the initial pins:**
| Pins | Source of trust |
|------|-----------------|
| 19 GitHub source archives | Fresh downloads recorded with `ZUN_PIN_RECORD=1`; each was **byte-identical** to the copy downloaded earlier the same day (archives are stable). Commits are immutable; the archive hash is TOFU |
| WebKit `bun-webkit-linux-amd64-debug-asan` | Downloaded and hashed; equals GitHub's release-asset digest (`b1384cf9…`) |
| Other Linux x64 WebKit variants (release, lto, asan, baseline) | GitHub release-asset digests of `autobuild-5488984d…` (not yet downloaded by zun) |
| Node headers v24.3.0 | Downloaded and hashed; equals nodejs.org `SHASUMS256.txt` (`045e9bf4…`) |
| LLVM 21.1.8 (manual step, `docs/build.md`) | GitHub release-asset digest `b3b7f280…`; `sha256sum -c` now in the documented step |

**Verified:** a wrong pin stops the build with `sha256 mismatch`; a missing pin stops it before downloading; a correct pin
is a no-op (`up to date`). Repeat by editing one line of `sha256sums.txt` and running
`bun scripts/build.ts --profile=debug --cache-dir=build/cache --target=clone-picohttpparser`.

**Still open:** SBOM per build (gap 8), release provenance (gap 9), mise toolchain verification (gap 7, row 10),
GPG/attestation verification beyond sha256 (LLVM `.jsonl` attestation, Node's signed SHASUMS).

## Download machinery (before this change, for reference)

- `scripts/build/download.ts` `downloadWithRetry()` (~`:137-200`) fetches with Node or Bun `fetch` (TLS verified by the
  runtime's defaults), streams to `<dest>.partial`, then renames. **It never hashes the content.** The only hashing is
  `sha256(url)`, used as a cache key (`download.ts:86`, `fetch-cli.ts:178`). That is a name, not an integrity check.
- `scripts/build/fetch-cli.ts` `fetchDep()` (`:135-215`) downloads `https://github.com/<repo>/archive/<commit>.tar.gz`,
  extracts it with system `tar`, and applies in-tree patches. Its `.ref` stamp is `sha256(commit + patch contents)`
  (`:217-240`), which detects a pin change, not tampering.
- **Prefetch cache:** if `BUN_BUILD_PREFETCH_DIR` is set, or `/opt/bun-prefetch` exists, files under `by-url/` and
  `extracted/` are **used without any verification** (`download.ts:66-71, 96-147`). Any process that can write that
  directory can swap in sources or a WebKit build.
- **Canary already fixed part of this:** `bun-canary/scripts/build/deps/webkit.sha256` pins the sha256 of every WebKit
  prebuilt, `fetch-cli.ts:85-116` refuses a prebuilt with no pinned sum ("No sha256 is pinned for …"), and
  `scripts/build/ci-images/spec.ts:106-161` pins the sha256 of the Node.js and toolchain downloads. Port this.

## Inventory

| # | What | Source URL | Pin | Integrity verified today? | Gap / fix |
|---|---|---|---|---|---|
| 1 | 19 source deps: boringssl, brotli, c-ares, zlib-ng, zstd, libdeflate, libarchive, mimalloc, tinycc, highway, lsquic, ls-qpack, ls-hpack, picohttpparser, libjpeg-turbo, libspng, libwebp, hdrhistogram, lol-html | `https://github.com/<repo>/archive/<commit>.tar.gz` (`fetch-cli.ts:176`) | commit SHA in `scripts/build/deps/*.ts` (brotli was pinned by the mutable tag `v1.1.0` until C1; now commit `db24a98a…`). | **No.** HTTPS to github.com only. | GitHub archive tarballs aren't guaranteed byte-stable, so a tarball hash can break spuriously. **Fix:** (a) pin brotli by commit; (b) record a sha256 of each archive in a `deps.sha256` file and fail on mismatch, re-pinning deliberately when GitHub regenerates archives, **or** fetch with `git fetch --depth 1 <repo> <commit>` (git checks the object hashes, so the commit SHA *is* the integrity check). (b′) is more robust. |
| 2 | Four deps are **oven-sh forks**: `oven-sh/boringssl`, `oven-sh/mimalloc`, `oven-sh/tinycc`, `oven-sh/libuv` (Windows-only) | as row 1 | commit | No | Trust extends to the oven-sh org. A commit SHA is immutable once fetched, but review the fork diffs against upstream when bumping (e.g. `git diff google/boringssl@<base>..oven-sh/boringssl@<pin>`). Long term, consider pinning upstream plus in-tree patches. |
| 3 | **WebKit / JSC prebuilt** (~200 MB; the debug-asan one is 1.9 GB) | `https://github.com/oven-sh/WebKit/releases/download/autobuild-<hash>/bun-webkit-linux-amd64[-debug][-asan].tar.gz` (`webkit.ts:76-78`) | WebKit commit in the tag name (`webkit.ts:6`) | **No** (`fetch-cli.ts:79-86` prebuilt path, no sha) | **Highest-impact gap**: the binary blob is the JS engine, and **GitHub release assets can be replaced** under the same tag. Fix: port canary's `webkit.sha256` + `pinnedSha256()` (`bun-canary/scripts/build/fetch-cli.ts:85-116`), and hard-fail when no sum is pinned. For production builds, consider building WebKit from source at the pinned commit in CI. |
| 4 | Node.js headers | `https://nodejs.org/dist/v24.3.0/node-v24.3.0-headers.tar.gz` (`nodejs-headers.ts:27`) | version `24.3.0` | **No** | Pin the sha256 from `SHASUMS256.txt` (which is GPG-signed by the Node release team) as canary does in `ci-images/spec.ts:113-120`. |
| 5 | Zig compiler (oven-sh patched) | oven-sh/zig release zip, `ZIG_COMMIT` (`scripts/build/zig.ts:36`) | commit | **No** | **zun doesn't use it**: zun uses vanilla Zig 0.17.1 via `BUN_ZIG_PATH` (`docs/build.md:39`). Make a missing `BUN_ZIG_PATH` a hard error, or delete the download path, so a misconfigured build can't silently fetch an unverified compiler. |
| 6 | **LLVM 21.1.8** (clang / lld / llvm-ar / llvm-symbolizer, 2 GB) | `https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.8/LLVM-21.1.8-Linux-X64.tar.xz` (manual step, `docs/build.md:12-16`) | version | **No**: `curl -L` then `tar` with no check | The compiler builds every C/C++ object, so a trojaned clang is a full compromise. Fix: add `sha256sum -c` with a pinned hash (LLVM publishes `.jsonl` attestations and `.sig` files on the release page; verify once with `gh attestation verify` or `gpg`, then pin the sha256). Better: a `scripts/fetch-toolchain.sh` that does this. |
| 7 | Perl `bignum-0.67` | `https://cpan.metacpan.org/authors/id/P/PJ/PJACKLAM/bignum-0.67.tar.gz` (`docs/build.md:17-20`) | version | **Yes**: sha256 `1c9a824a…f522875` checked with `sha256sum -c` | OK. Move it into the same fetch script as row 6. |
| 8 | Rust crates for lol-html (43 crates in `c-api/Cargo.lock`) | crates.io | `Cargo.lock` in the lol-html archive | **Yes, partly**: `cargo build --locked` (`scripts/build/source.ts:1343`) uses the lockfile and cargo checks each `.crate` against its `checksum =` | The lockfile itself arrives inside the unverified archive (row 1), so integrity is only as good as row 1. Add `cargo vendor` + `--offline` for release builds, and run `cargo audit` on the lockfile in CI. The `RUSTUP_TOOLCHAIN=nightly` / `-Zbuild-std` path for release (`docs/build.md:43`) pulls a nightly toolchain: pin its date. |
| 9 | npm packages for codegen (esbuild, peechy, …) | registry.npmjs.org | root `bun.lock` | **Yes**: `bun install --frozen-lockfile` (`scripts/build/codegen.ts:153-170`); `bun.lock` carries 152 `sha512-` integrity entries | (a) It runs with the owner's **bun 1.4.5** binary (`docs/build.md:42`), which has its own supply chain. (b) Lifecycle scripts: add `--ignore-scripts` unless one is needed (esbuild's postinstall only picks a platform binary, which `optionalDependencies` already handles; UNVERIFIED that it builds without it). (c) The registry is the npm default; keep `.npmrc` out of the repo or pin `registry=`. |
| 10 | Toolchains via mise: zig 0.17.1, bun 1.4.5, node 26, go 1.27, rust 1.100 | mise backends | versions in the owner's mise config | Depends on the mise backend (some verify checksums or minisign, some don't). UNVERIFIED. | Document the mise lockfile (`mise.lock`, if used) and pin checksums. For CI and release, use a container image with digest-pinned toolchains. |
| 11 | Root CA bundle | Mozilla NSS `certdata.txt`, fetched by hand (`packages/bun-usockets/src/crypto/root_certs.h:13-21`) | in-tree, out of date | Committed to git (reviewable) | Not a build-time download, but it is a supply input: update to **NSS 3.131.1** (`backports.md` C2), and record the NSS tag and the sha256 of `certdata.txt` in the generated header. |
| 12 | Cross-compile target binaries | `registry.npmjs.org` (`src/options_types/CompileTarget.zig:75,164-187`) | version | **No** | Runtime path, dormant today (no callers). Before restoring `bun build --compile --target`, add integrity checks (npm `dist.integrity`) or remove the path. |
| 13 | In-tree vendored C/C++: `sqlite3.c` 3.53.0, llhttp 9.3.0, uWS / uSockets, `patches/*` | git | git commit | Yes (git) | Record the upstream version and sha of each vendored file (SQLite publishes sha3-256 for every amalgamation) in this file when bumping. |

## Gaps, prioritised

1. **WebKit prebuilt has no checksum** (row 3). Port canary's `webkit.sha256` mechanism. *High.*
2. **LLVM toolchain tarball has no checksum** (row 6). Add pinned sha256 and verify the attestation once. *High.*
3. **The prefetch directory is trusted blindly** (`download.ts:66-147`). Disable it for zun (unset, and make the
   `/opt/bun-prefetch` well-known path opt-in), or verify entries against the same pinned sums. *High* on shared CI hosts, *Low* on a single-user dev box.
4. **Source archives aren't integrity-checked, and brotli uses a tag** (row 1). Pin brotli by commit now (it changes
   anyway for backport C1), and move to `git fetch <commit>` or pinned tarball sums. *Medium.*
5. **Node headers have no checksum** (row 4). *Medium* (headers only, but they are compiled in).
6. **The oven-sh/zig download path still exists** (row 5). Hard-fail without `BUN_ZIG_PATH`. *Medium.*
7. **npm lifecycle scripts / host bun binary** (row 9), and **mise toolchains** (row 10): document and pin. *Low–Medium.*
8. **SBOM:** generate one per build. List each dep, its commit, URL, sha256 and license (most of it is in
   `scripts/build/deps/*.ts`; `depVersionsHeader.ts` already has the data), plus crates from `Cargo.lock` and the
   WebKit sha. Store it next to the release artifact. This is ROADMAP Security track item 3.
9. **Release-build provenance:** build in CI from a clean, digest-pinned image, with `--frozen-lockfile`, `--locked` and no
   network after the fetch phase, and publish checksums for zun's own artifacts.
