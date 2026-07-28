# Katman 0 Kapanışı — Çıpalama + `/proof/live` (Cursor için)

**Bağlam:** `docs/superpowers/specs/2026-07-29-conarium-receipt-design.md` §6 (çıpalama) — önce oku.
**Uygulayan:** Cursor · **Gate:** Claude · **İki repo:** `conarium-public` (A) ve `nexus` (B)
**Dallar:** A → `feat/anchor-ots` · B → `feat/proof-live`

---

## ⛔ Sınırlar (ihlal = gate reddi)

1. **`git push` YOK.** Commit serbest, push patronun.
2. **`src/governance.ts`'e DOKUNMA.** Bu iş çıpalama + kanıt ucu.
3. **`as any` / tip atlatma YOK.** Testte gerçek assert.
4. **Makbuza/çıpaya ham veri YAZMA.** Çıpaya giden tek şey **hash**'tir: veri değil, alan adı
   değil, tablo adı değil, IP değil.
5. 🔴 **`nexus` reposunda yeni kök/api dosyası eklersen `.vercelignore`'a `!<dosya>` satırı
   EKLE.** Allowlist repo; unutursan commit yeşil görünür ve dosya canlıda 404 döner
   (29 Tem'de tam bunu yedik).
6. Belirsizse **uydurma, sor.**

---

# BÖLÜM A — Çıpalama (`conarium-public`)

## A0 — Karar: OpenTimestamps, Rekor DEĞİL

Araştırıldı, gerekçe kayda geçsin ki sonra tekrar tartışılmasın:

| Aday | Karar |
|---|---|
| **Sigstore Rekor** | ⛔ RED. `hashedrekord` **plain Ed25519'u desteklemiyor** (Ed25519 digest'i kendi içinde hesaplar, orijinal artefakt gerekir); `ed25519ph` sonradan eklendi, bizim imzamız o değil. Alternatif `rekord` tipi **içeriğin kendisini** yüklemek istiyor = yapmayacağımız şey. Ayrıca public instance yazılım tedarik zinciri için. |
| **OpenTimestamps** | ✅ **SEÇİLDİ.** Hash damgalamak için yapılmış. Bedava, kayıt yok, API anahtarı yok, kullanım sınırı yok. İmza şemasından bağımsız. Doğrulaması **hiçbir üçüncü tarafa güven gerektirmiyor** (Bitcoin). Yerleşik standart → "standart olma" hikâyemizle uyumlu: kendi çıpamızı uydurmuyoruz, var olan standarda bağlanıyoruz. |
| RFC3161 TSA | ⏸ ERTELENDİ. Kurumsal alıcı (banka/sigorta) buna daha alışkın ve anında doğrulanıyor, ama TSA'ya güven gerektiriyor. `AnchorSink` pluggable kalsın, ikinci uygulama olarak sonra. Dokümana yaz. |

**Dürüst bedeli (dokümante edilecek):** OTS proof'u ilk anda **`pending`**'dir (yalnız takvim
sunucusu tasdiki); Bitcoin bloğuna girmesi **saatler** sürer ve ondan sonra `bitcoin` olur.
Yani "geriye dönük tarihlenmedi" iddiası anında değil, gecikmeli kesinleşir. Bunu saklamıyoruz.

## A1 — `OpenTimestampsSink`
**Dosya:** `src/anchor.ts` (mevcut `AnchorSink` arayüzünü kullan, arayüzü bozma)

Bağımlılık: `javascript-opentimestamps` (Node'da çalışıyor). API:

```js
const detached = OpenTimestamps.DetachedTimestampFile.fromHash(new OpenTimestamps.Ops.OpSHA256(), hashBuffer)
await OpenTimestamps.stamp(detached)               // varsayılan takvimlere gönderir
const otsBytes = detached.serializeToBytes()       // .ots proof
const changed  = await OpenTimestamps.upgrade(detached)   // pending -> bitcoin
await OpenTimestamps.verify(detachedOts, detached, opts)
```

Varsayılan takvimler: `alice.btc.calendar.opentimestamps.org`, `bob.btc...`,
`finney.calendar.eternitywall.com`.

⚠️ Bizim `chain.hash` string'i `sha256:<hex>` önekli. OTS'e giden **ham 32 byte**'tır —
öneki soy, hex'i Buffer'a çevir. Bu bir tuzak; testi A5'te.

## A2 — Çıpa deposu (makbuzun içine gömme)
**Dosya:** `src/anchor.ts`

`.ots` proof'u makbuzun içine yazmıyoruz — çıpa **zincir başı** başına bir kez üretilir ve
sidecar dosyada durur: `<sink>.anchors.jsonl`, satır başına bir kayıt:

```jsonc
{ "seq": 1042, "hash": "sha256:…", "log": "opentimestamps",
  "ots": "<base64>", "state": "pending", "submittedAt": "…",
  "upgradedAt": null, "bitcoinBlock": null }
```

Makbuzun `anchor` alanı yalnızca **referans** tutar: `{ "log": "opentimestamps", "ref": "sha256:…", "state": "pending" }`.

Bu neden çalışıyor: `anchor` içerik hash'inin **dışında** (bkz. `audit-hash.ts` ve
`receiptHash`), o yüzden imzadan sonra eklenebilir. Saldırgan `anchor`'ı silerse
`--anchor-check` **eksik** olarak raporlar (çıkış 14); forge edemez, çünkü OTS proof'u
hash'e kriptografik olarak bağlı.

