# Vercel log-drain fixtures — provenance

Captured 2026-08-23 from the vendor's own published reference, verbatim. Not
hand-typed, not paraphrased (D254's bar), and not yet wire captures: a real
delivery requires a configured drain pointing at a public endpoint, which is
what S5 provides. **D285 registers the upgrade: these fixtures are re-validated
against the first real delivery before any SOON card flips, and a divergence is
fixed before activation.**

| file | source | retrieved |
|---|---|---|
| `logs.json` | https://vercel.com/docs/drains/reference/logs — "JSON" format example | 2026-08-23 (page `last_updated: 2026-07-01`) |
| `logs.ndjson` | https://vercel.com/docs/drains/reference/logs — "NDJSON" format example | 2026-08-23 (page `last_updated: 2026-07-01`) |

Both examples are the same two entries: a `build`-source line with no trace
context, and a `lambda`-source line carrying `traceId`/`spanId` and their dotted
duplicates — which is exactly the pair the correlation posture needs to be
tested against (D254: extract from the measured fields, infer nothing).

The signature check the receiver implements when `OBSTACK_VERCEL_DRAIN_SECRET`
is set (HMAC-SHA1 hex over the raw body) is the vendor's documented algorithm
from https://vercel.com/docs/drains/security, retrieved the same day (page
`last_updated: 2026-07-29`).
