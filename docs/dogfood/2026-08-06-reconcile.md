# Reconciliation dogfood — 6 August 2026

Three runs of `conarium-reconcile` against our own production ERP, on the day the
tool shipped. Nothing here is simulated: the counters are real, the receipts are the
ones the live gateway wrote, and the bypass was a real query that really went around
the gateway.

We publish this because the claim "we reconcile the database's counters against our
receipts" is worthless without an output someone can read. The same reason
[`2026-07-31-anchor.anchors.jsonl`](2026-07-31-anchor.anchors.jsonl) exists.

## Setup

| | |
|---|---|
| Gateway | `conarium-mcp` (c2), connectors `conarium-docs` + `zion-rest` |
| Data source | PostgreSQL (Supabase) behind PostgREST, schema `zion` |
| DB role | `conarium_c2` — **dedicated to this gateway instance**, so its counters contain gateway traffic and nothing else |
| Counter source | `pg_stat_statements`, snapshotted with [`scripts/pg-snapshot.sql`](../../scripts/pg-snapshot.sql) |
| Receipts | `receipts-c2.jsonl`, 15 receipts, Ed25519-signed |

Chain integrity was checked first, because reconciliation assumes an already-verified
receipts file:

```
$ conarium-verify receipts-c2.jsonl --pubkey audit-c2.pub.pem
ok: 15 receipt(s) verified (15 with undeclared model)
EXIT=0
```

(`undeclared model` is correct and honest: MCP does not transmit model identity, so
the receipt records that it was not declared rather than inventing a value.)

## Snapshots

| Snapshot | Timestamp (UTC) | Patterns | Total calls |
|---|---|---|---|
| `before` | 2026-08-06T15:12:00.032Z | 7 | 91 |
| `mid` | 2026-08-06T15:41:29.823Z | 8 | 94 |
| `after` | 2026-08-06T19:15:25.452Z | 10 | 96 |

## Run 1 — control: a window containing only gateway traffic

One legitimate query was issued **through** the gateway between `before` and `mid`
(`select * from zion.v_branch_summary limit 5`), producing receipt `seq 15` at
15:12:19.544Z.

```
$ conarium-reconcile --before before.json --after mid.json --receipts receipts-c2.jsonl
reconcile window: 2026-08-06T15:12:00.032Z → 2026-08-06T15:41:29.823Z (role conarium_c2, source pg_stat_statements)
db: +3 call(s) across 3 pattern(s) · receipts in window: 3 · out of window: 12
note: matching is per pattern and per table, never per call count — one request may produce more than one statement
note: receipt signatures are NOT checked here — run conarium-verify first
infrastructure pattern(s) (session/catalog housekeeping, not data access): 2
  ~ (+1) select set_config('search_path', $1, true), set_config('role', $2, true), set_config('request.jwt.claims', $3,…
  ~ (+1) COMMIT
  = (+1) covered by receipt(s) for [v_branch_summary]: WITH pgrst_source AS ( SELECT "zion"."v_branch_summary".* FROM "zion"."v_branch_summary" LIMIT $1 OFFSET $2 ) …
ok: every DB query pattern in the window is covered by receipts
EXIT=0
```

Two things worth noting. PostgREST's session setup and `COMMIT` are listed as
infrastructure rather than quietly dropped. And the data query is matched by
*pattern and table*, not by call count — the receipt count and the call count do not
have to agree, because one REST request can fan out into several statements.

## Run 2 — a receipt that isn't there

Same real snapshots. The receipts file was truncated by one line, which is what the
file would look like if the receipt sink had failed on that write:

```
$ conarium-reconcile --before before.json --after mid.json --receipts receipts-14-of-15.jsonl
db: +3 call(s) across 3 pattern(s) · receipts in window: 2 · out of window: 12
UNRECONCILED: 1 pattern(s) recorded by the database have no covering receipt in the window:
  ! (+1) table(s) [zion.v_branch_summary]: WITH pgrst_source AS ( SELECT "zion"."v_branch_summary".* FROM "zion"."v_branch_summary" LIMIT $1 OFFSET $2 ) …
this means access was RECORDED by the database but NOT RECEIPTED by Conarium in this window — the gateway may have been bypassed, or the receipt sink failed. It does not by itself prove intent.
EXIT=40
```

## Run 3 — a real bypass

Between `mid` and `after`, a query was run **around** the gateway: connected with the
same database role (`set local role conarium_c2`) and read a customer view directly.
No policy, no masking, no receipt — exactly what an operator who wants to skip the
gateway would do.

```sql
set local role conarium_c2;
select count(*) as bypassed_rows from zion.v_top_customers;   -- 30 rows
```

The receipt count stayed at 15. The gateway wrote nothing, because nothing went
through it — which is the entire problem reconciliation exists to solve.

```
$ conarium-reconcile --before mid.json --after after.json --receipts receipts-c2.jsonl
reconcile window: 2026-08-06T15:41:29.823Z → 2026-08-06T19:15:25.452Z (role conarium_c2, source pg_stat_statements)
db: +2 call(s) across 2 pattern(s) · receipts in window: 0 · out of window: 15
note: matching is per pattern and per table, never per call count — one request may produce more than one statement
note: receipt signatures are NOT checked here — run conarium-verify first
infrastructure pattern(s) (session/catalog housekeeping, not data access): 1
  ~ (+1) set local role conarium_c2
UNRECONCILED: 1 pattern(s) recorded by the database have no covering receipt in the window:
  ! (+1) table(s) [zion.v_top_customers]: select count(*) as bypassed_rows from zion.v_top_customers
this means access was RECORDED by the database but NOT RECEIPTED by Conarium in this window — the gateway may have been bypassed, or the receipt sink failed. It does not by itself prove intent.
EXIT=40
```

The `set local role` statement itself is correctly classified as infrastructure; the
`SELECT` is the finding, and the view is named.

## What this establishes, and what it does not

It establishes that the reconciliation path works end to end against a real
PostgREST-fronted database with real receipts, that a gateway-only window reconciles
clean, and that access which went around the gateway is surfaced and named rather
than staying invisible.

It does **not** establish that reconciliation is proof of misconduct. The tool's own
output says so: an unreconciled pattern means access was *not receipted*, which has
more than one explanation. Nor does it remove the trust assumption — reconciliation
believes the database's own counters. What it changes is the cost: an operator who
wants their audit to look complete must now keep two independent systems consistent
instead of editing one file.

The limits are stated in [`docs/RECEIPT-SPEC.md`](../RECEIPT-SPEC.md) §Reconciliation:
dedicated role per instance, pattern/table matching rather than call counts,
unreliable windows refused rather than guessed at, and a bypass performed with
*different* credentials lands in a different role's counters — the operator has to
snapshot those too.

## One bug worth publishing

The first version of the tool reported **every legitimate query as a bypass**.
PostgREST wraps each query as `WITH pgrst_source AS ( … ) SELECT … FROM pgrst_source`,
and the table extractor was reading the CTE name as the relation, so it never saw the
real table and never matched a receipt. The unit tests were green. Running it against
live traffic is what found it — the fifth time in this repo that a green suite was not
evidence of correctness. CTE names are now excluded, and the case is locked by a test.
