# Benchmark — Conarium overhead

What is measured: **the cost Conarium adds**, not how fast a machine is.

Headline numbers are **p50 / p95 / p99**. Mean is not reported.

Replay:

```
docker run -d --name conarium-bench-pg \
  -e POSTGRES_USER=conarium -e POSTGRES_PASSWORD=demo-not-a-secret \
  -e POSTGRES_DB=conarium_bench -p 54329:5432 postgres:16-alpine

CONARIUM_BENCH_DSN=postgres://conarium:demo-not-a-secret@127.0.0.1:54329/conarium_bench \
  npm run bench:overhead

docker rm -f conarium-bench-pg
```

Raw JSON (this run, current code `46acd75`):
[`benchmarks/overhead-20260818T2145Z-win32-46acd75.json`](benchmarks/overhead-20260818T2145Z-win32-46acd75.json)
and [`benchmarks/latest.json`](benchmarks/latest.json).

Same environment, previous tag `09b2100`:
[`benchmarks/overhead-20260818T2120Z-win32-09b2100.json`](benchmarks/overhead-20260818T2120Z-win32-09b2100.json).

Historical other-environment archive (do not quote next to these cells):
[`benchmarks/overhead-20260814T1346Z-linux.json`](benchmarks/overhead-20260814T1346Z-linux.json).

No competitor numbers. n=15 cells have a thin tail (p95 = p99).

---

## This run

| | |
|---|---|
| CPU | Intel Core Ultra 9 275HX × 24 |
| RAM | 32 GB |
| OS | win32 10.0.26200 |
| Node | v24.5.0 |
| Postgres | 16.15 (`postgres:16-alpine` on `127.0.0.1:54329`) |
| Dataset | 5 000 rows, distinct email per row |
| Before | `09b2100` at 2026-08-18T20:43:32Z |
| After | `46acd75` at 2026-08-18T20:44:13Z |

`maxRows` falls back to **100** in code when the policy leaves it unset; the
`conarium.config.json` shipped with the package sets **50**. A fresh install
therefore runs at 50. Measurements below use 100 as the conservative case —
a fresh install is faster, not slower. Caps measured: 100 · 500 · 5 000.

Two series, same user SQL both sides:

- **same-sql** — no `LIMIT` in the user query. Conarium adds `maxRows`. Direct
  returns 5 000 rows. A negative delta is the cap, not a faster mask.
- **same-limit** — user SQL already has `LIMIT = maxRows`. Same row count.
  This is the gate tax.

Deny must not hit Postgres. It did not.

The tables below are **after** (`46acd75`). The before/after pair for the
masked cliff is under Warning threshold.

---

## same-limit (same row count) — the number to quote

### allow (no mask)

| maxRows | direct p50 | conarium p50 | overhead p50 / p95 / p99 | n |
|---|---|---|---|---|
| 100 | 1.157 ms | 3.789 ms | **2.392 / 3.183 / 3.594** | 50 |
| 500 | 1.863 ms | 9.944 ms | **7.832 / 14.539 / 15.034** | 50 |
| 5 000 | 7.328 ms | 94.699 ms | **88.884 / 119.527 / 119.527** | 15 |

### partial (email masked)

| maxRows | direct p50 | conarium p50 | overhead p50 / p95 / p99 | n |
|---|---|---|---|---|
| 100 | 1.162 ms | 4.092 ms | **2.670 / 4.395 / 4.740** | 50 |
| 500 | 1.633 ms | 10.967 ms | **8.801 / 16.200 / 16.692** | 50 |
| 5 000 | 7.646 ms | 99.731 ms | **92.929 / 125.204 / 125.204** | 15 |

Conservative default (100 rows, masked): **about 3 ms added**. The shipped
config caps at 50, so a fresh install stays below this figure.
500 distinct emails: **about 9 ms**. 5 000: **about 93 ms**.

On the same machine, `09b2100` same-limit partial overhead was
5.6 ms / 83 ms / **14.1 s**. That 14 s cell is the cost that `46acd75` removed.

### deny

| maxRows | conarium p50 | query ran |
|---|---|---|
| 100 | 0.786 ms | no |
| 500 | 0.646 ms | no |
| 5 000 | 0.630 ms | no |

---

## same-sql (user query has no LIMIT)

Direct always returns 5 000 rows. Conarium returns `maxRows`.

| scenario | maxRows | direct p50 | conarium p50 | overhead p50 | rows in / out |
|---|---|---|---|---|---|
| allow | 100 | 4.920 | 3.479 | **−0.919** | 5000 → 100 |
| allow | 500 | 3.882 | 5.820 | 1.451 | 5000 → 500 |
| allow | 5 000 | 3.617 | 38.852 | 32.992 | 5000 → 5000 |
| partial | 100 | 5.413 | 3.492 | **−1.610** | 5000 → 100 |
| partial | 500 | 4.515 | 5.874 | 0.802 | 5000 → 500 |
| partial | 5 000 | 7.142 | 93.473 | 85.634 | 5000 → 5000 |

The negative cells are the row cap doing less I/O. They are not a claim that
masking is free.

---

## In-process redact (win32, unique email per row)

Not a substitute for the table above. Same environment; only 50 / 100 / 500
are timed in-process when a DSN is set (5 000 lives in the Postgres table).

| distinct emails | p50 | p95 | p99 | n |
|---|---|---|---|---|
| 50 | 0.790 ms | 1.192 | 1.460 | 50 |
| 100 | 1.195 ms | 1.811 | 2.181 | 50 |
| 500 | 4.066 ms | 10.756 | 12.308 | 50 |

---

## Warning threshold

`docs/benchmarks/masking-cost-threshold.json` → **warn above 500**.

500 is the last measured cap still in the low-millisecond band
(same-limit partial overhead p50 = 8.8 ms). 5 000 is 93 ms.
The doctor and `parseConariumConfig` warn. They do not reject the query.

---

## Concurrency (in-process, not Hetzner)

Replay: `node scripts/benchmark-concurrency.mjs` (needs `npm run build`).
Raw: [`benchmarks/concurrency-20260814.json`](benchmarks/concurrency-20260814.json).

| | |
|---|---|
| CPU | Intel Core Ultra 9 275HX × 24 |
| RAM | 32 GB |
| OS | win32 10.0.26200 |
| Node | v24.5.0 |
| N | 50 concurrent MCP `query` (mock connector) |
| When | 2026-08-14T18:19Z |

p50 **45.5 ms** · p95 **48.6 ms** · p99 **61.3 ms** · wall **98 ms** · error rate **0**.
Single `Audit` instance: 50 entries, **0** `prevHash` breaks (`log()` is synchronous).
This is not a leak hunt and not a two-process sink race.
