export interface PseudoResult {
  /** İçindeki adlar token'la değiştirilmiş metin (LLM'e bu gider). */
  text: string;
  /** token → gerçek ad. YALNIZCA audit/iç kullanım — LLM'e ASLA gitmez. */
  map: Record<string, string>;
  /** Kaç benzersiz ad pseudonymize edildi. */
  count: number;
}

/**
 * Metindeki BİLİNEN adları (müşteri/tedarikçi/çalışan) sabit token'larla değiştirir.
 * Aynı ad her yerde aynı token'a map'lenir → LLM "Müşteri #1 borçlu + Müşteri #1 5000 harcadı"
 * diye tutarlı akıl yürütebilir ama gerçek kimliği bilmez.
 *
 * ZION entegrasyonu (assistant/route.ts): ctx'i kurarken adları buradan geçir:
 *   const { text, map } = pseudonymizeText(ctx, [...customerNames, ...supplierNames], 'Kayıt');
 *   appendAudit({ pseudoMap: map });  // token→ad audit'e, ctx (text) LLM'e.
 */
export function pseudonymizeText(text: string, names: string[], kind = 'Kayıt'): PseudoResult {
  // 3+ karakter, benzersiz, UZUN adlar önce (kısmi çakışma önlenir)
  const uniq = [...new Set(names.map(s => (s || '').trim()).filter(s => s.length >= 3))]
    .sort((a, b) => b.length - a.length);

  const map: Record<string, string> = {};
  let out = text;
  let n = 0;
  for (const real of uniq) {
    n++;
    const token = `${kind} #${n}`;
    map[token] = real;
    out = out.split(real).join(token); // tüm geçişleri değiştir
  }
  return { text: out, map, count: uniq.length };
}
