# Benchmark — Conarium overhead

What is measured: **the cost Conarium adds**, not how fast a machine is.

Headline numbers are **p50 / p95 / p99**. Mean is not reported.

Replay:

```
# temporary Postgres (WSL Docker on this machine)
docker run -d --name conarium-bench-pg \
  -e POSTGRES_USER=conarium -e POSTGRES_PASSWORD=demo-not-a-secret \
  -e POSTGRES_DB=conarium_bench -p 54329:5432 postgres:16-alpine

CONARIUM_BENCH_DSN=postgres://conarium:demo-not-a-secret@127.0.0.1:54329/conarium_bench \
  npm run bench:overhead

docker rm -f conarium-bench-pg
```

Raw JSON: [`benchmarks/latest.json`](benchmarks/latest.json)
(this run: [`benchmarks/overhead-20260814T1346Z-linux.json`](benchmarks/overhead-20260814T1346Z-linux.json)).

No competitor numbers. n=15 cells have a thin tail (p95 = p99).

---

## This run

| | |
|---|---|
| CPU | Intel Core Ultra 9 275HX × 24 |
| RAM visible | 16 GB (WSL2) |
| OS | WSL2 Ubuntu, linux 6.18.33.2 |
| Node | v18.19.1 |
| Postgres | 16.14 (postgres:16-alpine) |
| Dataset | 5 000 rows, distinct email per row |
| When | 2026-08-14T13:46Z |

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

---

## same-limit (same row count) — the number to quote

### allow (no mask)

| maxRows | direct p50 | conarium p50 | overhead p50 / p95 / p99 | n |
|---|---|---|---|---|
| 100 | 0.427 ms | 3.798 ms | **2.850 / 3.731 / 4.191** | 50 |
| 500 | 1.069 ms | 9.257 ms | **7.973 / 11.117 / 11.545** | 50 |
| 5 000 | 5.660 ms | 73.885 ms | **69.242 / 85.116 / 85.116** | 15 |

### partial (email masked)

| maxRows | direct p50 | conarium p50 | overhead p50 / p95 / p99 | n |
|---|---|---|---|---|
| 100 | 0.577 ms | 5.968 ms | **5.006 / 6.730 / 7.099** | 50 |
| 500 | 0.950 ms | 88.363 ms | **86.615 / 112.802 / 341.147** | 50 |
| 5 000 | 4.828 ms | 21787 ms | **21770 / 25581 / 25581** | 15 |

Conservative default (100 rows, masked): **about 5 ms added**. The shipped
config caps at 50, so a fresh install stays below this figure.
500 distinct emails: **about 87 ms**. 5 000: **about 22 s**.

### deny

| maxRows | conarium p50 | query ran |
|---|---|---|
| 100 | 0.432 ms | no |
| 500 | 0.404 ms | no |
| 5 000 | 0.396 ms | no |

---

## same-sql (user query has no LIMIT)

Direct always returns 5 000 rows. Conarium returns `maxRows`.

| scenario | maxRows | direct p50 | conarium p50 | overhead p50 | rows in / out |
|---|---|---|---|---|---|
| allow | 100 | 4.023 | 3.444 | **−1.592** | 5000 → 100 |
| allow | 500 | 4.411 | 9.147 | 3.943 | 5000 → 500 |
| allow | 5 000 | 4.511 | 78.854 | 73.775 | 5000 → 5000 |
| partial | 100 | 5.862 | 6.926 | 1.824 | 5000 → 100 |
| partial | 500 | 6.177 | 90.215 | 84.854 | 5000 → 500 |
| partial | 5 000 | 5.856 | 19301 | 19289 | 5000 → 5000 |

The −1.6 ms cell is the row cap doing less I/O. It is not a claim that
masking is free.

---

## In-process redact (WSL, unique email per row)

Not a substitute for the table above. Shows the same cliff without a socket.

| distinct emails | p50 | p95 | p99 | n |
|---|---|---|---|---|
| 50 | 1.137 ms | 2.018 | 3.066 | 50 |
| 100 | 2.678 ms | 5.821 | 8.998 | 50 |
| 500 | 76.381 ms | 113.928 | 123.534 | 50 |

---

## Warning threshold

`docs/benchmarks/masking-cost-threshold.json` → **warn above 100**.

100 is the last measured point still in the low-millisecond band
(same-limit partial overhead p50 = 5.0 ms). 500 is already 87 ms.
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
