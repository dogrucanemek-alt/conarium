# Conarium Receipt v0.1 — Uygulama Planı (Cursor için)

**Tasarım:** `docs/superpowers/specs/2026-07-29-conarium-receipt-design.md` — **önce onu oku.**
**Uygulayan:** Cursor · **Gate:** Claude (push öncesi diff incelemesi) · **Dal:** `feat/receipt-v01`

---

## ⛔ Cursor için sınırlar (ihlal = gate reddi)

1. **`git push` YOK, `git commit` serbest.** Push kararı patronun.
2. **`src/governance.ts` içindeki maskeleme mantığına DOKUNMA.** Bu iş denetim/imza katmanı.
3. **Mevcut HMAC davranışını BOZMA.** `signature` alanı ve `scripts/audit-chain-check.mjs`
   çalışmaya devam etmeli. Yeni imza ayrı alan (`sig`).
4. **`as any` / `as string` ile tip atlatma YOK** (repo `AGENTS.md` kuralı).
5. **Testte gerçek assert.** "Çalıştı, hata vermedi" test değil. Her test bir bozulma senaryosunu
   kanıtlamalı.
6. **Makbuza ham veri yazma.** Sorgu metni, alan değeri, müşteri adı — hiçbiri. Sadece sayı,
   sınıf adı ve hash. Bu kuralın testi T9'da.
7. Bir şey belirsizse **uydurma, sor.** Tasarım dokümanında cevabı yoksa dur.

---

## T1 — Ed25519 anahtar yönetimi
**Dosya:** `src/keys.ts` (yeni)

```ts
export type KeyId = string            // örn "cnr-2026-07"
export interface SigningKey { keyId: KeyId; privateKey: KeyObject }
export interface VerifyKey  { keyId: KeyId; publicKey: KeyObject }

export function generateKeyPair(keyId: KeyId): { privatePem: string; publicPem: string }
export function loadSigningKey(): SigningKey | null      // env/dosyadan, yoksa null
export function loadVerifyKeys(paths: string[]): VerifyKey[]   // rotasyon: çoklu
```

