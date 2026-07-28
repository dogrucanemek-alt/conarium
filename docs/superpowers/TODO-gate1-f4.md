# Receipt v0.1 — GATE 1 deferred work

## F4 — TODO (not fixing in this round)

**Status:** open · **Source:** Claude GATE 1 (2026-07-29) · **Patron:** defer to TODO

> Cursor prompt listed F1–F3 for immediate fix and F4 for TODO only, without
> pasting the F4 body. Confirm exact wording against Claude’s gate note; until
> then the residual risk we are tracking is:

**Tracked residual (post-F1):** `validateChain` skips Ed25519 verification for
foreign `keyId`s (rotation) and for entries with no `sig` (legacy). That unblocks
boot, but does **not** yet verify historical signatures against a multi-key trust
store. A follow-up should:

1. Accept a set of trusted verify keys (env / config), keyed by `keyId`
2. Verify each entry’s `sig` against the matching trusted pubkey
3. Fail-closed only when `sig` is present and `keyId` is **unknown** to the trust
   store (or crypto verify fails)
4. Keep “no `sig`” as legacy/out-of-scope unless a policy flag requires universal
   Ed25519 coverage

If Claude’s F4 was a different finding, replace this section with the gate text
and keep status `open`.
