import { createPrivateKey } from 'crypto'
import { describe, expect, it } from 'vitest'
import { generateKeyPair } from './keys.js'
import { buildReceipt, hashArgs, nextChainState, type ReceiptInput } from './receipt.js'

/**
 * T6 — Receipt must never become a leak surface.
 * Synthetic but realistic PII/secrets in the *source* data must not appear in the receipt JSON.
 */
describe('T6 receipt leak regression', () => {
  const secrets = {
    email: 'ayse.yilmaz@dogrucan.example',
    phone: '+90 532 111 2233',
    tckn: '10000000146',
    name: 'Ayşe Yılmaz',
    apiKey: 'sk_live_ABCDEFGHIJKLMNOPQRSTUV',
    sql: "SELECT email, phone FROM customers WHERE email = 'ayse.yilmaz@dogrucan.example'",
  }

  it('receipt JSON contains zero raw secret/PII values', () => {
    const pair = generateKeyPair('cnr-leak')
    const key = { keyId: 'cnr-leak', privateKey: createPrivateKey(pair.privatePem) }

    const input: ReceiptInput = {
      period: { start: '2026-07-29T08:00:00.000Z', end: '2026-07-29T08:00:02.000Z' },
      actor: { id: 'conarium_c2' },
      model: { provider: 'anthropic', name: 'claude-haiku-4-5', version: '20251001' },
      client: { name: 'cursor', version: '2.x' },
      request: {
        tool: 'query',
        target: 'demo-db',
        // Only the hash of the SQL — never the SQL itself.
        argsHash: hashArgs({ sql: secrets.sql }),
      },
      dataRefs: [
        { source: 'zion', object: 'customers', fieldsRequested: ['email', 'phone', 'tckn'] },
      ],
      policy: {
        id: 'conarium.config.c2',
        version: '3',
        decision: 'partial',
        rulesApplied: ['allowlist.table', 'mask.pii', 'rowcap'],
      },
      flags: ['rowcap_hit'],
      masking: {
        maskedCount: 121366 + 98004,
        byClass: { email: 121366, phone: 98004, tckn: 0, secret: 0 },
        rowsReturned: 121374,
        rowCapApplied: true,
      },
      outcome: { status: 'complete', denied: false },
      // Payload carries the secrets. The receipt must bind the bytes (hash)
      // without reprinting them.
      disclosurePayload: JSON.stringify({
        email: secrets.email,
        phone: secrets.phone,
        tckn: secrets.tckn,
        name: secrets.name,
        apiKey: secrets.apiKey,
      }),
    }

    const receipt = buildReceipt(input, nextChainState(null), key)
    const text = JSON.stringify(receipt)
    expect(receipt.disclosure.source).toBe('measured')
    expect(receipt.disclosure.hash?.startsWith('sha256:')).toBe(true)

    for (const [label, value] of Object.entries(secrets)) {
      expect(text.includes(value), `leak of ${label}: ${value}`).toBe(false)
    }

    // argsHash must not embed the SQL string
    expect(receipt.request.argsHash.startsWith('sha256:')).toBe(true)
    expect(receipt.request.argsHash).not.toContain('SELECT')
    expect(receipt.request.argsHash).not.toContain(secrets.email)
  })
})
