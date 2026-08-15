# Query adapter

The runner never imports an implementation. It starts your adapter as a
child process:

```
<adapter> --policy <policy.json> --query <query.sql>
```

Write one JSON object to stdout, then exit 0. The decision lives in the
JSON. A non-zero exit is a tool failure, not a `deny`.

```json
{
  "decision": "allow",
  "rewrittenSql": "SELECT id FROM t LIMIT 50",
  "maskedFields": ["email"],
  "denyReason": "",
  "receipt": {}
}
```

`decision` is `allow` or `deny`. Other fields may be empty strings / `[]` / `{}`.

## Thirty-line sketch

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
// import { yourGate } from 'your-product'

const { values } = parseArgs({
  options: { policy: { type: 'string' }, query: { type: 'string' } },
})
const policy = JSON.parse(readFileSync(values.policy, 'utf8'))
const sql = readFileSync(values.query, 'utf8')
try {
  const out = yourGate(policy, sql)
  process.stdout.write(JSON.stringify({
    decision: 'allow',
    rewrittenSql: out.sql || '',
    maskedFields: out.masked || [],
    denyReason: '',
    receipt: {},
  }) + '\n')
} catch (err) {
  process.stdout.write(JSON.stringify({
    decision: 'deny',
    rewrittenSql: '',
    maskedFields: [],
    denyReason: String(err.message || ''),
    receipt: {},
  }) + '\n')
}
```

Receipt-chain cases do not use this adapter. The claims file names a
verifier command; the runner execs that.
