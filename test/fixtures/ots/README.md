# OpenTimestamps fixtures (A6.5–A7)

Committed for offline/CI verify tests. **No private keys. No customer data.**

| File | Purpose |
|---|---|
| `chain-pending.jsonl` | Signed receipt whose `chain.hash` matches `pending-matching.ots` |
| `pending-matching.ots` | Calendar-attested (pending Bitcoin) proof for that hash |
| `other-ffff.ots` | Proof for digest `ff…ff` — mismatch fixture for A6.7 |
| `pubkey.pem` + `.keyid` | Ed25519 public key that verifies `chain-pending.jsonl` |

Regenerate (needs network once): stamp the receipt hash with `javascript-opentimestamps`, never commit the private key.
