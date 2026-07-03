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