- Node `crypto` (`generateKeyPairSync('ed25519')`). Ek bağımlılık YOK.
- Özel anahtar yolu: `CONARIUM_AUDIT_SIGNING_KEY` (dosya yolu). Dosya izni 0600 değilse
  **uyarı bas** (Windows'ta izin kontrolünü atla, platform kontrolü koy).
- `keyId` açık anahtar dosyasının yanında `.keyid` olarak saklanır ya da PEM yorumundan okunur —
  hangisini seçtiysen dokümana yaz.

**Kabul:** `generateKeyPair` → `loadVerifyKeys` → imzala/doğrula turu yeşil. Bozuk PEM'de
anlamlı hata, `throw new Error('...')` mesajı ne olduğunu söylüyor.

---

## T2 — Makbuz şeması ve üretici
**Dosya:** `src/receipt.ts` (yeni)

Tasarım §4'teki JSON şemasını birebir uygula. `Receipt` tipini export et.

```ts
export function buildReceipt(input: ReceiptInput, chain: ChainState, key: SigningKey | null): Receipt
export function canonicalize(obj: unknown): string      // RFC 8785 (JCS)
export function receiptHash(r: Omit<Receipt,'hash'|'sig'|'anchor'>): string
```

- `canonicalize`: anahtarlar sıralı, boşluksuz, `undefined` alanlar atlanır. Küçük ve **kendi
  yazdığın** bir fonksiyon olsun (JCS için ağır kütüphane çekme), ama testi sağlam olsun:
  anahtar sırası farklı iki eşdeğer nesne aynı string üretmeli.
- `hash` = `sha256(canonicalize(receipt \ {hash,sig,anchor}))`, `sha256:` önekli hex.
- **`seq` zorunlu**, ardışık, boşluksuz. Tasarım §4'teki gerekçe: kapsama kanıtının tek dayanağı.
- `actor.type` v0.1'de daima `"service"`. `"user"` tipini şemada tanımla ama **üretme** —
  Katman 2 işi.
- `consentRef` alanı tanımlı ve daima `null`. Şimdi rezerve, mantığı v0.2.

**Kabul:** aynı girdi → aynı hash (deterministik). Alan sırası değişince hash değişmiyor.

---

## T3 — Fail-closed imzalama (mevcut kusurun düzeltmesi)
**Dosya:** `src/audit.ts`

🔴 **Bugünkü kusur:** satır ~121 `if (this.hmacKey) { full.signature = ... }` ve satır ~167'de
aynı şekilde doğrulama — **anahtar yoksa imzalama VE doğrulama sessizce atlanıyor, hata yok.**
Bu, `conarium-concierge`'de bulunan yalancı arıza deseninin aynısı.

Yeni davranış:
- Ed25519 anahtarı varsa → `sig` üret
- HMAC anahtarı varsa → `signature` üret (geriye dönük uyumluluk)
- **İkisi de yoksa** → `CONARIUM_AUDIT_UNSIGNED=1` açıkça ayarlanmadıkça **`throw`**.
  Ayarlıysa her başlangıçta bir kez `console.warn` bas (sessiz kalma).
- Doğrulama tarafında da aynı: anahtar yokken "geçti" dönmeyecek, "doğrulanamadı" diyecek.

**Kabul:** anahtarsız + env yok → `log()` fırlatıyor, test bunu doğruluyor. Anahtarsız +
`CONARIUM_AUDIT_UNSIGNED=1` → çalışıyor ama uyarı basılıyor. Mevcut 3 audit testi
(`audit.chain.test.ts`, `audit.failclosed.test.ts`, `audit-secrets.test.ts`) hâlâ yeşil.

---

## T4 — Bağımsız doğrulayıcı
**Dosya:** `bin/conarium-verify.mjs` (yeni, tek dosya, `src/`'a import YOK)

Neden kopya mantık: doğrulayıcının değeri **bize bağımlı olmamasında.** Üçüncü taraf `npm i`
yapmadan, repoyu klonlamadan tek dosyayı çalıştırabilmeli. Kanonikleştirme mantığı burada
tekrar yazılır — ve T5'te iki uygulamanın aynı hash'i ürettiği test edilir.

```
conarium-verify <dosya|dizin> --pubkey <yol> [--pubkey <yol2> ...] [--anchor-check] [--expect-seq-from N]
```

Çıkış kodları (tasarım §5):
`0` sağlam · `10` hash uyuşmuyor · `11` prevHash kopuk · `12` seq boşluklu/azalan ·
`13` imza geçersiz · `14` çıpa doğrulanamadı · `20` şema geçersiz

- Her hata: **insan-okunur tek satır stderr + `--json` ile makine-okunur çıktı.**
- **Fail-closed:** emin olunamayan hiçbir durumda 0 dönmez. Anahtar verilmediyse 13 ile çık,
  "imzalar kontrol edilmedi" deyip 0 dönme.
- Boş dosya / tek kayıt → 0 ama stderr'e uyarı.

**Kabul:** T5'teki 10 senaryonun tamamı beklenen kodu döndürüyor.

---

## T5 — Testler
**Dosya:** `src/receipt.test.ts` (yeni) + `test/verify.test.mjs` (yeni)

| # | Senaryo | Beklenen |
|---|---|---|
| T5.1 | Ortadaki kaydın bir alanını değiştir | 10 |
| T5.2 | Ortadaki kaydı sil | 11 |
| T5.3 | İki kaydın yerini değiştir | 11 veya 12 |
| T5.4 | `seq` atlat (1041→1043) | 12 |
| T5.5 | Başka anahtarla imzala | 13 |
| T5.6 | Rotasyon: eski+yeni `keyId` karışık zincir, iki açık anahtar verilmiş | 0 |
| T5.7 | Boş zincir / tek kayıt | 0 + uyarı |
| T5.8 | `anchor: null` + `--anchor-check` | 14 |
| T5.9 | Anahtar hiç yok, env yok | üretim `throw` |
| T5.10 | `src/receipt.ts` ve `bin/conarium-verify.mjs` aynı makbuz için aynı hash'i üretiyor | eşit |

**T5.10 en kritik test.** İki bağımsız kanonikleştirme uygulaması ayrışırsa doğrulayıcı yanlış
alarm üretir ve tüm iddia çöker.

---

## T6 — Ham veri sızıntı regresyonu (zorunlu)
**Dosya:** `src/receipt.leak.test.ts` (yeni)

Sentetik ama gerçekçi bir veri kümesinden (e-posta, telefon, TCKN, isim, API anahtarı) makbuz
üret. Üretilen makbuzun **tam JSON metninde** her ham değeri ara. **0 eşleşme zorunlu.**

`argsHash` alanının ham SQL içermediğini ayrıca doğrula (SQL string'i makbuzda geçmemeli).

**Kabul:** test yeşil. Bu test kırmızıysa hiçbir şey merge edilmez — makbuz bir sızıntı yüzeyi
olamaz.

---

## T7 — Çıpalama (en son, ağ bağımlılığı var)
**Dosya:** `src/anchor.ts` (yeni)

- Zincir başı (`hash` + `seq` + `keyId`) periyodik olarak kamu şeffaflık kütüğüne yazılır.
  Başlangıç hedefi **Sigstore/Rekor**; arayüzü soyut tut (`interface AnchorSink`) ki
  Trillian'a taşımak tek dosya değişikliği olsun.
- **Yalnızca hash gider.** Alan adı, tablo adı, müşteri adı, IP — hiçbiri.
- **Asenkron ve bloklamaz:** çıpa başarısız olursa makbuz üretimi devam eder, `anchor: null` kalır.
- Sıklık: `CONARIUM_ANCHOR_EVERY_N` (varsayılan 100) veya `CONARIUM_ANCHOR_EVERY_MS`
  (varsayılan 3600000) — hangisi önce dolarsa.
- Çıpa başarısızlığı **sessiz olmayacak**: sayaç tut, N ardışık başarısızlıkta `console.error`.

**Kabul:** ağ kapalıyken makbuz üretimi çalışıyor, `anchor: null`, hata loglanıyor. Ağ açıkken
çıpa girişi oluşuyor ve `--anchor-check` 0 dönüyor.

⚠️ Rekor'a gerçek yazma **testte yapılmaz** (dış servise bağlı test kırılgandır). `AnchorSink`
sahte uygulamayla test edilir; gerçek Rekor entegrasyonu elle bir kez doğrulanır ve sonucu
buraya yazılır.

---

## T8 — Dokümantasyon
- `README.md`: "Verifiable Receipts" bölümü + `conarium-verify` kullanımı + **daraltılmış iddia
  cümlesi birebir** (tasarım §3). İddiayı genişletme.
- `docs/RECEIPT-SPEC.md` (yeni): şemanın kamuya açık spesifikasyonu, Madde 12/19 eşleme tablosu,
  bilinen boşluklar bölümü (tasarım §7 aynen taşınır — boşlukları saklamıyoruz).
- `CHANGELOG` girdisi.

---

## Sıra ve gate noktaları

```
T1 ─▶ T2 ─▶ T3 ─▶ T4 ─▶ T5 ─▶ T6  ══GATE 1══▶  T7 ─▶ T8  ══GATE 2══▶  push (patron onayı)
                                    (Claude)                (Claude)
```

**GATE 1** (T6 sonrası): Claude diff'i inceler. Bakılacaklar: fail-closed gerçekten kapandı mı ·
T5.10 iki uygulama ayrışmıyor mu · T6 sızıntı testi gerçek mi yoksa göstermelik mi ·
HMAC geriye dönük uyumluluk bozulmamış mı · `governance.ts`'e dokunulmuş mu.

**GATE 2** (T8 sonrası): iddia metni genişletilmiş mi (en sık kaçak burada olur) ·
README'de kanıtlanamayan cümle var mı.

Push öncesi zorunlu: `git log --oneline origin/main..HEAD` ile gate'siz commit kaçmadığını
doğrula (Cursor paralel commit ekleyebiliyor).

---

## Kapsam dışı (bilinçli — bu planda YOK)
Kişi bazlı kimlik/OAuth · rıza bağlama mantığı · kapsama/olumsuz kanıt raporu · maruziyet skoru ·
donanım tasdiki · `/proof/live` ucu (ayrı iş, bu bittikten sonra) · MCP tehdit tespiti.
