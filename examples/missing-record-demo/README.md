# Missing-record demo

Six source events, four receipts, a clean chain, two misses. The second
ledger is what sees them. Nothing here talks to production. There is no
Transparency Service in this run; the result can be registered as a
Signed Statement on one (see `draft-dogru-scitt-disclosure-evidence`).

```bash
git clone https://github.com/dogrucanemek-alt/conarium.git
cd conarium
npm ci && npm run build
cd examples/missing-record-demo
docker compose up -d --wait
npm ci
npm start
```

Expected: `integrity: clean` (verify exit 0), then
`observed-without-receipt` = 2 on `vitals` and `billing`, outcome
`exceptions`, last line:

`An intact chain missed two events. The second ledger caught them.`

Tear down: `docker compose down -v`.

This directory is not in the npm tarball.
