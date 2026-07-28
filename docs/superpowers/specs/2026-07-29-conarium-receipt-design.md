# Conarium Receipt v0.1 — Tasarım Dokümanı

**Tarih:** 2026-07-29 · **Durum:** onay bekliyor · **Kapsam:** Katman 0 (okuyucudan bağımsız)

---

## 1. Problem

AB AI Yasası **Madde 12** yüksek riskli AI sistemleri için otomatik, **kurcalanma-kanıtlı** kayıt
zorunlu kılıyor; **Madde 19** içeriği sayıyor. Uygulama tarihi: 2 Aralık 2027 (bağımsız sistemler).

Bugün Conarium'un denetim kaydı var ama **üçüncü tarafa hiçbir şey kanıtlamıyor**, çünkü imza
simetrik (`createHmac('sha256', CONARIUM_AUDIT_HMAC_KEY)` — `src/audit.ts`). Doğrulayan taraf
imzalayanla aynı gizli anahtarı tutmak zorunda; o anahtarı verdiğin an aynı kişi kayıt da
uydurabilir. Yani mevcut kayıt **iç tutarlılık** sağlıyor, **inkâr edilemezlik** sağlamıyor.

Bu doküman, denetim satırını taşınabilir ve bağımsız doğrulanabilir bir **makbuza** çeviriyor.

## 2. Kapsam (v0.1)

**İçinde:** Ed25519 asimetrik imza · makbuz şeması (Md.12/19 eşlemeli) · bağımsız doğrulayıcı CLI ·
zincir başının kamu şeffaflık kütüğüne çıpalanması · mevcut HMAC zincirlerinden geçiş.

**Dışında (bilinçli):** kişi bazlı kimlik (ayrı iş, Katman 2) · rıza bağlama (alan rezerve edildi,
mantık v0.2) · kapsama/olumsuz kanıt raporu (v0.2, ama v0.1 şeması buna izin verecek şekilde
tasarlandı) · maruziyet skoru · donanım tasdiki.

## 3. En kritik karar: imzayı kim üretir, ne iddia ediyoruz

Conarium self-hosted çalışır. Müşteri kendi anahtarıyla imzalarsa **müşteri makbuz uydurabilir.**
Bu, hiçbir kriptografiyle çözülemez; sadece kapsamı dürüst daraltarak yönetilir.

Değerlendirilen yollar:

| Yol | Karar |
|---|---|
| (a) Conarium birlikte imzalar | ⛔ RED — trafiği görmemiz gerekir, "veri sınırından çıkmaz" vaadini bozar |
| (b) Donanım tasdiki / TEE | ⏸ ERTELENDİ — kurulum yükü çok ağır, v0.1'i öldürür (Aegon bu yolu seçmiş) |
| (c) Sadece çıpalama: yalnızca zincir başı bize gelir | ✅ **SEÇİLDİ** |
| (d) Daraltılmış iddia beyanı | ✅ **SEÇİLDİ (c ile birlikte)** |

**Sonuç ve resmî iddia metni:**

> Conarium Makbuzu, kayıtların **oluşturulduktan sonra değiştirilmediğini, silinmediğini,
> yeniden sıralanmadığını ve geriye dönük tarihlenmediğini** kanıtlar.
> **Oluşturma anında doğru olduğunu kanıtlamaz.**

Bu daraltma bir zayıflık değil, satılabilir tek dürüst konum: rakiplerin "audit logging" iddiası
bundan daha geniş ve daha az kanıtlanabilir.

## 4. Makbuz şeması v0.1

Kural: **ham veri hiçbir alana girmez.** Yalnızca sayılar, sınıflar ve hash'ler.

