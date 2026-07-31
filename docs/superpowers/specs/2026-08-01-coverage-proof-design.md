# Conarium Kapsama Kanıtı v0.2 — Tasarım Notu

**Tarih:** 2026-07-31 · **Durum:** onay bekliyor · **Kapsam:** Katman 0 (okuyucudan bağımsız)

---

## 1. Problem (spec boşluğu #2)

Receipt v0.1/v0.2 "elimde 380 makbuz var" diyebiliyor ama "380'den fazlası olmadı"
diyemiyor. Makbuzun değeri **varlığında değil, yokluğun anlamlı olmasında**.

Satılabilir hedef cümle:
> P döneminde, beyan edilen S kapsamında: zincir 1..412 arası KESİNTİSİZ, 412 makbuz var,
> kapsamdaki 7 nesnenin 5'ine erişildi, 2'sine erişim KAYDEDİLMEDİ.

## 2. En kritik tasarım kuralı: "erişim OLMADI" demek YASAK

Diyebileceğimiz tek şey **"erişim KAYDEDİLMEDİ"**. Kaydın yokluğu belirsizdir:
- gerçekten erişilmemiş olabilir,
- Conarium atlanmış olabilir (bypass),
- loglama patlamış olabilir.

Bu ayrım **kodun içine** yazılır — yoruma değil, alan adlarına ve mesaj metnine geçirilir.
Alan adı: `notRecorded` / `notRecordedObjects`. Mesaj metni: "access NOT RECORDED".
"not accessed" / "erişilmedi" ifadesi hiçbir yerde geçmez. Bu kural çiğnenirse ürünün
tüm dürüstlük konumu çöker.

## 3. Kapsam (bu tur)

Deterministik, harici bağımlılıksız **kapsama beyanı üreticisi + doğrulayıcısı**.

**Dışında (bilinçli):** DB log mutabakatı (pg_stat_statements karşılaştırması) — ayrı iş,
canlı DB gerektirir. Bu tur yalnızca temel kurulur.

## 4. Kapsama beyanı artefaktı

Receipt şemasına ve `keys.ts`'e dayanır — yeni imza şeması icat edilmez. `canonicalize`
(JCS subset) + `signHash`/`verifyHash` (Ed25519) kullanılır.

```jsonc
{
  "v": "conarium-coverage/0.1",
  "id": "01J8...",                    // ULID
  "ts": "2026-08-01T09:00:00.000Z",   // beyan üretim zamanı

  "period": { "start": "...", "end": "..." },  // makbuz zaman damgalarından (min/max ts)

  "declaredScope": ["public.customers", "public.orders"],  // policy allowTables — yeni beyan icat edilmez

  "chain": {
    "firstSeq": 1,
    "lastSeq": 412,
    "count": 412,
    "contiguous": true,               // false ise gaps dolu
    "gaps": []                        // [{ "expectedSeq": 200, "foundSeq": 201 }]
  },

  "decisions": { "allow": 400, "partial": 10, "deny": 2 },

  "coverage": {
    "declared": 7,                    // declaredScope uzunluğu
    "accessed": 5,                    // erişimi KAYDEDİLEN nesne sayısı
    "notRecorded": 2,                 // erişimi KAYDEDİLMEYEN nesne sayısı
    "accessedObjects": ["public.customers", "public.orders", "..."],
    "notRecordedObjects": ["public.audit_logs", "public.wa_messages"]
  },

  "sig": { "alg": "Ed25519", "keyId": "...", "value": "base64..." }
}
```

`hash` = `sha256(canonical_json(beyan \ {sig}))`. `sig` = `Ed25519(hash)`.
İmza, `keys.ts`'teki `signHash`/`verifyHash` ile üretilir/doğrulanır.

### Alan anlamları (dürüstlük kuralı)

