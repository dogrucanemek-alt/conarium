# Limitations

What Conarium has not done. Measured. No dates.

## No certification

No SOC 2. No ISO. No independent penetration test. On the roadmap.

## Not 1.0

Version is 0.2.x. The API can break.

## SQL is Postgres, Microsoft SQL Server, and Oracle

MySQL is not implemented.
A dialect is listed here only when the shared SQL-gate vector set is green against that dialect, unparseable input is denied, and a live engine run applied the row cap.
This is a second parser layer, not a shipped database client. The shipped `query` tool selects the gate from `policy.dialect` (`postgres` when omitted, or `mssql`, or `oracle`). The dialect is the operator's declaration — it is not inferred from the SQL. An unknown dialect rejects the config; it does not fall back to postgres.
Oracle does not resolve synonyms: an allow-listed name is the name the parser sees, not the base table. Database links (`table@dblink`) are denied. `ROWNUM` is denied (it is not a row cap).
There is no MSSQL or Oracle connector. An operator can attach their own executor (`connectors[].type: custom-sql`) that receives only gated SQL. That path requires an explicit `policy.dialect` — the omitted-dialect postgres default does not apply. The gate speaks three dialects; the connection is the operator's.
Parsers: Postgres `pgsql-ast-parser` · MSSQL `node-sql-parser` (transactsql) · Oracle `@guanmingchiu/sqlparser-ts`.

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

## The operator is inside the boundary

The product defends the assistant-to-gateway path. Code that imports the
library can skip the gate the same way it can open the database with the
operator's credential. The operator's own process is not an audit subject
of this gateway.

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