## A3 — Zamanlama ve bloklamama
- `CONARIUM_ANCHOR_EVERY_N` (varsayılan **100**) veya `CONARIUM_ANCHOR_EVERY_MS`
  (varsayılan **3600000**) — **hangisi önce dolarsa**.
- `CONARIUM_ANCHOR_SINK=opentimestamps|none` (varsayılan `none` — çıpalama **opt-in**;
  ağ çağrısını kimse istemeden yapmıyoruz).
- **Asenkron ve BLOKLAMAZ:** çıpa başarısız olursa makbuz üretimi devam eder, `anchor: null` kalır.
- **Sessiz değil:** ardışık 3 başarısızlıkta `console.error`. Sayaç tut.
- Zaman aşımı 30sn, tek deneme (kuyruk yok — bir sonraki tetikte yeniden denenir).

## A4 — Upgrade işi (pending → bitcoin)
**Dosya:** `bin/conarium-anchor-upgrade.mjs` (yeni, tek dosya)

```
conarium-anchor-upgrade <anchors.jsonl>
```

`state: "pending"` satırları için `OpenTimestamps.upgrade()` dener; başarılıysa `ots`'u
tazeler, `state: "bitcoin"`, `bitcoinBlock` ve `upgradedAt` yazar. Değişiklik yoksa dosyayı
**dokunmadan** bırakır. Cron'a uygun (günde 1-2 kez yeter).

## A5 — Doğrulayıcıya `--anchor-check`
**Dosya:** `bin/conarium-verify.mjs`

`--anchor-check` verildiğinde:
- `anchor` yoksa → **çıkış 14**, "anchor missing" (mevcut davranış korunur)
- `anchor.ref` ile sidecar'daki kaydı bul; yoksa → çıkış 14
- OTS proof'unu `OpenTimestamps.verify` ile **zincir başı hash'ine karşı** doğrula
- `state: "pending"` ise → **çıkış 0 ama stderr'e uyarı**: "anchor pending (calendar only,
  not yet Bitcoin-attested)". Pending'i başarısızlık saymıyoruz ama sessiz de geçmiyoruz.
- Proof hash'e uymuyorsa → çıkış 14

⚠️ Doğrulayıcı `src/`'tan import ETMEMEYE devam etmeli (bağımsızlığı ürünün kozu).
OTS kütüphanesini import etmesi sorun değil — o dış bir standart, bizim kodumuz değil.

## A6 — Testler
**Dosya:** `src/anchor.test.ts` (mevcut) + `test/anchor-verify.test.mjs` (yeni)

| # | Senaryo | Beklenen |
|---|---|---|
| A6.1 | `sha256:` önekli hash → OTS'e giden buffer **32 byte ve doğru** | eşit |
| A6.2 | Sahte `AnchorSink` fırlatıyor → makbuz üretimi devam ediyor, `anchor: null` | üretim OK |
| A6.3 | 3 ardışık başarısızlık → `console.error` çağrıldı | çağrıldı |
| A6.4 | `EVERY_N=2` → 2 makbuzda bir çıpa tetikleniyor | 2 çağrı / 4 makbuz |
| A6.5 | `anchor` silinmiş + `--anchor-check` | çıkış 14 |
| A6.6 | `state: pending` + `--anchor-check` | çıkış 0 + stderr uyarısı |
| A6.7 | Sidecar'daki `ots` başka bir hash'e ait | çıkış 14 |
| A6.8 | `CONARIUM_ANCHOR_SINK=none` → hiç ağ çağrısı yok | 0 çağrı |

⚠️ **Gerçek takvim sunucusuna testte gitme** (dış servise bağlı test kırılgan). Sahte sink ile
test et. Gerçek OTS entegrasyonu **elle bir kez** doğrulanır ve sonucu (submitted hash +
dönen `.ots` boyutu + sonradan upgrade edilen blok numarası) `docs/RECEIPT-SPEC.md`'ye yazılır.

## A7 — Doküman
- `docs/RECEIPT-SPEC.md`: §Anchoring bölümü — OTS seçimi + **pending/bitcoin iki durumu** +
  Rekor'un neden reddedildiği + RFC3161'in ertelendiği. Known gap #4'e "anchor artık mevcut
  ama pending durumu gecikmeli" notu.
- `README.md`: `--anchor-check` kullanımı. **İddia metnini GENİŞLETME.**
- `CHANGELOG`.

---

# BÖLÜM B — `/proof/live` (`nexus` reposu)

Amaç: bir LLM'in **çekip alıntılayabildiği** canlı kanıt. Kategoride tek doğrulanabilir iddia
biz olacağız — herkes "PII'yi maskeliyoruz" diyor, kimse kontrol edilebilir bir yere koymuyor.

