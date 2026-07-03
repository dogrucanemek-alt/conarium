import { describe, it, expect } from 'vitest';
import { pseudonymizeText } from './pseudonymize.js';

describe('pseudonymizeText — ZION isim leak kapatma (Faz 2)', () => {
  it('adları sabit token yapar, gerçek ad metinden tamamen çıkar', () => {
    const ctx = 'Ahmet Yilmaz 5000 TL harcadi. Ahmet Yilmaz geciken alacakli. Mehmet Kaya 3000 TL.';
    const r = pseudonymizeText(ctx, ['Ahmet Yilmaz', 'Mehmet Kaya'], 'Musteri');

    expect(r.text).not.toContain('Ahmet Yilmaz');
    expect(r.text).not.toContain('Mehmet Kaya');
    expect(r.text).toContain('Musteri #1');
    expect(r.text).toContain('Musteri #2');
    // Aynı ad her yerde AYNI token (LLM tutarlı akıl yürütür)
    expect((r.text.match(/Musteri #1/g) || []).length).toBe(2);
    expect(r.count).toBe(2);
  });

  it('token→ad haritası audit için saklanır (LLM\'e gitmez)', () => {
    const r = pseudonymizeText('Ayse Demir borclu', ['Ayse Demir'], 'Kayit');
    expect(r.map['Kayit #1']).toBe('Ayse Demir');
    expect(r.text).not.toContain('Ayse Demir');
  });
});
