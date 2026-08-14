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

## OpenTimestamps client

Stamping uses a built-in calendar client (Node `crypto` + HTTPS to the public calendars).
`javascript-opentimestamps` is not a dependency. The `web3` / `elliptic` / `crypto-js` / `request` / `lodash` tree is not installed.
Bitcoin confirmation still takes hours; receipts still show `pending` until upgrade.
Bitcoin-block verification talks to `blockstream.info`. If that host is unreachable the verifier reports "could not check", not "valid".
