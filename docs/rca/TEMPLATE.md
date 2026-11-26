# <ID>: <one-line title>

- **Status:** open / fixed in `<sha>`
- **Severity:** critical / high / medium / low (and whether it is security-relevant)
- **Found by / date:**

## Symptom
What was observed, with an exact reproduction (command, input, output, exit code).

## Root cause
The actual mechanism, down to file:line. Which commit introduced it (`git log -S`, `git bisect`, blame), and why that change was made.

## Why it wasn't caught
Which test or check should have caught it, and why it didn't (missing test, a test that can't fail, a debug-only symptom, …).

## Fix
What changed and **why it removes the cause** rather than the symptom. Link the commit(s).

## Regression test
The test that fails before the fix and passes after it (path).

## Sibling search
Other places with the same pattern or the same class of mistake: how you searched (grep, audit script), what you found,
and what was fixed or listed as open.

## Lessons
What we change in process, docs or the Zig knowledge bank so that this class of bug doesn't come back.
