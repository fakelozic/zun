# SC-5: pin recording let a build compile the artifact it had just recorded

- **Status:** fixed (this commit) for pin recording; legacy provisioning paths listed as unsupported for production
- **Severity:** medium, security-relevant (supply chain)
- **Found by / date:** security review `docs/security/review-2026-11-26-sol.md` (SC-5), confirmed 2026-11-26

## Symptom
With `ZUN_PIN_RECORD=1` in the environment, a build that met an unpinned URL downloaded it, appended its sha256 to
`scripts/build/deps/sha256sums.txt` and **continued building with it**. A CI job or shell that carried the variable
(or a version bump that changed a URL) compiled an artifact nobody had reviewed, and the "pin" only recorded what was
used. Reproduction before the fix: unpin one dep line, `ZUN_PIN_RECORD=1 bun scripts/build.ts … --target=clone-<dep>`
succeeds and rewrites the pins file.

## Root cause
`requirePin()` returned `undefined` instead of throwing when `recordPins` was set, and `verifyPinnedFile()` appended
the observed digest and returned it as if verified (`scripts/build/download.ts:71-107` at `eaca93d`). Recording and
enforcement shared one code path, so "record" meant "accept". Introduced in `eaca93d` (the supply-chain change) as a
convenience for creating the initial 19 pins.

## Why it wasn't caught
The checks in `supply-chain.md` covered wrong pin, missing pin and correct pin with the variable unset. Nothing
tested the build with the variable set, and nothing prevented it being set in CI.

## Fix
Recording is moved out of the build into `scripts/build/record-pins.ts`, which downloads each URL into a fresh `0700`
temp dir (file created with `O_EXCL`), prints `<sha256>  <url>`, optionally appends it (`--append`), never replaces an
existing pin, and builds nothing. In `download.ts` the `ZUN_PIN_RECORD` mode is deleted: `requirePin()` always throws
on a missing pin (before any network access) and `verifyPinnedFile()` calls it first. There is no environment setting
left that makes a build accept an unpinned artifact.

## Regression test
Scratch script (not in-tree): with `ZUN_PIN_RECORD=1` set, `downloadWithRetry()` of an unpinned URL on a local HTTP
server throws `No sha256 is pinned` and the server sees **0 requests**; `verifyPinnedFile()` on an unpinned URL throws.
`record-pins.ts` was run against an unpinned https URL (prints the line, repo unchanged), an already-pinned URL
("already pinned, matches"), an `http://` URL (refused, exit 1), and `--append --keep` (one line appended, file kept
0600 in a 0700 dir; the append was reverted).

## Sibling search
`grep -rn ZUN_PIN_RECORD`: only download.ts, sha256sums.txt's header and supply-chain.md (all updated). Other
download paths that bypass the manifest entirely (`musl.Containerfile`, `scripts/bootstrap.sh`,
`scripts/prefetch-deps.ts`) are listed in `supply-chain.md` as legacy, unpinned and unsupported for production;
`bootstrap.sh` was deliberately not rewritten.

## Lessons
Keep "decide what to trust" and "use what is trusted" in separate commands; an enforcement path must not have a mode
that turns enforcement into recording.