## B1 — Hetzner demo sunucusuna `/proof` route
**Dosya:** Hetzner `conarium-demo` servisi (port 8793)

⚠️ **Bu prod sunucu değişikliği. Kodu yaz, DEPLOY ETME** — Claude gate'ler, patron onaylar.

`GET /proof` → JSON. Gerçek motordan **üç işlem** koşar (sentetik demo şeması, gerçek veri YOK):
1. izinli sorgu → cevap döner
2. maskelenen sorgu → `[MASKED_PII]` döner
3. kapalı tablo → politika ile reddedilir

Dönen gövde:

```jsonc
{
  "generatedAt": "2026-07-29T09:14:02.113Z",
  "engine": { "name": "conarium", "version": "0.1.0" },
  "operations": [
    { "request": "revenue by month", "policy": "allow",  "rowsReturned": 12, "maskedCount": 0 },
    { "request": "customer list",    "policy": "partial","rowsReturned": 5,  "maskedCount": 15,
      "sample": "[MASKED_PII]" },
    { "request": "closed table",     "policy": "deny",   "reason": "not permitted by policy" }
  ],
  "chain": { "seq": 1042, "head": "sha256:…", "entries": 1042 },
  "signature": { "alg": "Ed25519", "keyId": "cnr-demo", "value": "base64…" },
  "publicKey": "-----BEGIN PUBLIC KEY-----…",
  "anchor": { "log": "opentimestamps", "state": "pending", "ref": "sha256:…" },
  "verify": "npx conarium-verify <chain.jsonl> --pubkey <key.pem> --anchor-check",
  "claim": "These records have not been altered, deleted, reordered or backdated after creation. This does NOT prove they were correct at creation time.",
  "limitations": [
    "Synthetic demo data, not real customer data.",
    "actor is a service identity, not a natural person.",
    "Anchor may be 'pending' — Bitcoin attestation takes hours."
  ]
}
```

`claim` ve `limitations` alanları **bilinçli**: bir LLM bu ucu okuyup alıntı yaptığında
sınırları da beraber alsın. Kendi kısıtlarımızı makine-okunur yapmak, atıfın doğru olmasını
sağlar.

- Rate limit: mevcut desene uy (demo ucu 40/dk). Ek olarak **60sn cache** — her istekte
  motoru koşturmayalım.
- Ham veri, tablo adı, iç sistem adı **yok**. (17 Tem'de demoda "ZION mirror (Codes sync)"
  sızıntısı yaşandı; regresyon testi var, bozmayın.)

## B2 — Vercel fonksiyonu + yönlendirme
**Dosyalar:** `api/proof.js` (yeni) · `vercel.json` (rewrite) · **`.vercelignore` (!satırları)**

- `api/proof.js`: `api/chat.js` desenini birebir takip et (origin allowlist, rate limit,
  upstream key, 30sn timeout, **502'yi 200'e yamamak YOK**).
- `vercel.json`: `"rewrites": [{ "source": "/proof/live", "destination": "/api/proof" }]`
- 🔴 `.vercelignore`: `!api/proof.js` **ekle**. Unutursan canlıda 404.
- `Cache-Control: public, max-age=60` — LLM'ler ve tarayıcılar için makul.

## B3 — `llms.txt`'e ekle
`llms.txt` içindeki Links bölümüne: canlı kanıt ucu + tek satır açıklama. Bu, ucun bulunmasının
asıl yolu.

## B4 — Testler
| # | Senaryo | Beklenen |
|---|---|---|
| B4.1 | `/proof/live` 200 + şema geçerli | geçer |
| B4.2 | Gövdede ham PII / tablo adı / iç sistem adı araması | 0 eşleşme |
| B4.3 | Upstream ölü → **502**, 200 değil | 502 |
| B4.4 | `claim` ve `limitations` alanları dolu | dolu |
| B4.5 | İkinci istek cache'ten (60sn içinde `generatedAt` aynı) | aynı |

---

## Sıra ve gate noktaları

```
A1─A2─A3─A4─A5─A6  ══GATE A══▶  A7  ┐
                    (Claude)        ├══GATE B══▶ push (patron onayı) ─▶ Hetzner deploy (patron)
B1─B2─B3─B4        ══════════════════┘  (Claude)
```

**GATE A:** hash öneki doğru soyulmuş mu (A6.1) · çıpa başarısızlığı gerçekten bloklamıyor mu ·
pending sessizce 0 dönmüyor mu · doğrulayıcı `src/`'tan import etmemeye devam ediyor mu ·
testler gerçek takvim sunucusuna gitmiyor mu.

**GATE B:** `/proof` gövdesinde ham veri/iç isim var mı · 502 yamanmış mı · `.vercelignore`'a
`!api/proof.js` eklenmiş mi · `claim` metni genişletilmiş mi.

---

## Kapsam dışı (bilinçli)
RFC3161 sink · kişi bazlı kimlik · rıza bağlama · kapsama/olumsuz kanıt · maruziyet skoru ·
MCP tehdit tespiti · `/proof` için insan-okunur HTML sayfa (JSON yeter, sonra).
