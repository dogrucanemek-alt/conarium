# Custom SQL executor

Conarium does not ship MSSQL, Oracle, or any other database driver. The
operator attaches a function that receives **gated** SQL and returns rows.

This folder is an in-memory reference. It adds **no** npm dependency.

## Config

`connectors[].type` is `custom-sql`. `policy.dialect` is **required**
(`postgres`, `mssql`, or `oracle`). Omitting it rejects the file — the
postgres default would parse an unknown engine with the Postgres gate.

```json
{
  "connectors": [{
    "type": "custom-sql",
    "name": "memory",
    "description": "Operator executor",
    "config": { "module": "./memory-executor.mjs" }
  }],
  "policy": {
    "dialect": "postgres",
    "allowConnectors": ["memory"],
    "allowTables": ["public.customers"],
    "maskColumns": ["*.email"],
    "maxRows": 50
  }
}
```

The module must export `execute(sql)`.

## Programmatic register

From your own process, before the gateway boots:

```js
import { registerSqlExecutor } from '@conarium-ai/core/dist/sql-executor.js'

registerSqlExecutor('memory', async (sql) => {
  // `sql` already passed the gate. Call your driver with it.
  return { rows: [], fields: [] }
})
```

`connector.query()` is closed. The only entry is the MCP `query` tool.

There is no shipped Oracle or MSSQL connector. The gate speaks three
dialects; the connection is yours.
