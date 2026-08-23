# Starter kit — try it in 15 minutes

A local Postgres, three mediated queries, signed receipts, then reconcile
against the database's own counters. Nothing here talks to production.

```bash
git clone https://github.com/dogrucanemek-alt/conarium.git
cd conarium/examples/starter-kit
docker compose up -d --wait
npm ci
npm start
```

Expected: three receipts, `conarium-verify` exit 0, email column
`[MASKED_PII]`, a reconcile summary table.

Red paths (after `npm start`):

```bash
npm run tamper    # break one receipt → conarium-verify exit != 0
npm run bypass    # query outside the gate → observed-without-receipt >= 1
```

Tear down: `docker compose down -v`.

This directory is not in the npm tarball.
