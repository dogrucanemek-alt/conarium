# Makbuz v0.2 — Kişi Bazlı Kimlik (Tasarım)

**Tarih:** 2026-07-31 · **Durum:** onaylandı, uygulama planı bekliyor
**Kapattığı boşluk:** `docs/RECEIPT-SPEC.md` §Known gaps #1 · `2026-07-29-conarium-receipt-design.md` §155

---

## 1. Problem

Makbuzun en kritik alanı "kim erişti" ve o alan bugün yapısal olarak kişi taşıyamıyor.

Kanıt, kodun kendisinden:

| Yer | Ne diyor |
|---|---|
| `src/receipt.ts:229` | `actor.type is always "service" in v0.1 — never emit "user"` |
| `src/receipt.ts:255` | `actor: { type: 'service', id: input.actor.id }` — sabit |
| `bin/conarium-verify.mjs:282` | `actor.type must be "service" in v0.1` — aksi hâlde **çıkış 20** |
| `src/http.ts:29` | `tokenOk(supplied)` — **tek** paylaşılan token, kurulumun tamamı tek kimlik |

Sonucu kendi belgelerimizde kabul ediyoruz: on kişilik ekipte on erişim tek isimle düşüyor,
ve `compare.html` bunu "en büyük tek açığımız" diye yazıyor. Ölçtük: rakip hoop.dev'de bu
kapalı — oturum kayıtları "user identity with organizational context" taşıyor.

**En önemli kısıt:** doğrulayıcı v0.1'de "service" dışını reddettiği için, bugün "user"
yazmak üretilen her makbuzu doğrulanamaz hâle getirir. Bu bir alan değişikliği değil,
**sürüm işidir.**

## 2. Reddedilen yol: istemci beyanı

İstemcinin `X-Conarium-Actor: ayse@sirket.com` göndermesi en ucuz çözümdü ve **kasten
reddedildi.** Hiç kimsenin doğrulamadığı bir ismi imzalayıp makbuza yazmak, bugünkü
dürüst `'service'` değerinden **daha kötüdür**: kanıt görünümlü bir iddia üretir.
Ürünün tamamı "dışarıdan doğrulanabilir artefakt" iddiası üzerine kurulu; o iddiayı
ilk kıran şey biz olamayız.

## 3. Karar: kişi başına token

Tek paylaşılan token'ın yanına kişi başına token gelir. Conarium token'ı zaten
doğruluyor, dolayısıyla kimin bağlandığını **bilir** — beyan değil, kanıt.

Neden bu, OIDC yerine (şimdilik):
- Dış bağımlılık yok; self-hosted kurulumda ilk günden çalışır.
- IdP'si olmayan küçük müşteri de kullanabilir.
- "On kişi tek isim" şikâyetini bugün kapatır.
- OIDC sonradan **şema kırılmadan** takılır (bkz §4 `assurance`).

Dürüst zayıflığı: denetçi, token dağıtımının düzgün yapıldığına güvenmek zorundadır.
Bu, makbuza yazılır (`assurance`), gizlenmez.

## 4. Makbuz v0.2

### 4.1 Sürüm artışı
`v0.1 → v0.2`. **v0.1 makbuzları sonsuza kadar doğrulanabilir kalır** — kendi geçmişini
bozan bir kanıt sistemi kanıt sistemi değildir.

### 4.2 `actor` alanı
```ts
export type ActorType = 'service' | 'user'
export type ActorAssurance = 'shared-token' | 'per-user-token'   // ileride: 'oidc'

export interface ReceiptActor {
  type: ActorType
  id: string
  assurance: ActorAssurance      // v0.2'de ZORUNLU
}
```

`assurance` alanının amacı: makbuz sadece **kimi** değil, **kimliğin nasıl kurulduğunu**
da taşısın. Denetçi `per-user-token` ile ileride gelecek `oidc`'yi aynı kefeye koymasın.
Bu alan sayesinde abartma yapısal olarak imkânsız hâle gelir.

