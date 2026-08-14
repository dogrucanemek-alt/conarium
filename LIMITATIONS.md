# Limitations

What Conarium has not done. Measured. No dates.

## No certification

No SOC 2. No ISO. No independent penetration test. On the roadmap.

## Not 1.0

Version is 0.2.x. The API can break.

## SQL is Postgres only

Oracle, Microsoft SQL Server, and MySQL are not implemented.
A design note exists: [`docs/specs/2026-08-14-oracle-mssql-dialect-design.md`](docs/specs/2026-08-14-oracle-mssql-dialect-design.md).
There is no code.
This is a second parser layer, not a connector. Today's security gate sits on `pgsql-ast-parser`. A new dialect rebuilds that layer.

## Names in free text are not guaranteed

Structured columns: deterministic (`maskColumns`).
Free text: best effort (carry-over of values this policy already masks; labelled names).
A bare name in running prose is not detected.

## One production install

The only production deployment is the author's own company.
There is no external reference customer.
The figure 121,366 identities masked comes from that company's ERP. It cannot be verified from outside.

## One-person team

Bus factor 1.

## Anchors may stay pending

An OpenTimestamps stamp can take hours to confirm on Bitcoin. Receipts already show `pending`.

## Cryptography is not independently audited

The Ed25519 implementation has not had a formal audit.

## Masking cost grows with distinct masked values

Carry-over builds one matcher per unique value this policy already
masked. `maxRows` bounds that set. When the policy leaves it unset the code falls
back to 100; the `conarium.config.json` shipped with the package sets 50, so a
fresh install runs at 50. The figures below use 100 as the conservative case.

Measured (same SELECT, same row count, Postgres 16.14, WSL2, see
[`docs/BENCHMARK.md`](docs/BENCHMARK.md)):

| maxRows | overhead p50 (masked) |
|---|---|
| 100 (default) | 5.0 ms |
| 500 | 87 ms |
| 5 000 | 22 s |

Raising the cap is allowed. The doctor and boot log warn above 100.
The query is not rejected.

## OpenTimestamps client

Stamping uses a built-in calendar client (Node `crypto` + HTTPS to the public calendars).
`javascript-opentimestamps` is not a dependency. The `web3` / `elliptic` / `crypto-js` / `request` / `lodash` tree is not installed.
Bitcoin confirmation still takes hours; receipts still show `pending` until upgrade.
Bitcoin-block verification talks to `blockstream.info`. If that host is unreachable the verifier reports "could not check", not "valid".
