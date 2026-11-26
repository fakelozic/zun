# Commit hash map (history rewrite, 2026-11-27)

Before the first push to GitHub, `docs/guides/ecosystem/discordjs.mdx` was removed from history with
`git filter-branch --index-filter`. It was Bun's docs page with an already-invalidated example Discord
token, imported by cruller in `a1c009d` and deleted the same day in `52706b8`; GitHub push protection
rejected the push because of it. No file contents changed otherwise (trees are identical), but every
commit from `a1c009d` onward got a new hash. Docs written before this date quote the old hashes;
look them up here. The old history is kept locally under the tags `backup/pre-rewrite/*`.

| old | new | subject |
|---|---|---|
| a1c009d | 06b096e | bzrt: strip Bun 1.3.14 to thin zig 0.16 runtime (WIP) |
| 4bb20d1 | 0946a42 | docs: rewrite README for Cruller, add logo |
| d0f9578 | 0a77d38 | chore: drop upstream Bun dev-tooling cruft |
| 52706b8 | 3b1b0be | chore: drop docs site, benchmarks and remaining dev-tooling cruft |
| 1ee17cc | 68d076e | docs: note Cruller's fork origin in LICENSE.md |
| a14d401 | 877a083 | 20 fixes |
| a69a698 | d06e595 | progress |
| 477c824 | 1a60c08 | progress |
| eb57e66 | e6eac83 | simple fixes |
| 3d5c916 | 533b8b0 | 0 errors |
| 91fe679 | db90cdd | build fixes |
| 2e573f8 | dbdd607 | fir build |
| 7e7c528 | b420997 | small fixes |
| 05f7094 | d404577 | fixes |
| a2ab295 | 9236a28 | recovery parser |
| 47329c3 | 4a01de2 | small fixes |
| 3ab97f3 | 4aebb4b | small fixes |
| 52421da | 9358ce8 | build ok |
| d7082c7 | b5b2c31 | bench |
| aa5458f | 0d8dc71 | Run the existing codegen target before build016 semantic checks so a clean checkout no lon |
| 3b5fc14 | 15e1401 | container |
| e087ac2 | 559e04d | future |
| 6f15374 | 7425e31 | musl container |
| ca34fd4 | d0be4b1 | ffi fix |
| fa1b058 | 3536724 | tests |
| 6df3634 | d1d6585 | fast |
| a2ac49d | 56a5ac4 | roadmap |
| 6bd0bbb | 90f491d | tests |
| 1a78c80 | 2c3f318 | proxy interface + quckjs integration (mvp) |
| 7cb0bc9 | 7404a80 | quckjs integrated |
| e0c13d4 | 4eaa984 | v8 integration |
| be3badc | 0dac868 | ssr bench: /calc compute endpoint + timing + 3-engine comparison |
| 901b004 | 194178a | bench: honest JSC numbers via bare system jsc, V8 warmup diagnosis |
| 14b1a2d | 8e1cfd3 | perfomance tests + clean code |
| c5687b0 | a296330 | split strategy |
| 1874356 | 854f481 | zig 17 |
| f7002b1 | 731ed0a | zig 17 |
| 4625a1c | ec611c7 | Merge cruller (fakelozic/cruller master f7002b1) with history |
| ee9f2f3 | dbf73cb | build: revert cruller's partial Zig 0.17 edits to build on 0.16 |
| b5f2327 | 314b43f | docs: Linux-only until parity; measure parity by Bun's test suite on locked releases |
| c8405e7 | 28c5607 | docs: native deps plan (T9): Zig std coverage vs canary's Rust rewrites |
| 3872ad3 | 0f095ff | Merge T9: native deps → Zig plan (docs/plan/native-deps.md) |
| 3d7009d | 86a1b2c | docs(AGENTS): parity = Bun test suite on locked releases; Linux only for now |
| 0a74148 | 1e0234a | Merge T6: runtime behaviour diff 1.3.14 → canary (docs/plan/runtime-diff.md) |
| 89bc7f4 | fe993bd | Merge T7: AoT deep-dive and Zig plan (docs/plan/aot.md) |
| d010332 | ce95bb4 | docs: fold T6/T7 findings into GAP §5 and the roadmap (AoT engine, bindgen, WebKit upgrade |
| daa8d9d | ad2edea | docs: tooling plan (T8): check via embedded typescript-go, lint/fmt in Go, React Compiler  |
| b17cb22 | a3686e1 | Merge T8: tooling plan for check/lint/fmt/React Compiler (docs/plan/tooling.md) |
| 6f4f1b0 | 38174d7 | docs: fold T8 tooling findings into GAP and roadmap (Go check/lint/fmt, open questions) |
| dc26ef7 | b497d4a | docs(roadmap): order open questions |
| efc4fbd | 038c442 | Merge T5: restore plan for 1.3.14 modules (docs/plan/restore-1.3.14.md) |
| 6206bff | ce8844f | docs: fold T5 findings (1.3.14 is 0.15-era Zig; launcher depends on src/rt; restore-order  |
| f9de046 | 2791bd6 | docs: Phase 1 baseline build steps and status (Zig 0.16 debug build green) |
| bdc2a6e | b1d5737 | docs(zig): lessons from the 0.16 baseline (0xaa undefined fill, 0.16 vs 0.17 build APIs) |
| 61cb0ed | 74db8e5 | docs(roadmap): mark Phase 0 and Phase 1 done |
| 840097e | 05f609e | fix(transpiler): give the parser a real macro context (static import crash) |
| e48890e | 1297e43 | chore(rt): drop the QuickJS/V8 engines, ssr-run and their build steps |
| 8cb68ca | 9244b84 | build: port build scripts to Zig 0.17 |
| 27fb256 | d98aad7 | tools: scripts/fix_zig017.ts codemod + 0.17 compat helpers |
| 1b3da1a | adf18f2 | zig 0.17: run scripts/fix_zig017.ts over src |
| d8d8a2e | 372ca9c | fix_zig017: leave `x ** if (...)` operands for a human |
| 698172a | 3992045 | fix_zig017: dupeZ, bufPrintZ, std.meta.Int, unquoted .pointer attrs |
| 84057ad | 8fee6b5 | zig 0.17: rerun scripts/fix_zig017.ts (dupeZ, bufPrintZ, meta.Int, pointer attrs) |
| 21769d7 | 1cc792d | fix_zig017: pointer .alignment, std.meta.declarations; rerun |
| 3d67a54 | a77a2cd | zig 0.17: hand-fix reflection the codemod cannot see |
| 3c3ca8d | cce96f5 | zig 0.17: replace extern-struct @bitCast with bun.memCast |
| 8c95012 | ea95de7 | zig 0.17: ArrayList literals need .pointer_stability |
| 617709c | 2fa640d | zig 0.17: std API moves (EnumSet .empty/.full, newfstatat, wait4, BufferFirstAllocator) |
| e1678ac | 54712bd | zig 0.17: @hasDecl audit script; more migration probes |
| 4444d08 | fefb18a | docs: Zig 0.17 port status, audit, codemod usage, build notes, lessons |
| f41ba10 | 266f6cd | docs(roadmap): Phase 2 verified by integration owner |
| 6fa4cf9 | 51b8db1 | docs(roadmap): decide config file, no Zun alias, Phase 4 restore order |
| 5cb85d3 | 6bc1de3 | docs(roadmap): tidy Phase 4 intro |
| 71ad287 | e7e7187 | security: add security track, production gates and agent security rules |
| fefc241 | e820569 | zun: identity module and ZUN_-first env vars |
| 7fb59ce | 61a0caa | zun: --version, --revision and process.versions.zun |
| d3ca754 | 96b0f59 | zun: transpiler cache under ~/.zun, zunfig.toml lookup at launch |
| d10728d | 99bebca | security: send nothing to Oven's servers by default |
| 1aaae21 | 6fdeba4 | build: produce zun / zun-debug, build cache under ~/.zun |
| 712b8cf | 42e2b3a | test, docs: zun identity test, docs/identity.md, Zig probes |
| ce9e006 | d4119b6 | docs: keep real bun's transpiler cache out of ~/.bun; clarify crash-upload rule; mark Phas |
| 02debd0 | 3b6495a | restore: stub/cut-point ledger, restore-module script, compile-time gate design |
| 955ada5 | c86042f | restore(md): copy src/md + MarkdownObject.zig from bun-v1.3.14, run fix_zig017 |
| a93ec00 | 086fbba | security: dependency audit, backport list and supply-chain review |
| b2ed65a | 417a60b | Merge SEC1: dependency audit, backport list and supply-chain review (docs/security/) |
| 2f928bb | 2c8fae4 | security: add SEC1 production gates (backports, WebKit pin, supply chain) |
| 02ba63a | 50d6d03 | zig017 codemod: private-field and arraylist-empty rules |
| b1c241f | 76542b6 | restore(md): wire Bun.markdown and the .md loader back in |
| 28fd094 | de45ec2 | security: md: check u32 offsets on huge input; log md known issues |
| c98d508 | 8aa6fa6 | test, docs: Bun.markdown smoke test; restore ledger and roadmap for md |
| efda868 | b33a9f6 | security: record RT-2 (CJS entry errors swallowed) and the test-gate caveat |
| 8fb8f7e | 0af3782 | docs(AGENTS): rule 7 root cause, not quick fix; add RCA template |
| 602271f | c35cbe6 | security: fix RT-2 (CJS entry errors swallowed) and RT-1 (ZeroFillBuffers type confusion) |
| b774e0f | ad01296 | test: parity harness and first parity numbers vs Bun 1.3.14 suite |
| 1579b4e | 69e91d6 | Merge parity harness: scripts/parity.ts + first dashboard (docs/status/parity.md) |
| a5fcd6e | a12845b | docs(status): triage queue from the first parity run (fetch streaming, resolver debug prin |
| acc46d5 | be24ae7 | security: C1: bump brotli to v1.2.1 (CVE-2026-111497), pin by commit |
| 2eb78ec | dab8734 | docs(rca): C1-a brotli decoder error enums were exhaustive |
| 739e27b | 152bc7d | security: H8: bump c-ares 1.34.6 -> 1.34.9, pin the tag's commit |
| c17a851 | 60b66ee | security: H1: strict chunked decoding in fetch (picohttpparser f4d94b48 + Bun's patch) |
| 413dec6 | 0a4a9a7 | security: C2: NSS 3.131.1 root store + blocked eMudhra SPKIs on every TLS verify path |
| eaca93d | 750e567 | security: supply chain: pin and verify the sha256 of every build download |
| c5727fe | fbc55b8 | docs(roadmap): security track progress (C1, C2, H1, H8, supply chain; FETCH-1 open) |
| 825ac11 | 74a96f3 | security: FETCH-1: take fetch off the rt host bridge (honour tls options, stream bodies) |
| c58df32 | b182f46 | test: parity: SANITIZER status, re-run after RT-2, new triage |
| 85ed6ce | e21344b | Merge parity re-run: 1931/2292 runnable pass with trustworthy CJS results; SANITIZER statu |
| 0a5b26b | d69564e | docs(triage): FETCH-1 fix clears 20 of 29 parity timeouts; list the 9 left |
| 7e0a45e | ca7e40a | security: RCA TQ-3 (Worker pthread_exit under ASAN) and TQ-10 (extra stdio pipe fd double- |
| 1854254 | d668728 | security: independently review bootstrap backports |
| 459cc50 | dcd21df | security: confirm review finding F-1 (tls ca is additive) as TLS-CA-1; triage note on the  |
| 98f9d8c | b38c0b9 | security: verify review findings F-3/F-4/F-5 at runtime; log TLS-ID-1 and H2C-1 |
| f4a91b1 | 6a9a710 | docs(zig): byteSwapAllFields whole-int swap dates from 0.16 (not 0.17); both HTTP/2 stacks |
| 90c8d58 | 365c14c | security: verify review findings C2-1, C2-2, C2-3 (no source changes) |
| 1b96388 | f9ca822 | security: docs: fold C2 verification into H3/H6, root-certs limits, log TLS-RESUME-1 |
| 761a3f5 | 4117b9e | docs(roadmap): decide security behaviour matches upstream (C2-1, FETCH-2/3); prep-branch r |
| c3dd1a8 | 75cfec8 | docs: matching upstream is for now; list deferred stricter checks in hardening-later.md |
| 5040635 | f25a554 | security: SC-4: remove the unverified Zig auto-download; make LLVM extraction conditional  |
| 98de103 | 3d63afa | security: SC-5: record pins with a separate command; builds never accept an unpinned downl |
| 50ad027 | d746e3b | security: SC-2: verify and extract the same bytes, in a private directory |
| 37bf75f | c89c28c | security: SC-1/SC-3: document the build-cache trust boundary and the cost of a content man |
| 073a88f | 33ffbd1 | Merge branch 'prep/supply-chain' into integ/night-1 |
| f66e3e9 | be346d1 | test: HARNESS-1: runner passes llvm-symbolizer to LeakSanitizer (suppressions were ignored |
| 8a9a9e1 | 2ef195e | security: TLS-CA-1: an explicit `ca` replaces the default roots (prepared, not yet built) |
| f8abfb9 | 9287fcc | Merge branch 'prep/tls-ca-1' into integ/night-1 |
| 041b6cd | 566f673 | security: TLS-CA-1 verified on a build: explicit ca replaces the default roots |
| bb1da67 | 674967d | security: verify review H1-1..H1-4; fix H1-3 RCA/tests, full per-field picohttpparser ABI  |
| 6981263 | c0cdc85 | Merge branch 'prep/h1-abi' into integ/night-1 |
| c765b39 | 3edb48c | security: H1 ABI checks built and green; FETCH-2/3 accepted for now (match Bun 1.4.5) |
| 26ecd0e | 5390ccb | security: bun-uws: backport Bun 1.4.5 HTTP/1.1 request-smuggling fixes (H5) |
| 5b59b29 | 011e3b6 | security: test: raw-socket Bun.serve request-smuggling regression test (H5) |
| 2665993 | b48d6a7 | security: docs: H5 RCA, backports status, fetch-client sibling issue |
| ffd9f0b | 796f922 | Merge prep/h5: Bun.serve HTTP/1.1 smuggling fixes (H5), built and verified; H5-1 split out |
| ed20c9d | 9ea86de | security: spawn: port Bun 1.4.5 "socket-fd" stdio mode to fix TQ-10 / SPAWN-1 |
| 5d31856 | 3aaa064 | Merge branch 'prep/tq-10' into integ/night-1 |
| b441872 | a691ffd | security: TQ-10 / SPAWN-1 verified on a build: no more double close of extra stdio fds |
| bbf5c8e | e54f783 | security: fix H2C-1: HTTP/2 frames were byte-reversed on the wire (fix prepared, not yet b |
| f7e4f5a | 1027e6e | Merge branch 'prep/h2c-1' into integ/night-1 |
| 13e7723 | b38a884 | security: H2C-1 verified on a build: HTTP/2 frames correct on the wire; http2 parity re-ru |
| 8f277b1 | 354bf3d | security: fix(worker): TQ-3: Worker threads return instead of pthread_exit; no Zig sigalts |
| ab7f20a | 9eef12d | Merge branch 'prep/tq-3' into integ/night-1 |
| 13ce045 | f730a4b | security: TQ-3 / RT-3 verified: all 47 ASAN-flagged Worker tests pass under ASAN |
| 970c76f | 610e98f | security: TLS-ID-1 fetch applies its TLS identity policy before sending (prepared, not yet |
| a695e71 | 85f481c | Merge branch 'prep/tls-id-1' into integ/night-1 |
| ff771e2 | cfe5dbc | security: TLS-ID-1 verified on a build: fetch checks identity before sending; pooled socke |
| 12e4809 | 64c1733 | security: prepare TQ-9 IPv6 address formatting fix |
| 38f45fa | e665a2d | Merge prep/tq-9: IPv6 address formatting matches Node (TQ-9), built and verified |
| f4a1b39 | 7744428 | docs(rca): TQ-9 status: fixed and verified |
| 148bb6f | adb69a2 | security: C2-2: HTTP/3 server enforces client-certificate verification (prepared, not buil |
| 036a6d0 | 14891b4 | WIP security: H6(a) Bun.connect verify (agent paused for owner restart; unbuilt, unreviewe |
| b039ad6 | 7b70420 | fix(resolver): TQ-2: gate the debug "Resolving" print with the breakpoint |
| 32d5bac | d5c99ef | restore(cli): copy CLI core from bun-v1.3.14 + mechanical 0.17 codemod (unwired) |
| bfddd44 | ba71462 | security: restore(cli): R2 checkpoint (a): wire the Bun 1.3.14 CLI (args, bunfig, run) |
| 86279be | 67513bf | restore(cli): R2 checkpoint (a) complete: TQ-4/TQ-8 RCA, CLI flags regression test, zun he |
| 8a078e7 | 046031e | security: close HTTP/1.1 after a corked async response (H5-1) |
| 3530039 | 8e5970b | Merge branch 'prep/h5-1' into integ/night-2 |
| bdc822f | 2efc897 | security: H5-1 verified: Bun.serve closes after an async response to Connection: close |
| c843644 | 785405f | docs(status): handoff before owner restart; partial parity re-run (194/201 now pass) |
| ec10c14 | fa0dd29 | docs(zig): build-exe exits 1 on a compile error but can leave a broken output file |
