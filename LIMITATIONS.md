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

## Bare 9-digit US SSN is not a content detector

`XXX-XX-XXXX` (hyphenated) is masked. A bare 9-digit run is not: it
collides with order IDs and other identifiers. This is a measured
limitation, not an oversight.

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

## Masking hides values; it does not make them unlearnable

Masking is applied to result rows. A query's WHERE clause is checked for table
permission, not rewritten: `WHERE email LIKE 'a%'` on an allowed table reaches
the database, and a row count of one versus zero answers a question about a
masked value without ever displaying it. An assistant with a valid token can
learn masked values bit by bit this way. If a column must be unlearnable rather
than merely hidden, do not allow the table that carries it.

## The row cap is per query, not per session

`maxRows` caps a single query. `OFFSET` is preserved, so an allowed, unmasked
table can be read in full, cap-sized pages at a time. That is what allowing a
table means; the cap exists to stop single-query bulk exfiltration and to keep
result sets small, not to ration total access.

## A countersignature is not a statement about the data

The countersigning service says that a signer other than you saw this chain head
at this time and put it at this position in a log that is appended to, never
rewritten. It says nothing about whether the records were correct, and it is not
a claim that the countersigner is honest — only that the log's own history
cannot be quietly rearranged afterwards. If the signing key leaks, every
signature it ever made is worth what the key is worth: nothing.

## Conarium does not run a countersigning service yet

The endpoint ships in this package and you can operate it. There is no public
Conarium-operated one, so the tier of the argument that depends on the signer
being someone other than you is, today, code rather than a service.

## The operator is inside the boundary

The product defends the assistant-to-gateway path. Code that imports the
library can skip the gate the same way it can open the database with the
operator's credential. The operator's own process is not an audit subject
of this gateway.

## Two processes, one audit file

`Audit.log()` is synchronous. One process can write many concurrent queries
without breaking `prevHash`. A second OS process that opens the same sink
is rejected (`<sink>.lock`, advisory `wx`). The lock does not stop a writer
outside Conarium that ignores the lock file.

## Strict signature mode is opt-in

`CONARIUM_AUDIT_REQUIRE_SIG=1` refuses boot if a signing key is set and
any audit line is unsigned. The default still accepts a fully unsigned
legacy chain when an HMAC key is later added (08-05 compatibility).

## Audit sink hash is not JCS

Receipts hash with RFC 8785 JCS (`canonicalize`). The audit JSONL hasher
(`src/audit-hash.ts`) uses `JSON.stringify` of insertion order. The two
disagree when keys are unsorted (`{"b":1,"a":2}` vs `{"a":2,"b":1}`).
Switching the sink to JCS would invalidate every existing audit file.
Independent re-hash of an old sink must use `JSON.stringify`, not JCS.

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
