# Conarium demo bank

A self-contained Postgres the operator can stand up in a meeting without
pointing Conarium at anyone's production database.

The data is **obviously fake**: TCKN values fail the checksum, IBANs are
zero-padded `TR00…`, names are "Ali Deneme" / "Ayşe Örnek". That is
deliberate. Realistic-looking PII in a demo makes a banker trust the sample
and distrust you.

## Four commands

From this directory, with Docker running:

```bash
docker compose up -d --wait

# Signing key lives next to the demo, not inside the prepared config
# (`conarium-init` would overwrite the policy if run with --force here).
npx conarium-init --out ./_keys
export CONARIUM_AUDIT_SIGNING_KEY="$PWD/_keys/audit-ed25519.pem"

npx conarium-doctor
```

Expected: doctor EXIT 0, including Reachability to `127.0.0.1:54329`.

Then prove the product, in this order:

```bash
node prove-mask.mjs      # policy class vs the live DB (mask + deny)
node prove-receipt.mjs   # the real MCP gateway: query → receipt → verify
```

`prove-receipt.mjs` starts `dist/index.js` over stdio, calls `query`, and
hands the resulting JSONL to `conarium-verify`. That is the meeting demo:
masked rows, a signed receipt, and a verifier the other side can run without
us. `prove-mask.mjs` does not go through the gateway; it is not the receipt
proof.

The receipt will say the model is **undeclared**. This demo uses a **shared**
credential. The receipt states how identity was established; because a shared
credential is in use, nobody is named. That is not a bug.

`_keys/`, `conarium-audit.jsonl` and `conarium-receipts.jsonl` are local run
artefacts. They are gitignored and not in the npm tarball.

## What is in the database

| table | reachable | notes |
|---|---|---|
| `public.accounts` | allow | holder, fake TCKN, fake IBAN, TL balance |
| `public.transactions` | allow | amounts in TRY, memos |
| `public.card_vault` | **deny** | fake PAN / CVV — the point of the deny list |

Tear down: `docker compose down -v`.
