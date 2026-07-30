/**
 * Kişi bazlı kimlik — token deposu.
 *
 * Neden beyan değil token: istemcinin gönderdiği isim (X-Conarium-Actor gibi)
 * kimse tarafından doğrulanmamıştır; onu imzalayıp makbuza yazmak, dürüst
 * 'service' değerinden kötüdür. Token'ı Conarium zaten doğruluyor, dolayısıyla
 * kimin bağlandığını BİLİR.
 *
 * Token'lar düz metin saklanmaz — yalnızca SHA-256 karması. Dosya sızsa bile
 * kimsenin token'ı ele geçmez.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

export type ActorAssurance = 'shared-token' | 'per-user-token'

export interface ResolvedActor {
  id: string
  assurance: ActorAssurance
  isUser: boolean
}

/**
 * Yol her çağrıda okunur, modül yüklenirken DEĞİL.
 * Sabit olarak yakalansaydı `CONARIUM_TOKENS_FILE`'ı sonradan değiştirmek
 * hiçbir şeyi etkilemezdi — testler dahil, ki bu sessizce yanlış şeyi ölçmek
 * demek olurdu.
 */
function varsayilanYol(): string {
  return process.env.CONARIUM_TOKENS_FILE || 'conarium.tokens.json'
}

/** karma → kişi id. Dosya yoksa null = kişi bazlı kimlik kapalı (hata değil). */
export function loadTokenStore(path: string = varsayilanYol()): Map<string, string> | null {
  if (!existsSync(path)) return null
  let raw: { tokens?: { sha256?: string; id?: string }[] }
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    // Bilerek FIRLATIYORUZ, sessizce null dönmüyoruz: null dönmek kişi bazlı
    // kimliği fark edilmeden kapatır ve herkes yeniden 'service' olur —
    // sessiz düşüş, gürültülü hatadan çok daha tehlikelidir.
    throw new Error(`loadTokenStore: ${path} okunamadı/bozuk JSON — ${(e as Error).message}`)
  }
  const map = new Map<string, string>()
  for (const t of raw.tokens ?? []) {
    if (typeof t.sha256 === 'string' && typeof t.id === 'string' && t.sha256 && t.id) {
      map.set(t.sha256.toLowerCase(), t.id)
    }
  }
  return map
}

/**
 * Gelen token'ı kişiye çözer. Eşleşme yoksa ASLA kişi kimliği üretmez —
 * paylaşılan token davranışına düşer.
 */
export function resolveActor(
  supplied: string,
  store: Map<string, string> | null,
  fallbackId: string,
): ResolvedActor {
  if (store && supplied) {
    const h = createHash('sha256').update(supplied).digest('hex')
    const id = store.get(h)
    if (id) return { id, assurance: 'per-user-token', isUser: true }
  }
  return { id: fallbackId, assurance: 'shared-token', isUser: false }
}
