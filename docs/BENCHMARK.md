# Benchmark — Conarium overhead

What is measured: **the cost Conarium adds**, not how fast a machine is.

Headline numbers are **p50 / p95 / p99**. Mean is not reported.

Replay:

```
npm run build
CONARIUM_BENCH_DSN=postgres://… npm run bench:overhead
```

Without `CONARIUM_BENCH_DSN` the Postgres comparison is **koşulamadı**.
The script still writes in-process gate timings. Those are not a
substitute for (a) vs (b).

Raw JSON: [`benchmarks/latest.json`](benchmarks/latest.json)
(this run: [`benchmarks/overhead-20260814T1238Z-win32.json`](benchmarks/overhead-20260814T1238Z-win32.json)).

No competitor numbers. One run is not a conclusion — see `n` on each
row.

---

## This machine

| | |
|---|---|
| CPU | Intel Core Ultra 9 275HX × 24 |
| RAM | 34 GB |
| OS | Windows 10.0.26200 (win32 x64) |
| Node | v24.5.0 |
| Postgres | **yok** — no `psql`, no Docker, no DSN |
| When | 2026-08-14T12:38:23.890Z |

Method: warmup 15 + 50 repeats for n ≤ 1 000; warmup 2 + 8 repeats
for n = 100 000. Query:

`SELECT id, name, email, note FROM public.bench_customers WHERE id <= N`

Deny uses `public.bench_secrets` (must not hit the database).

---

## (a) vs (b) — Postgres comparison

**koşulamadı.**

This machine has no local Postgres and no Docker. Inventing a delta
would be a lie. On a host with Postgres:

```
CONARIUM_BENCH_DSN=postgres://user:pass@127.0.0.1:5432/db npm run bench:overhead
```

The script creates `public.bench_customers` (100 000 rows) and
`public.bench_secrets`, then records paired samples:
direct SELECT vs `guardQuery` + that SELECT + `redact`.
Deny asserts the query counter did not move.

---

## In-process (not vs Postgres)

CPU of the gate only. No socket, no receipt, no MCP JSON-RPC.

### `guardQuery`

| Scenario | p50 | p95 | p99 | n |
|---|---|---|---|---|
| allow (unmasked) | 0.517 ms | 1.562 ms | 1.843 ms | 50 |
| partial (email masked) | 0.694 ms | 1.180 ms | 1.774 ms | 50 |
| deny | 0.359 ms | 0.880 ms | 1.507 ms | 50 |

Parse + policy is sub-millisecond to ~2 ms on this CPU. That is not
the expensive part.

### `redact` — distinct email per row

| Rows | p50 | p95 | p99 | n |
|---|---|---|---|---|
| 10 | 0.158 ms | 0.366 ms | 1.106 ms | 50 |
| 1 000 | 205.260 ms | 313.199 ms | 322.143 ms | 50 |
| 100 000 | **koşulamadı** | — | — | 0 |

100 000 distinct emails: a previous attempt on this script did not
finish in 6 minutes. The carry-over pass builds one regex per unique
masked value and applies the set to every cell. Forced replay:

`CONARIUM_BENCH_UNIQUE_100K=1 npm run bench:overhead`

### `redact` — same email on every row (100 000)

Labeled so it cannot be read as the unique-email cell.

| Rows | p50 | p95 | p99 | n |
|---|---|---|---|---|
| 100 000 (1 distinct email) | 653.160 ms | 840.667 ms | 840.667 ms | 8 |

p99 equals p95 here because n = 8. That is a thin tail, not a
smoothed one.

---

## What this does not say

- It does not say how much a bank will see on their Postgres. That
  cell is koşulamadı.
- It does not include receipt signing, audit JSONL, or MCP framing.
- 1 000 distinct emails already costing ~200 ms p50 is a real cost
  of the carry-over matcher. It is also in LIMITATIONS.md.
