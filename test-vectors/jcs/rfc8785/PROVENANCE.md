# Vendored RFC 8785 reference test data

These files are **not ours**. They are the reference test data published
alongside JCS (RFC 8785), vendored here so the guard that uses them runs
offline. A guard whose evidence must be downloaded at test time is a guard
that goes green when the network is down.

| | |
|---|---|
| Source | https://github.com/cyberphone/json-canonicalization |
| Path in source | `testdata/` |
| Licence | Apache-2.0, Copyright 2006-2021 WebPKI.org |
| Retrieved | 2026-08-21 |

## What is here

`input/` and `outhex/` — six input/expected pairs, complete. The expected form
is given in `outhex/` as hexadecimal bytes rather than as text, so the
comparison is over bytes and not over some editor's idea of an encoding.

Between them they exercise the two classes our own vectors do not:

| File | Class it exercises |
|---|---|
| `values` | number formatting (RFC 8785 §3.2.2.3): `333333333.33333329`, `1E30`, `4.50`, `2e-3`, `1e-27` |
| `french` | non-ASCII keys, and that sorting MUST ignore locale (`péché` / `pêche`) |
| `weird` | UTF-16 code-unit order across a surrogate pair (`U+1F602`) and `U+FB33`; control-character escapes; `€` |
| `unicode` | unnormalised Unicode is not normalised (`A` + U+030A stays two code points) |
| `arrays`, `structures` | nesting, and that member order inside arrays is preserved |

`es6-numbers-sample.txt` — a **sample**, in the source's own
`hex-ieee,expected` line format. Read the next section before citing it.

## What is NOT here, and why that matters

The number file published by the reference has **100,000,000 lines**
(2.1 GB gzipped). This repository vendors **3,000** of them:

- **Lines 1–2168** are the reference's complete deliberate block: 168
  hand-picked edge values, then 2000 consecutive values stepping up from the
  smallest normal double (`0x0010000000000000`). Over that block the sample is
  exhaustive.
- **Lines 2169–3000** are the first 832 values of its SHA-256-chained
  pseudorandom stream.
- **The remaining 99,997,000 lines are not here.**

So: the deliberate edge cases are covered completely; the space of IEEE-754
doubles is **sampled**, not covered. It cannot be covered — there are 2^64 of
them. Any claim this repository makes on the strength of this file says
"sampled" out loud, because the alternative is a claim about a class made on
the evidence of a specimen, which is the exact failure this directory exists
to guard against.

## Regenerating

Do not edit these files to make a test pass. If our output stops matching
them, our canonicalisation changed, and that is the signal they exist to
raise. To refresh them, fetch from the source above; the number sample is the
first 3000 lines of the release asset `es6testfile100m.txt.gz`.