### 4.3 Zorlanan kural
`type: 'user'` **yalnızca** kişiye özel bir token eşleştiğinde yazılır. Paylaşılan
token'la gelen istek `{ type: 'service', assurance: 'shared-token' }` kalır. Tahmin,
çıkarım, "muhtemelen şu kişidir" yok.

## 5. Token deposu

Varsayılan dosya `conarium.tokens.json`; yol `CONARIUM_TOKENS_FILE` ile değiştirilebilir.
Dosya yoksa kişi bazlı kimlik **kapalıdır** (bkz §6) — hata değil, varsayılan durum.

```json
{
  "tokens": [
    { "sha256": "<token'ın SHA-256 karması>", "id": "ayse@sirket.com", "label": "Ayşe" }
  ]
}
```

- **Token düz metin SAKLANMAZ**, yalnızca SHA-256 karması. Dosya sızsa bile kimsenin
  token'ı ele geçmez.
- Gelen token karmalanır ve haritada tek adımda aranır → hangi token'ın eşleştiğini
  sızdıran zamanlama kanalı oluşmaz.
- Eşleşme yoksa istek bugünkü gibi reddedilir (401). Bilinmeyen token kimlik üretmez.
- `id` serbest metin değil, kurulum sahibinin verdiği kararlı bir tanımlayıcıdır
  (e-posta önerilir). Conarium bunu doğrulamaz, sadece kaydeder — `assurance` bu yüzden var.

## 6. Geriye uyum

Token dosyası **yoksa** hiçbir şey değişmez: v0.1 makbuz, `'service'` aktör, mevcut
kurulumlar aynen çalışır. Kimsenin iddiası haberi olmadan güçlenmez. Sessiz yükseltme
bu üründe yapılabilecek en tehlikeli şeydir.

Token dosyası **varsa** kurulum v0.2 makbuz üretir; paylaşılan token'la gelenler yine
`service`/`shared-token` olur.

## 7. Doğrulayıcı

`conarium-verify` iki sürümü de bilir:

| Sürüm | Kural |
|---|---|
| v0.1 | `actor.type` **"service" olmak zorunda** (bugünkü davranış, değişmedi) |
| v0.2 | `actor.type` "service" veya "user"; `assurance` **zorunlu**; `type: 'user'` ise `assurance` **`shared-token` olamaz** |

Şema ihlali mevcut **çıkış kodu 20**'yi kullanır; yeni çıkış kodu eklenmez. Böylece
elle "user" yazıp kanıt üretmeye çalışan bir makbuz şemadan düşer.

## 8. Testler

1. v0.1 fixture'ları hâlâ geçiyor (regresyon — en kritik test).
2. v0.2 + `user` + `per-user-token` → geçer.
3. v0.2 + `user` + `shared-token` → **çıkış 20**.
4. v0.2 + `assurance` eksik → **çıkış 20**.
5. Paylaşılan token ile üretilen makbuz **asla** `type: 'user'` içermez.
6. Bilinmeyen token → 401, makbuz üretilmez.
7. Token dosyasında düz metin token bulunmaz (yalnızca karma).
8. Token dosyası yokken davranış v0.1 ile birebir aynı.

## 9. Kapsam dışı (bilerek)

OIDC/JWKS doğrulaması · rol bazlı erişim (RBAC) · çok kiracılılık · token yönetim arayüzü.
Şema OIDC'yi sonradan alacak şekilde kuruldu; gerisi bu işin parçası değil.

## 10. Bunu takip eden iş

Kod gönderildikten **sonra** — önce değil:
- `docs/RECEIPT-SPEC.md` boşluk #1 güncellenir.
- `compare.html`'de "Per-user identity: No" satırı düzeltilir.
- `llms.txt`'teki "audit log records the connecting *service*, not the individual end
  user" sınırlaması güncellenir.

Bu sıra önemli: iddia koddan sonra gelir, önce değil.
