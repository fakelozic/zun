# Security

Zun is intended for **production** use, so security is a continuous track (see `docs/ROADMAP.md`,
"Security track") with explicit **production gates**.

## Rules for everyone (humans and agents)

See `AGENTS.md` rule 6. In short: never weaken security to make something pass; treat all input as
hostile; pin and checksum every download; send nothing to third parties; mark security-relevant commits
`security:` and record known issues here.

## Files

| File | What |
|------|------|
| `README.md` | this policy |
| `audit-deps.md` | pinned native dependencies vs. vulnerabilities fixed upstream since (from the audit task) |
| `backports.md` | prioritised list of fixes to apply, and their status |
| `supply-chain.md` | every build download: source, pin, checksum, verified? |
| `known-issues.md` | open security issues found in shipped code (per module), and how they were fixed |

## Threat model (first draft)

Zun runs **the owner's own server code** (not untrusted JavaScript). The main attack surface is therefore
the **network**: HTTP/1.1, HTTP/2, HTTP/3, WebSocket, TLS, URL/header parsing, `fetch` responses, DNS
answers, compressed bodies, and files or archives the app processes. Engine (JSC) bugs matter mostly
when untrusted input can drive JIT/GC edge cases, which is still possible via crafted JSON or regexes,
so engine CVEs are rated by that path.
