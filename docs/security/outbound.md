# Outbound connections zun makes on its own

Rule (`AGENTS.md` rule 6): nothing is sent to third-party services, no telemetry, no crash upload.
Details and file pointers: `docs/identity.md`, "Outbound traffic".

| What | Bun 1.3.14 | zun (Phase 3, 2026-11-26) |
|------|-----------|---------------------------|
| Crash report upload (`curl` to bun.report) | default on macOS/Windows/canary, or `BUN_ENABLE_CRASH_REPORTING=1` | only to a URL the user sets in `ZUN_CRASH_REPORT_URL` / `BUN_CRASH_REPORT_URL` (Bun's crash-handler test uses a local server). Never by default |
| Printed crash trace | `https://bun.report/...` link | `zun-trace:/...` string, local only |
| `feedback` command | POST to `https://bun.report/v1/feedback` | refuses unless `ZUN_FEEDBACK_URL` / `BUN_FEEDBACK_URL` is set |
| Analytics / telemetry | in-memory feature counters (feed the crash trace) | same, nothing is sent |
| Upgrade check | `bun upgrade` (CLI) | CLI is cut. Must not contact Bun's servers when restored |
| `User-Agent` | `Bun/1.3.14` | unchanged (no zun-specific data) |

Open question for the owner: the opt-in crash upload to a user-named URL is kept so Bun's crash-handler test
still works. If production policy is "no upload at all, even opt-in", remove `report()`'s network path in
`src/crash_handler/crash_handler.zig` and mark that test as not applicable.
