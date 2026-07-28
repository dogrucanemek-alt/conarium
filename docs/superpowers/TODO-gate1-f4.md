# Receipt v0.1 — GATE 1 deferred work

## F4 — gerçek metin (Claude GATE 1)

**Status:** done via **F5** (2026-07-29, push-öncesi) · **Source:** Claude GATE 1

**F4 / F5 gövdesi (patron onayıyla uygulanan metin):**

> `validateChain`'e bitişiklik kuralı (`sig` taşıyan ilk satırdan sonra her
> satırda `sig` zorunlu; yabancı `keyId` kabul, yokluk red) + çoklu `keyId`
> trust store + bu senaryonun testi.

### Uygulama (F5)

| Kural | Davranış |
|---|---|
| Bitişiklik | İlk `sig`'li satırdan sonra `sig` yokluğu → corrupt |
| Yabancı `keyId` | Trust store'da varsa ve crypto geçerse kabul |
| Trust store | Mevcut signing pubkey + `CONARIUM_AUDIT_TRUST_PUBKEYS` (`,` / `;`) |
| Bilinmeyen `keyId` | Trust store doluyken fail-closed |
| Legacy önek | İlk `sig`'den önceki imzasız satırlar hâlâ kabul |

Testler: `src/audit.receipt-gate.test.ts`.