- `coverage.accessed` = makbuzlarda `dataRefs[].object` içinde GEÇEN declaredScope nesneleri.
- `coverage.notRecorded` = declaredScope'ta olup makbuzlarda HİÇ geçmeyen nesneler.
  Anlamı: "bu nesneye erişim KAYDEDİLMEDİ" — "erişilmedi" değil.
- `declaredScope` = policy `allowTables` (kapsam zaten orada beyan edilmiş; yeni mekanizma yok).

## 5. Üretici sözleşmesi (`src/coverage.ts`)

Saf fonksiyonlar — test edilebilir, harici bağımlılık yok.

```
buildCoverageDeclaration(receipts: Receipt[], declaredScope: string[], key: SigningKey): CoverageDeclaration
```

- `receipts` boşsa → **anlamlı hata** (sessiz geçme yok): "no receipts to declare coverage over".
- `chain.contiguous` hesaplanır: seq 1..N arası her değer tam olarak bir kez mi?
  Boşluk varsa `gaps` listelenir (expectedSeq → foundSeq).
- `period` = makbuz `ts` alanlarının min/max'ı.
- `decisions` = makbuz `policy.decision` sayımları (allow/partial/deny).
- `coverage` = declaredScope ∩ makbuz `dataRefs[].object`.

## 6. Doğrulayıcı sözleşmesi (`bin/conarium-coverage.mjs`)

Ayrı bin — `conarium-verify` zincir doğruluyor, kapsama beyanı ayrı bir artefakt.
Karıştırmamak için ayrı CLI. `conarium-verify.mjs` deseni: sıfır src bağımlılığı,
çevrimdışı, tek dosya.

```
conarium-coverage <beyan.json> --pubkey <path> [--receipts <receipts.jsonl>] [--json]
```

Kontroller ve çıkış kodları:

| Kod | Anlam |
|---|---|
| 0 | Beyan imzası geçerli + (verilirse) makbuzlarla tutarlı + zincir kesintisiz |
| 12 | Zincir kesintili (makbuz eksik) — `--allow-gaps` ile yalnız özgünlük doğrulanır |
| 13 | İmza geçersiz / pubkey yok |
| 20 | Şema geçersiz |
| 30 | Makbuzlarla tutarsız (count/seq/coverage uyuşmuyor) |

> **İki ayrı soru.** Bu araç iki ayrı soruya cevap verir: (a) "beyan özgün mü" ve
> (b) "kapsama eksiksiz mi". Varsayılan **SIKI** mod ikisini de sorar: zincirde boşluk
> varsa (makbuz eksikse) EXIT 12 döner ve "ok:" yazmaz. `--allow-gaps` yalnızca (a)
> sorusunu sorar — özgünlük geçerliyse EXIT 0 döner, kapsam eksikliği yalnızca uyarıdır.

Her hata insan-okunur tek satır + makine-okunur JSON. Sessiz başarısızlık yok (fail-closed).

## 7. Test planı

| Senaryo | Beklenen |
|---|---|
| Kesintisiz zincir (1..N) | `contiguous: true`, gaps boş, count doğru |
| seq'te boşluk (1..5, 7..10) | `contiguous: false`, gaps `[{expectedSeq:6, foundSeq:7}]` |
| Kapsamda olup hiç erişilmemiş nesne | `notRecordedObjects` içinde, `notRecorded` sayısı doğru |
| Boş makbuz dosyası | anlamlı hata, sessiz geçme yok |
| İmza doğrulaması | geçerli imza → 0, bozuk imza → 13 |

## 8. Açık sorular (uygulamayı bloklamıyor)

- Beyan üretimi bir CLI mı olmalı yoksa Audit'e mi gömülmeli? (öneri: ayrı CLI + src fonksiyonu;
  Audit'e gömme bu turun kapsamı dışı)
- `declaredScope`'ta glob (`billing.*`) varsa nasıl genişletilecek? (öneri: makbuzlarda geçen
  gerçek nesne adlarıyla eşleştir; glob'u genişletme bu turda yok)
