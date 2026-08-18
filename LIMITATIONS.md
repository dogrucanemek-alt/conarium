# Limitations

What Conarium has not done. Measured. No dates.

## No certification

No SOC 2. No ISO/IEC 27001. Neither is planned: at this stage the budget goes to
independent penetration testing and implementation-level assurance rather than
organisational certification. No independent penetration test yet — that one is
on the roadmap.

## Not 1.0

Version is 0.2.x. The API can break.

## Node 20 is the floor, and Node 20 is past end-of-life

`engines` requires Node >=20 and CI runs the full suite on 20, 22 and 24. It said
>=18 until 2026-08-17, and that was wrong rather than merely unverified: the MCP
SDK's HTTP transport uses the global `crypto`, which is available without a flag
only from Node 19, so on Node 18 the gateway fails at `initialize` with
`ReferenceError: crypto is not defined`.

Both Node 18 (2025-04-30) and Node 20 (2026-04-30) are past end-of-life in the
nodejs/Release schedule, so a Node 20 install is running a runtime that no longer
receives security patches. Node 20 is kept as the floor because it is verified to
work and removing it would break installations for a reason their operators did not
ask for. Node 22 or later is the version to run; if you are on 20, that choice is
yours to make with this stated rather than hidden.

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

A column listed in `policy.protectedColumns` is the narrower exception: the
same glob syntax as `maskColumns`, and the value is still masked in the result.
In addition, the column may not appear in `WHERE`, `HAVING`, `JOIN … ON`,
`ORDER BY`, `GROUP BY`, or a derived `SELECT` expression. The query is refused
before it reaches the database. Columns that are not on that list are unchanged
— the paragraph above still applies to them in full. This is not a claim that
masked values in general have become unlearnable.

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

## The countersigning service is one key on one server

Since 2026-08-15 a Conarium-operated endpoint exists (`demo.conarium.dev/anchor`,
keyId `verax-cs-20260815`). The signing key lives on one server, on disk, with
no HSM. An encrypted copy is escrowed off that server, so losing the machine
does not end the keyId — but escrow is recovery, not protection: if the key
leaks, every countersignature under that keyId is void, as the section above
says. The endpoint still ships in this package and you can operate it yourself;
a countersigner you operate proves ordering to you, not to a third party who
does not trust you.

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

## A disclosure hash is a verification oracle on low-entropy payloads

`disclosure.hash` is SHA-256 of the exact bytes that left the gateway after
masking and the row cap. Anyone who holds the receipt can try a guess
("was the answer `yes`?") and see if the hash matches. That is the nature
of a hash, not a hidden property. A nonce does not close it: the nonce
would be written on the same receipt. High-entropy results are not
practically guessable this way. A one-row yes/no result is.

## Destination is a declaration, not a verification

`destination` is what the operator wrote in config. Conarium does not
check that the result went there. MCP does not carry model identity, so
the field cannot be measured. Policy does not read it. A receipt that
says `openai/gpt-x` is not proof that OpenAI saw the bytes.

## Reconciliation establishes object attribution, not per-statement coverage

`conarium-reconcile` exits 0 when every query pattern the database counted
names a table for which a receipt exists in the same window. One receipt
naming a table clears any number of further statements against that table
inside that window. `test/reconcile_cli.test.mjs` is a deliberate positive
case: the counter delta is five calls on one pattern, one receipt names the
table, and the run exits 0. Counts are not compared 1:1 on purpose — one
client request can produce several source statements (PostgREST, a connection
pooler, an ORM), and a 1:1 rule would report false uncovered activity on any
such deployment. The consequence is that a clean run establishes pattern and
object overlap within the window. It does not establish that each recorded
statement was itself receipted.

## Reconciliation cannot tell a trailing clock from a late receipt

The window comes from the database's snapshot timestamps and a receipt's
timestamp comes from the gateway, so the boundary is decided by two clocks.
A receipt that would have covered a pattern but falls outside the window is
reported as `indeterminate` (exit 41) rather than as unreceipted access,
because this tool has no way to know which of the two happened. That is a
limit, not a verdict: 41 is a failure and the run does not pass, but nothing
is proven either way.

The exculpation is bounded by the window's own length — an offset larger than
the window cannot be a boundary artefact, and the report says so instead of
excusing it. `--skew` lets an operator declare what their clocks can do, and
that declaration outranks the inference. Neither mode establishes that the
receipt belongs to the access the counters recorded. This limit was found by
attack after the class shipped, not by reading it.

A receipt that names an object while the database counters show no increase
for that object is listed as UNOBSERVED. It is not a failure. The same
shape appears when a counter was reset at the window edge, when a pooler
collapses statements, or when the increment lands outside the snapshot
pair. The category is counted and printed so the gap is visible; it does
not change the exit code. `unassigned` is a different gap (the receipt
named no object at all).

## OpenTimestamps client

Stamping uses a built-in calendar client (Node `crypto` + HTTPS to the public calendars).
`javascript-opentimestamps` is not a dependency. The `web3` / `elliptic` / `crypto-js` / `request` / `lodash` tree is not installed.
Bitcoin confirmation still takes hours; receipts still show `pending` until upgrade.
Bitcoin-block verification talks to `blockstream.info`. If that host is unreachable the verifier reports "could not check", not "valid".
