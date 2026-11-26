# PARITY-1: the parity harness classified runs on a 6 KB output excerpt, so mid-log crash reports were missed

- **Status:** fixed in the commit that adds this file (`test: parity: SANITIZER status …`)
- **Severity:** medium, gate integrity (security-relevant: a sanitizer report could go unnoticed in a gate)
- **Found by / date:** test sub-agent while adding the SANITIZER policy (triage TQ-6), 2026-11-26

## Symptom

A test that exits 0 and prints more than 6,000 characters, with an ASAN/UBSan/LSan report somewhere other than the
first or last 3,000 characters, was classified as `PASS` with no `sanitizerNote`, and its output was dropped from
`results.json`. The same applied to the crash kind and failure signature of failing runs.

Reproduction (the logic as it was in `runOne`):

```sh
node -e "const pad='filler line\n'.repeat(400); const c=pad+'==1==ERROR: AddressSanitizer: x\n'+pad;
const ex=c.slice(0,3000)+'\n[...]\n'+c.slice(-3000);
console.log(/^==\d+==ERROR: AddressSanitizer/m.test(ex))"     # false: the excerpt has no report
```

## Root cause

`scripts/parity.ts`, `runOne` (from `b774e0f`, the commit that added the harness):

```ts
e.output = clean.length > 6000 ? clean.slice(0, 3000) + "\n[...]\n" + clean.slice(-3000) : clean;
classifyOutcome(e);          // reads e.output, i.e. the excerpt
```

The excerpt exists to keep `results.json` small. `classifyOutcome` was written to work from stored results
(`--reclassify`), so it read `e.output`, and the live run went through the same path after truncating. The full capture
(up to 1 MiB) was available in `runOne` but was never passed on. Sanitizer reports are long (stack traces, often
symbolized) and usually come before the process's later output, so they easily end up in the dropped middle.

## Why it wasn't caught

Under the old policy, a sanitizer report in an exit-0 run was only a note, so a missed report changed no status. No
control or test fed the harness a long output. The negative controls printed one short line.

## Fix

- `classifyOutcome(e, full)` takes the full capture from `runOne`; `--reclassify` still passes nothing and uses the
  stored excerpt (documented).
- `excerptOf()` keeps head and tail **plus** a window around the first report marker when that marker falls in the
  middle, so the stored excerpt (and therefore `--reclassify`) still contains the report.

This removes the cause (classification on a lossy copy), not just the one marker: crash kinds and signatures for
failing runs come from the full output too.

## Regression test

Control `sanitizer-report-exit0-fails` in `scripts/parity.ts` prints the ASAN header between 4.8 KB of filler on each
side (9.6 KB total, header outside the old excerpt) and exits 0. It must come out `SANITIZER`, otherwise the run reports
the control as wrong and marks CJS passes as UNRELIABLE. Verified: `SANITIZER` with the fix; the old excerpt check
above returns `false`.

## Sibling search

- `grep -n "e.output\|\.output" scripts/parity.ts`: `causeOf` also reads `e.output`, but only to pick a coarse label
  for an already failing run, so the excerpt is enough there. It still benefits from the report window.
- `scripts/runner.node.mjs` (Bun's runner) decides on the exit status only and does not scan output, so it has no such
  issue. It also has no sanitizer policy, which is why zun's gates use the parity harness's status.
- No other script in `scripts/` classifies test output.

## Lessons

Classify on the full data and store a lossy copy only for humans. Every gate that greps output needs a control whose
marker sits where truncation would drop it.
