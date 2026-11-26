# Lessons log

Things we learned the hard way while working on zun. Add newest first, with a date.
Keep each entry short: what happened, why, what to do instead.

## 2026-11-26: `Writer.Allocating.init` starts with no buffer

`std.compress.flate.Compress.init` asserts its output writer has a buffer of more than
8 bytes, so passing `&aw.writer` from `Writer.Allocating.init(gpa)` aborted the test
with "reached unreachable code". **Do:** use `try .initCapacity(gpa, n)` when a consumer
writes into the writer's buffer directly. Also: `"str" ** n` no longer parses at all in
0.17 (the `**` operator is gone, the error talks about whitespace around `*`).

## 2026-11-26: memory of Zig is out of date; probe first

Assuming `@typeInfo(T).@"struct".fields` still worked (it's been the API for years)
failed on 0.17.1: struct info is now struct-of-arrays (`field_names`, `field_types`,
`field_attrs`). **Do:** before using any reflection or std API you haven't checked
on 0.17, write a 5-line test in `probes/` or grep `lib/std`.

## 2026-11-26: `std.builtin` is `std.lang`

The definitions of `Type`, `CallingConvention`, `Optimize`, etc. live in
`lib/std/lang.zig`. `std.builtin` is a deprecated alias. Look in `lang.zig` when
you need the real shape of a reflection type.

## 2026-11-26: an independent fact-check caught 3 wrong claims

A reviewer agent found that the cheatsheet said `bit_set.Dynamic` uses `.empty` (it
still needs `initEmpty(gpa, n)`) and that `std.meta.fields` was "deprecated" (it is
already a `@compileError`). Both were written from release-note summaries, not probes.
**Do:** every cheatsheet line needs a probe. Grep hits in comments or vendored code
(`src/unicode/uucode_lib`) inflate migration counts, so check where hits land before estimating.
