# GACS — Governed Access Conformance Suite

An open, hostile test suite for governed data access. Anyone can run it
against their own product by writing an adapter. This repository ships a
reference adapter; the suite does not import that product.

A one-person team maintains both the suite and one implementation. That
is stated here so nobody has to discover it later.

If it cannot be implemented from the document, it is not a specification;
it is a blog post.

If a frozen case stops matching, do not edit the expectation so the
suite goes green. Either the implementation changes, or the
specification / version changes and that change is recorded in the
open. There is no script that bulk-rewrites expected results.

## What it tests

| Class | Profile | Typical claim |
|---|---|---|
| `evidence/` | GACS-D1 | Receipt chain, signature, tamper, mid-chain delete, seq gap |
| `gate/` `rowcap/` `masking/` | GACS-E1 | Table policy, row cap, column masking |
| `coverage/` | GACS-C1 | Length pins; tail drop without a pin |
| `inference/` | GACS-I1 | Count / existence / probe / cohort channels |

See [profiles.md](profiles.md). A procurement line can cite a profile
instead of inventing a score.

## What it does not test

- Timing side channels
- A session-wide probe budget
- Whether a live database role could bypass the gate
- That a receipt was *correct* when it was written
- That this suite's authors are a large vendor

Every case has a `doesNotTest` field. Empty is rejected.

## Two regimes

**conformance** — frozen vectors. `PASS` / `FAIL` means "matched the
recorded expectation."

**resistance** — hostile probes. The runner will not print `PASS`.
Statuses: `ENFORCED`, `BOUNDED(<limit>)`, `NOT_COVERED`,
`DECLARED_ONLY`, `DETECTED_WITH_EXTERNAL_PIN`, `NOT_CLAIMED`.

An unclaimed capability is `NOT_CLAIMED` and is not a failure. A listed
gap (`expectedFail`) that starts returning `ENFORCED` *is* a failure —
[KNOWN-GAPS.md](KNOWN-GAPS.md) must be edited in the same change.

No percentage, letter grade, or ranking is produced.

## How to write an adapter

See [adapters/README.md](adapters/README.md). Thirty lines is enough.

```
node conformance/run.mjs --adapter <your-adapter> --claims <your-claims.json>
```

Claims file: implementation name, version, the claims you actually
make, and optionally a `verify` command for receipt files.

## How to run the reference adapter

```
npm run build
node conformance/run.mjs --adapter conformance/adapters/conarium.mjs --claims conformance/claims/conarium.json
```

Exit 0 means every *claimed* case held and every listed gap is still a
gap. Exit 1 means a claimed miss or a gap that closed without the list
being updated.

## Falsify it

If you think a case is wrong, open an issue. The value of the suite is
that it can be shown to be wrong.

## Relation to the SCITT draft

This suite also exercises mechanisms described in
[draft-dogru-scitt-disclosure-evidence](https://datatracker.ietf.org/doc/draft-dogru-scitt-disclosure-evidence/).
GACS stands on its own if that draft moves or dies.
