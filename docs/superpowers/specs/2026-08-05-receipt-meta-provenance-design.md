# Receipt v0.3 — meta provenance (model/client kaynağı)

**Tarih:** 2026-08-05
**Durum:** onaylandı (patron), uygulanacak
**Bağlam:** makbuz üretimi canlıda kapalı; engel teknik değil dürüstlük.

## Problem

`Audit` fail-closed davranıyor: `receiptSink` yapılandırıldığında `receiptMeta`
(model **ve** client) zorunlu, yoksa boot'ta hata veriyor (`audit.ts:190`). Gerekçe
doğru ve kayıtlı: uydurma varsayılan, makbuzdaki model alanını (AB AI Yasası Md.19
*"model identification"*) yalancı yapar.

Ama iki alan aynı sınıfta değil:

| alan | gerçekte ölçülebilir mi |
|---|---|
| `client` | **evet** — MCP `initialize` isteği `clientInfo` taşır; SDK'da `Server.getClientVersion(): Implementation \| undefined` mevcut |
| `model` | **hayır** — MCP protokolünde model kimliği diye bir alan yok. Bağlanan istemci (claude.ai, Cursor…) hangi modeli kullandığını sunucuya bildirmez |

Sonuç: makbuzu açmak için `model`'i config'e sabit yazmak gerekiyor, bu da Conarium'un
ölçmediği bir şeyi ölçmüş gibi imzalaması demek. Bu yüzden makbuz kapalı kaldı ve
"her erişim için imzalı makbuz" vaadi canlı akışta karşılıksız.

## Karar

**Alanı taşımayı bırakıp, alanın KAYNAĞINI da taşı.**

Makbuz `model` ve `client` alanlarına `source` ekler. Değerin nereden geldiği makbuzun
kendisinde, imzanın içinde durur:

| kaynak | anlamı |
|---|---|
| `protocol` | bağlantı sırasında ölçüldü (MCP `initialize` → `clientInfo`) |
| `operator-declared` | operatör config'te beyan etti; **Conarium doğrulamadı** |
| `undeclared` | bildirilmedi — alanlar `null`, uydurulmadı |

Bu, makbuzun zaten kurduğu desenin devamı: `ReceiptActor.assurance` da "kim" sorusunu
değil *"kimliği NASIL biliyoruz"* sorusunu cevaplıyor (`receipt.ts:19`). Aynı disiplin
model/client'a uygulanıyor.

⛔ **En kritik kural — ürünün konumuyla birebir aynı:** makbuz *"model şuydu"* demez;
*"model şu olarak beyan edildi"* ya da *"model bildirilmedi"* der. Kaydın yokluğu
belirsizdir ve belirsizlik gizlenmez. (Kapsama kanıtındaki *"erişim OLMADI"* → *"erişim
KAYDEDİLMEDİ"* ayrımının aynısı.)

## Şema (v0.3)

```ts
export type MetaSource = 'protocol' | 'operator-declared' | 'undeclared'

export interface ReceiptModel {
  source: MetaSource        // pratikte 'operator-declared' | 'undeclared'
  provider: string | null
  name: string | null
  version: string | null
}

export interface ReceiptClient {
  source: MetaSource        // pratikte 'protocol' | 'operator-declared' | 'undeclared'
  name: string | null
  version: string | null
}
```

`RECEIPT_VERSION` → `conarium-receipt/0.3`.

**Değişmezler:**
- `source` **her zaman** var. `undeclared` iken üç alan da `null`.
- `source: 'undeclared'` geçerli bir makbuzdur, eksik/bozuk değildir.
- Alanlar hash'in içinde → `source`'u sonradan değiştirmek zinciri bozar.

## Davranış

**`Audit` (fail-closed gevşetilir, ama sadece model için):**
- `receiptSink` varken `receiptClient` **hâlâ zorunlu değil** — çünkü artık protokolden
  gelebiliyor; hiç gelmezse `undeclared` yazılır.
- `receiptModel` **opsiyonel** olur. Yazılmazsa `source: 'undeclared'`.
- Böylece `receiptSink` tek başına yeterli → **makbuz açılabilir hale gelir.**
- ⚠️ Ed25519 anahtar zorunluluğu **korunur** (`audit.ts:180`). İmzasız makbuz makbuz değil.

**`server.ts` / MCP:** oturum açılışında `Server.getClientVersion()` okunur; değer varsa
`{source:'protocol', name, version}`, yoksa config'teki `receiptClient`
(`operator-declared`), o da yoksa `undeclared`.

**Doğrulayıcı (`bin/conarium-verify.mjs`):**
- v0.1 / v0.2 makbuzları **aynen doğrulanmaya devam eder** (geriye uyum, regresyon testiyle korunur).
- v0.3'te `source` alanı zorunlu; bilinmeyen değer → şema hatası.
- `undeclared` **başarısızlık değildir**. Çıktıda sayılır: `3 receipt(s) verified (1 with undeclared model)`.
  Sessizce geçmez, hata da saymaz.

## Neden bu, alternatifler değil

- **Config'e sabit model yaz (elendi):** en hızlısı, ama makbuz ölçmediğini iddia eder.
  Ürünün tek savunulabilir konumu bu — çürütürsek geriye rakiplerden farkı olmayan bir
  gateway kalır.
- **Protokol uzantısıyla istemciden model iste (ertelendi):** MCP'de standart yok;
  claude.ai bugün göndermez → ölü doğar. `source: 'protocol'` alanı bu yolu ileride
  şema değişikliği olmadan açık bırakıyor.

## Test kapsamı

1. v0.1 ve v0.2 makbuzları hâlâ doğrulanıyor (geriye uyum kilidi)
2. `receiptModel` yazılmadan `receiptSink` ile boot → hata YOK, makbuz üretiliyor
3. Üretilen makbuzda `model.source === 'undeclared'` ve üç alan `null`
4. `receiptModel` yazılınca `source === 'operator-declared'` ve değerler taşınıyor
5. MCP `clientInfo` varken `client.source === 'protocol'`, değerler istemciden geliyor
6. `source` kurcalanınca zincir hash'i tutmuyor (alan imzanın içinde)
7. Doğrulayıcı `undeclared` makbuzu **exit 0** ile geçiriyor ve sayıyor
8. Ed25519 anahtarı yokken `receiptSink` → hâlâ fail-closed (gevşetilmedi)

## Kapsam dışı

- Kapsama kanıtı (`coverage.ts`) — `source` alanını okumuyor, dokunulmuyor
- `consentRef` — hâlâ `null`, rıza bağlama ayrı iş (avukat bekliyor)
- Hetzner deploy — ayrı onay