```jsonc
{
  "v": "conarium-receipt/0.1",
  "id": "01J8...",                  // ULID
  "ts": "2026-07-29T08:14:02.113Z", // Md.19: zaman damgası
  "period": { "start": "...", "end": "..." },   // Md.19: kullanım dönemi

  "actor": { "type": "service", "id": "conarium_c2" },
  // v0.1'de type daima "service" (bkz. §7 bilinen boşluk). Katman 2'de "user" + idp gelir.

  "model":  { "provider": "anthropic", "name": "claude-haiku-4-5", "version": "20251001" }, // Md.19
  "client": { "name": "cursor", "version": "2.x" },

  "request": { "tool": "query", "target": "demo-db", "argsHash": "sha256:..." },
  // argsHash: sorgunun kendisi DEĞİL, hash'i. Ham SQL müşteri verisi içerebilir.

  "dataRefs": [                     // Md.19: kontrol edilen referans veritabanları
    { "source": "zion", "object": "v_monthly", "fieldsRequested": ["month","revenue"] }
  ],

  "policy": {                       // Md.19: uygulanan yönetişim politikası
    "id": "conarium.config.c2", "version": "3",
    "decision": "partial",          // allow | deny | partial
    "rulesApplied": ["allowlist.table", "mask.pii", "rowcap"]
  },
  "flags": ["rowcap_hit"],          // Md.19: tetiklenen politika bayrakları

  "masking": {
    "maskedCount": 485496,
    "byClass": { "email": 121366, "phone": 98004, "tckn": 0, "secret": 0 },
    "rowsReturned": 121374,
    "rowCapApplied": false
  },
  "outcome": { "status": "complete", "denied": false },

  "consentRef": null,               // v0.2 için rezerve (ISO/IEC TS 27560 kaydına bağlama)

  "chain": { "seq": 1042, "prevHash": "sha256:...", "hash": "sha256:..." },
  "sig":   { "alg": "Ed25519", "keyId": "cnr-2026-07", "value": "base64..." },
  "anchor": null                    // asenkron doldurulur, bkz. §6
}
```

`hash` = `sha256(canonical_json(makbuz \ {hash, sig, anchor}))`. Kanonikleştirme: JCS (RFC 8785),
anahtarlar sıralı, boşluksuz. `sig` = `Ed25519(hash)`.

**Neden `seq` var:** ardışık ve boşluksuz sıra numarası, "hiçbir etkileşim eksik değil"
iddiasının tek dayanağı. Kapsama/olumsuz kanıt (v0.2) buna oturacak. v0.1'de üretmesek de
şemaya şimdi koymak zorundayız, sonradan eklenirse geçmiş zincir işe yaramaz.

## 5. Doğrulayıcı sözleşmesi

Tek dosya, sıfır Conarium bağımlılığı, çevrimdışı çalışır. Ağ yalnızca `--anchor-check` ile.

```
conarium-verify <dosya|dizin> --pubkey <yol|url> [--anchor-check] [--expect-seq-from N]
```

Kontroller ve çıkış kodları:

| Kod | Anlam |
|---|---|
| 0 | Zincir sağlam, imzalar geçerli |
| 10 | `hash` yeniden hesaplanamıyor → kayıt değiştirilmiş |
| 11 | `prevHash` kopuk → kayıt silinmiş ya da araya eklenmiş |
| 12 | `seq` boşluklu ya da azalıyor → kayıt eksik / yeniden sıralanmış |
| 13 | İmza geçersiz → yetkisiz anahtarla üretilmiş |
| 14 | Çıpa kanıtı doğrulanamadı → geriye dönük tarihlenmiş olabilir |
| 20 | Şema geçersiz |

Her hata **insan-okunur tek satır + makine-okunur JSON** basar. Sessiz başarısızlık yok:
doğrulayıcı emin olamadığı hiçbir durumda 0 dönmez (fail-closed).

## 6. Çıpalama

Kendi Sertifika Otoritemizi kurmuyoruz. Zincir başı (`hash` + `seq` + `keyId`) periyodik olarak
mevcut bir kamu şeffaflık kütüğüne yazılır (Sigstore/Rekor veya Trillian). Yazılan şey **yalnızca
hash'tir** — veri değil, alan adı değil, tablo adı değil.

```
Conarium (müşteri sunucusu)          Kamu şeffaflık kütüğü
  makbuz #1042 ──┐
  makbuz #1043   ├─ zincir başı hash ──────▶ kütük girişi + inclusion proof
  makbuz #1044 ──┘                              │
                     anchor alanı  ◀────────────┘
```

