import { describe, it, expect } from 'vitest';
import { Governance } from './governance.js';

describe('maskPII — base64 sertleştirmesi (purple-team döngüsü)', () => {
  const gov = new Governance({});

  it('düz-metin e-postayı maskeler', () => {
    expect(gov.maskPII('ahmet@wearu.app').masked).toBe('[MASKED_PII]');
  });

  it('base64-kodlu e-postayı da maskeler (encode bypass kapandı)', () => {
    const b64 = Buffer.from('ahmet@wearu.app').toString('base64');
    const r = gov.maskPII(b64);
    expect(r.masked).toBe('[MASKED_PII]');
    expect(r.count).toBeGreaterThan(0);
  });

  it('PII olmayan base64 metni maskelemez (false-positive yok)', () => {
    const b64 = Buffer.from('merhaba dunya bugun hava cok guzel').toString('base64');
    const r = gov.maskPII(b64);
    expect(r.masked).toBe(b64);
    expect(r.count).toBe(0);
  });
});

// Codex denetimi 2026-07-06 (P1): yanıt akışında SIR maskeleme. README "secrets are
// redacted in the response stream before the model sees a single character" diyor.
describe('maskPII — sır maskeleme (yanıt yolu, Codex P1)', () => {
  const gov = new Governance({});

  it('OpenAI/Stripe/AWS/GitHub anahtarlarını maskeler', () => {
    expect(gov.maskPII('sk_live_abc123DEF456').masked).toBe('[MASKED_SECRET]');
    expect((gov.maskPII('key is sk-proj-ABCDEFGHIJKL now').masked as string)).toContain('[MASKED_SECRET]');
    expect((gov.maskPII('AKIAIOSFODNN7EXAMPLE').masked as string)).toContain('[MASKED_SECRET]');
    expect((gov.maskPII('ghp_1234567890abcdefghijABCDEFG').masked as string)).toContain('[MASKED_SECRET]');
  });

  it('bağlantı-dizesi kimliğini ve Bearer token\'ı maskeler', () => {
    expect((gov.maskPII('postgres://user:hunter2secret@db:5432/x').masked as string)).toContain('[MASKED_SECRET]');
    expect((gov.maskPII('postgres://user:hunter2secret@db:5432/x').masked as string)).not.toContain('hunter2secret');
    expect((gov.maskPII('Authorization: Bearer eyJhbGc.payload.sig').masked as string)).toContain('[MASKED_SECRET]');
  });

  it('sır ima eden SÜTUN ADINDAKİ değeri maskeler (api_key/secret/token/password)', () => {
    const r = gov.maskPII({ id: 7, api_key: 'anything-opaque-value', note: 'ok' }) as { masked: Record<string, unknown>; count: number };
    expect(r.masked.api_key).toBe('[MASKED_SECRET]');
    expect(r.masked.id).toBe(7);
    expect(r.masked.note).toBe('ok');
  });

  it('gerçek senaryo: integrations satırında ham API anahtarı MODELE gitmez', () => {
    // "example_not_a_real_key": GitHub push-protection gerçekçi sk_live_ desenini
    // gerçek Stripe anahtarı sanıp public mirror push'unu blokluyor — bizim maske
    // regex'i (sk_live_[A-Za-z0-9]{6,}) bu açıkça-sahte değeri de aynı şekilde yakalar.
    const row = { integration: 'stripe', api_key: 'sk_live_exampleFake00' };
    const out = (gov.maskPII(row) as { masked: Record<string, unknown> }).masked;
    expect(JSON.stringify(out)).not.toContain('sk_live_exampleFake');
  });

  it('sıradan metni bozmaz (false-positive yok)', () => {
    expect(gov.maskPII('bu ay ciro arttı, marj iyi').masked).toBe('bu ay ciro arttı, marj iyi');
    expect(gov.maskPII({ urun: 'koltuk', adet: 12 }).count).toBe(0);
  });
});
