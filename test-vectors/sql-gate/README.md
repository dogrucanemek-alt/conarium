# SQL-gate attack vectors

Not receipt conformance. These are generated-attack leftovers.

`test/property_sql_gate.mjs` produces cases (alias, JOIN, CTE, comments,
writes, row-cap raises, mask bypasses, broken SQL). A **real bypass**
is written here as one JSON file and the check stays red.

`LAST-RUN.json` is the last green run (seed + counts). It is not a
claim that no bypass exists — only that this generator did not find
one.

Receipt vectors stay in the parent folder and are unchanged.
