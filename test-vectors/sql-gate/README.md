# SQL-gate attack vectors

Not receipt conformance.

`vectors.json` is the shared named set. The same file is run per dialect
(`src/sql-gate/vectors.test.ts`). A dialect with no `sql.<name>` is skipped,
not marked supported.

Postgres policy uses `public.*`. MSSQL overlay uses `dbo.*`. Oracle overlay
uses `app.*`. All three have a live engine run. Oracle synonyms and
database links are not resolved — that is a documented limit, not a skip.

`test/property_sql_gate.mjs` is the generated-attack leftover. A **real
bypass** is written here as one JSON file and that check stays red.

`LAST-RUN.json` is the last green generator run (seed + counts). It is not
a claim that no bypass exists. There is no `when` timestamp — the file is
a lock on those counts, so a test run only dirties git when the result
changes.

Receipt vectors stay in the parent folder and are unchanged.
