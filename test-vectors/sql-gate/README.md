# SQL-gate attack vectors

Not receipt conformance.

`vectors.json` is the shared named set. The same file is run per dialect
(`src/sql-gate/vectors.test.ts`). A dialect with no `sql.<name>` is skipped,
not marked supported.

`test/property_sql_gate.mjs` is the generated-attack leftover. A **real
bypass** is written here as one JSON file and that check stays red.

`LAST-RUN.json` is the last green generator run (seed + counts). It is not
a claim that no bypass exists.

Receipt vectors stay in the parent folder and are unchanged.
