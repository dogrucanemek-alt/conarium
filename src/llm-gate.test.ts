import { describe, it, expect } from 'vitest';
import { governLlm } from './llm-gate.js';

describe('governLlm — Conarium LLM kapısı', () => {
  it('giden prompt PII maskelenir + audit çağrılır', async () => {
    const captured: string[] = [];
    const fakeLlm = async (p: string) => { captured.push(p); return 'ok'; };
    const audits: any[] = [];
    const gated = governLlm(fakeLlm, {}, a => audits.push(a));

    const out = await gated('Musteri ahmet@test.com TCKN 12345678901 harcadi 5000 TL');

    expect(out).toBe('ok');
    expect(captured[0]).not.toContain('ahmet@test.com');
    expect(captured[0]).not.toContain('12345678901');
    expect(captured[0]).toContain('[MASKED_PII]');
    expect(audits[0].maskedCount).toBeGreaterThan(0);
  });

  it('DÜRÜST sınır: adlar regex ile maskelenMEZ (Faz 2 = kaynakta pseudonymize)', async () => {
    const captured: string[] = [];
    const gated = governLlm(async p => { captured.push(p); return ''; });
    await gated('Ahmet Yilmaz 5000 TL harcadi');
    expect(captured[0]).toContain('Ahmet Yilmaz'); // ad maskeli DEGIL — bilinen limit
  });
});
