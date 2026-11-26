# Hardening beyond upstream (later)

For now zun matches Bun 1.4.5 / Node where they agree (ROADMAP decisions, 2026-11-26). These stricter checks were
considered and deferred to a later hardening pass. Each needs its own RCA-style write-up, test, and a note on what
breaks.

| ID | Check | Upstream today | Source |
|---|---|---|---|
| HL-1 | A chain containing a blocked SPKI (C2) fails the handshake even with `rejectUnauthorized:false` | overridable `CERT_REVOKED` | review C2-1, `review-2026-11-26-verify-C2.md` |
| HL-2 | `fetch` requires CRLF in chunked trailers; closes instead of pooling on surplus bytes after the last chunk | Bun 1.4.5 accepts bare LF, drops surplus (Node rejects) | FETCH-3, review H1-2 |
| HL-3 | `fetch` caps chunk-extension bytes per line and trailer bytes per response | no cap in Bun 1.4.5 | FETCH-2, review H1-1 |