Bu neden önemli: çıpa olmadan operatör tüm zinciri baştan yeniden üretip eski tarih yazabilir.
Çıpa ile "bu hash şu tarihte zaten vardı" bağımsız olarak kanıtlanır.

⚠️ Çıpalama **asenkron** ve **başarısız olabilir** (ağ yok, kütük erişilemez). Tasarım kararı:
çıpa başarısızlığı makbuz üretimini **bloklamaz**, ama `anchor: null` kalır ve doğrulayıcı
`--anchor-check` ile çağrıldığında bunu **eksik** olarak raporlar (sessizce geçmez).

## 7. Bilinen boşluklar (dokümante ediliyor, saklanmıyor)

1. **`actor` gerçek insanı göstermiyor.** v0.1'de daima servis kimliği. Bir ekipte on kişinin on
   erişimi aynı isimle düşer. Katman 2'de per-user OAuth ile kapanacak. **Bu boşluk kapanmadan
   "kim erişti" iddiası pazarlama metninde kullanılamaz.**
2. **Bypass tespiti yok.** Operatör Conarium'u tamamen devre dışı bırakıp veriye doğrudan
   erişirse makbuz hiç üretilmez ve zincir yine sağlam görünür. Kapsama kanıtı (v0.2) bunu
   *beyan edilmiş şema* karşısında kısmen tespit edebilir, tamamen çözemez.
3. **Oluşturma anı doğruluğu kanıtlanamıyor** (bkz. §3). Donanım tasdiki olmadan çözümü yok.
4. **`argsHash` ile hata ayıklama zorlaşıyor.** Ham sorguyu tutmuyoruz; destek vakalarında
   müşterinin kendi tarafındaki logla eşleştirmek gerekecek. Kabul edilen ödün.

## 8. Geçiş (mevcut zincirler bozulmayacak)

`src/audit.ts` bugün `signature` alanına HMAC yazıyor. Plan:
- `signature` alanı **korunur** (geriye dönük uyumluluk, mevcut `audit-chain-check.mjs` çalışmaya devam eder)
- yeni `sig` alanı Ed25519 ile eklenir
- `CONARIUM_AUDIT_HMAC_KEY` yoksa ve Ed25519 anahtarı varsa yalnızca `sig` üretilir
- ikisi de yoksa: **fail-closed** — imzasız makbuz üretmeyi reddet (bugünkü davranış imzayı
  sessizce atlıyor, bu düzeltilecek)
- anahtar üretimi: `conarium keygen` → özel anahtar diskte 0600, açık anahtar + `keyId` yayımlanabilir
- anahtar rotasyonu: `keyId` her makbuzda taşınır, doğrulayıcı birden fazla açık anahtar kabul eder

## 9. Test planı

| Senaryo | Beklenen |
|---|---|
| Ortadaki kaydın bir alanını değiştir | çıkış 10 |
| Ortadaki kaydı sil | çıkış 11 |
| İki kaydın yerini değiştir | çıkış 11 veya 12 |
| `seq` atlat (1041 → 1043) | çıkış 12 |
| Başka anahtarla imzala | çıkış 13 |
| Rotasyon: eski+yeni keyId karışık zincir | çıkış 0 (iki açık anahtar verilirse) |
| Boş zincir / tek kayıt | çıkış 0, uyarı basar |
| `anchor: null` + `--anchor-check` | çıkış 14, eksik olarak raporlanır |
| İmza anahtarı hiç yok | üretim reddedilir (fail-closed), test bunu doğrular |
| Ham PII sızıntı taraması: 121k'lık gerçek koşudan üretilen makbuzlarda ham değer ara | 0 eşleşme |

Son satır zorunlu regresyon: makbuzun kendisi bir sızıntı yüzeyi olamaz.

## 10. Açık sorular (uygulamayı bloklamıyor)

- Çıpa hedefi Rekor mu, kendi Trillian örneğimiz mi? (Rekor ile başla, bağımlılık riski varsa taşı)
- Çıpalama sıklığı: her N makbuz mu, her T dakika mı? (öneri: ikisinin ilki, yapılandırılabilir)
- `consentRef` şeması ISO/IEC TS 27560'ın hangi alanlarını taşıyacak? (v0.2)
