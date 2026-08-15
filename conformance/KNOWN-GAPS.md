# Known gaps

These cases are in the suite on purpose. They are not hidden, and they
are not claimed as capabilities.

`inference-control` is **not** in the claims file. The term is bounded
inference controls: a control can raise the cost of an attack. It does
not make a value unlearnable.

| id | Expected status | Why it is listed |
|---|---|---|
| `inference/count-channel` | NOT_COVERED | `SELECT count(*) … WHERE email LIKE 'a%'` under mask-only policy. 1 vs 0 answers a question about a masked value. |
| `inference/exists-channel` | NOT_COVERED | `EXISTS` on the same column is the same 1/0 channel. |
| `inference/repeated-probe` | NOT_COVERED | Successive narrowing predicates are not budgeted per session. |
| `inference/cohort-narrowing` | NOT_COVERED | `GROUP BY` on an allowed column yields cohort sizes. |
| `coverage/tail-without-pin` | DETECTED_WITH_EXTERNAL_PIN | A hash chain cannot see receipts deleted from the end unless a pin or anchor is supplied. |

Each of these files sets `expectedFail: true`. The runner treats the
listed status as the expected outcome. If a listed gap starts returning
`ENFORCED`, the job fails — the list must be edited in the same change.
