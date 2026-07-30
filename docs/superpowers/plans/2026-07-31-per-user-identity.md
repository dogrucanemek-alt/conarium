# Kişi Bazlı Kimlik — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conarium'un denetim kaydı ve makbuzu, erişimi yapan **kişiyi** adıyla kaydetsin — kimliği doğrulanmış bir kaynaktan alarak, ve bu kimliğin nasıl kurulduğunu artefaktın içinde beyan ederek.

**Architecture:** Ortak bir token deposu (`src/tokens.ts`) gelen token'ı karmalayıp kişiye çözer. Bu kimlik iki yüzeye akar: canlı denetim kaydı (`src/audit.ts`) ve makbuz (`src/receipt.ts`, v0.2). Doğrulayıcı iki makbuz sürümünü de kabul eder. Token dosyası yoksa hiçbir davranış değişmez.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Node `crypto` (sha256, timingSafeEqual). Yeni bağımlılık **yok**.

## Global Constraints

- Tasarım kaynağı: `docs/superpowers/specs/2026-07-31-per-user-identity-design.md`. Çelişki olursa spec kazanır.
- Kod stili: **noktalı virgül yok**, tek tırnak, 2 boşluk girinti — mevcut `src/*.ts` ile aynı.
- `type: 'user'` **yalnızca** kişiye özel token eşleştiğinde yazılır. Tahmin/çıkarım yasak.
- Token dosyası **düz metin token içermez**, yalnızca SHA-256 karması.
- Token dosyası yoksa davranış bugünküyle **birebir** aynı olmalı (v0.1 makbuz, `service` aktör).
- `RECEIPT_VERSION` iki yerde tanımlı: `src/receipt.ts:8` ve `bin/conarium-verify.mjs:28`. İkisi birlikte güncellenir.
- v0.1 makbuzları **sonsuza kadar** doğrulanabilir kalır. Bu bir regresyon testiyle korunur.
- Her görev sonunda `npm test` tamamen yeşil olmalı (bugün 92/92).
- İddia güncellemesi (`compare.html`, `llms.txt`, `RECEIPT-SPEC`) bu planın **dışındadır** ve kod gönderildikten **sonra** yapılır.

---

### Task 1: Token deposu

Kimliğin tek kaynağı. Diğer iki görev buna dayanır.

**Files:**
- Create: `src/tokens.ts`
- Test: `src/tokens.test.ts`

**Interfaces:**
- Consumes: yok (temel taş).
- Produces:
  - `export type ActorAssurance = 'shared-token' | 'per-user-token'`
  - `export interface ResolvedActor { id: string; assurance: ActorAssurance; isUser: boolean }`
  - `export function loadTokenStore(path?: string): Map<string, string> | null` — karma → kişi id haritası; dosya yoksa `null`
  - `export function resolveActor(supplied: string, store: Map<string, string> | null, fallbackId: string): ResolvedActor`

- [x] **Step 1: Testi yaz (kırmızı)**

`src/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTokenStore, resolveActor } from './tokens.js'

function tokenFile(entries: { token: string; id: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-tok-'))
  const p = join(dir, 'conarium.tokens.json')
  writeFileSync(p, JSON.stringify({
    tokens: entries.map(e => ({
      sha256: createHash('sha256').update(e.token).digest('hex'),
      id: e.id,
    })),
  }))
  return p
}

describe('token deposu', () => {
  it('dosya yoksa null döner — kişi bazlı kimlik kapalıdır, hata değil', () => {
    expect(loadTokenStore(join(tmpdir(), 'cnr-yok-' + Date.now() + '.json'))).toBeNull()
  })

  it('eşleşen token kişiyi çözer ve per-user-token olarak işaretler', () => {
    const store = loadTokenStore(tokenFile([{ token: 'tok-ayse', id: 'ayse@sirket.com' }]))
    const a = resolveActor('tok-ayse', store, 'conarium_c2')
    expect(a).toEqual({ id: 'ayse@sirket.com', assurance: 'per-user-token', isUser: true })
  })

  it('depo yokken paylaşılan token servis kimliğine düşer', () => {
    const a = resolveActor('paylasilan', null, 'conarium_c2')
    expect(a).toEqual({ id: 'conarium_c2', assurance: 'shared-token', isUser: false })
  })

  it('depo VARKEN eşleşmeyen token kişi kimliği ÜRETMEZ', () => {
    const store = loadTokenStore(tokenFile([{ token: 'tok-ayse', id: 'ayse@sirket.com' }]))
    const a = resolveActor('baska-token', store, 'conarium_c2')
    expect(a.isUser).toBe(false)
    expect(a.assurance).toBe('shared-token')
  })

  it('depo dosyasında düz metin token bulunmaz', () => {
    const p = tokenFile([{ token: 'gizli-token-123', id: 'ayse@sirket.com' }])
    const ham = readFileSync(p, 'utf8')
    expect(ham).not.toContain('gizli-token-123')
  })
})
```

`readFileSync`'i import listesine ekle: `import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'`.

- [x] **Step 2: Kırmızıyı doğrula**

Çalıştır: `npx vitest run src/tokens.test.ts`
Beklenen: FAIL — `Cannot find module './tokens.js'`

- [x] **Step 3: Asgari uygulamayı yaz**

`src/tokens.ts`:

```ts
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

const DEFAULT_PATH = process.env.CONARIUM_TOKENS_FILE || 'conarium.tokens.json'

/** karma → kişi id. Dosya yoksa null = kişi bazlı kimlik kapalı (hata değil). */
export function loadTokenStore(path: string = DEFAULT_PATH): Map<string, string> | null {
  if (!existsSync(path)) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { tokens?: { sha256?: string; id?: string }[] }
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
```

- [x] **Step 4: Yeşili doğrula**

Çalıştır: `npx vitest run src/tokens.test.ts`
Beklenen: PASS (5 test)

- [x] **Step 5: Tüm takım hâlâ yeşil mi**

Çalıştır: `npm test`
Beklenen: 97 passed (92 mevcut + 5 yeni)

- [x] **Step 6: Commit**

```bash
git add src/tokens.ts src/tokens.test.ts
git commit -m "feat(identity): kisi basina token deposu

Token'lar duz metin degil SHA-256 karmasi olarak saklanir; dosya sizsa bile
token ele gecmez. Eslesme yoksa ASLA kisi kimligi uretilmez, paylasilan token
davranisina duser. Dosya yoksa kisi bazli kimlik kapalidir (hata degil)."
```

---

### Task 2: Denetim kaydında kişi kimliği

Canlı etkisi olan parça. Halka açık olarak kabul ettiğimiz açık (*"records the service, not the person"*) burada kapanır.

**Files:**
- Modify: `src/audit.ts` (`AuditEntry` arayüzü ~satır 14, `log()` ~satır 145)
- Modify: `src/http.ts` (token doğrulama ~satır 82-90)
- Test: `src/audit.actor.test.ts` (yeni)

**Interfaces:**
- Consumes: Task 1'den `resolveActor`, `loadTokenStore`, `ActorAssurance`.
- Produces: `AuditEntry` artık isteğe bağlı `actor` girdisi ve `actorAssurance` alanı taşır.

- [ ] **Step 1: Testi yaz (kırmızı)**

`src/audit.actor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Audit } from './audit.js'

describe('denetim kaydı aktörü', () => {
  it('aktör verilmezse consumer kullanılır (bugünkü davranış)', () => {
    const a = new Audit({ consumer: 'conarium_c2' })
    const e = a.log({ tool: 'query', denied: false })
    expect(e.actor).toBe('conarium_c2')
    expect(e.actorAssurance).toBe('shared-token')
  })

  it('aktör verilirse kişi adı yazılır ve güvence beyan edilir', () => {
    const a = new Audit({ consumer: 'conarium_c2' })
    const e = a.log({ tool: 'query', denied: false, actor: 'ayse@sirket.com', actorAssurance: 'per-user-token' })
    expect(e.actor).toBe('ayse@sirket.com')
    expect(e.actorAssurance).toBe('per-user-token')
  })

  it('aktör alanı hash zincirine dahildir — sonradan değiştirilemez', () => {
    const a1 = new Audit({ consumer: 'c' })
    const h1 = a1.log({ tool: 'query', denied: false, actor: 'ayse@x.com', actorAssurance: 'per-user-token' }).hash
    const a2 = new Audit({ consumer: 'c' })
    const h2 = a2.log({ tool: 'query', denied: false, actor: 'mehmet@x.com', actorAssurance: 'per-user-token' }).hash
    expect(h1).not.toBe(h2)
  })
})
```

Not: `Audit` sınıfı imzalama gerektiriyorsa test başında `process.env.CONARIUM_AUDIT_UNSIGNED = '1'` kur ve sonunda temizle — `src/audit.chain.test.ts` bu deseni kullanıyor, ona bak.

- [ ] **Step 2: Kırmızıyı doğrula**

Çalıştır: `npx vitest run src/audit.actor.test.ts`
Beklenen: FAIL — `actorAssurance` yok, `log()` `actor` kabul etmiyor

- [ ] **Step 3: `AuditEntry`'ye alanı ekle**

`src/audit.ts`, `AuditEntry` arayüzünde `actor: string` satırının hemen altına:

```ts
  /** Kimliğin nasıl kurulduğu. Artefakt kimi değil, NASIL bilindiğini de taşır. */
  actorAssurance?: ActorAssurance
```

Dosyanın import bloğuna ekle:

```ts
import type { ActorAssurance } from './tokens.js'
```

- [ ] **Step 4: `log()` imzasını genişlet**

`src/audit.ts`, `log()` metodu — `actor`'ı Omit listesinden çıkar ve isteğe bağlı yap:

`actor`'ı Omit listesinde **bırak** (yoksa zorunlu kalır ve `& { actor?: }` ile çelişir, derlenmez), sonra isteğe bağlı olarak geri ekle:

```ts
  log(
    entry: Omit<AuditEntry, 'timestamp' | 'actor' | 'prevHash' | 'hash'> & {
      actor?: string
      actorAssurance?: ActorAssurance
    },
  ): AuditEntry {
    this.requireSigningCapability()

    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
      // Aktör verilmediyse eski davranış: örnek başına sabit consumer.
      actor: entry.actor ?? this.consumer,
      actorAssurance: entry.actorAssurance ?? 'shared-token',
    }
```

- [ ] **Step 5: Yeşili doğrula**

Çalıştır: `npx vitest run src/audit.actor.test.ts`
Beklenen: PASS (3 test)

- [ ] **Step 6: HTTP katmanında kimliği çöz**

`src/http.ts` — import ekle:

```ts
import { loadTokenStore, resolveActor } from './tokens.js'
```

`TOKEN` sabitinin yanına:

```ts
// Bir kez yüklenir; dosya yoksa null = kişi bazlı kimlik kapalı.
const TOKEN_STORE = loadTokenStore()
```

`tokenOk(supplied)` kontrolünü genişlet: paylaşılan token VEYA depoda eşleşen bir token kabul edilir.

```ts
      const kisi = resolveActor(supplied, TOKEN_STORE, deps.config.consumer)
      if (!kisi.isUser && !tokenOk(supplied)) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
        return
      }
```

Consumer değeri `deps.config.consumer` — `src/server.ts:51` `new Audit({ ..., consumer: config.consumer })` ile aynı kaynak. Yeni kavram uydurma.

- [ ] **Step 7: Kimliği oturum sunucusuna geçir**

Mimari kanca hazır: `src/http.ts:127` her oturum için ayrı `Server` kuruyor (`buildServer(deps)`), governance/audit ise ortak. Bir oturum tek token'la açıldığı için **kimlik oturuma sabittir** — global değişken kullanma, eşzamanlı oturumlarda kimlikler karışır.

`src/server.ts:73` imzasını genişlet:

```ts
export function buildServer(
  { config, governance, audit, connectors }: ConariumDeps,
  aktor?: ResolvedActor,
): Server {
```

Import ekle: `import type { ResolvedActor } from './tokens.js'`

`buildServer` gövdesinin en başına tek bir yardımcı koy — `audit.log` çağrıları 8+ yerde, hepsine tek tek alan eklemek DRY değil ve biri unutulur:

```ts
  // Oturumun kimliğini her denetim satırına tek yerden geçir.
  // aktor yoksa hiçbir alan eklenmez → log() eski davranışına düşer (consumer).
  const kaydet: typeof audit.log = (e) =>
    audit.log(aktor ? { ...e, actor: aktor.id, actorAssurance: aktor.assurance } : e)
```

Sonra bu dosyadaki **tüm** `audit.log(` çağrılarını `kaydet(` ile değiştir (satır 171, 190, 194, 215, 223, 245 ve varsa diğerleri):

```bash
grep -n "audit\.log(" src/server.ts    # once say, sonra degistir, sonra tekrar say = 0 olmali
```

`src/http.ts:127`'de oturumun kimliğini geçir:

```ts
      const server = buildServer(deps, kisi)
```

`src/index.ts:12` (stdio modu) **değişmez** — aktör verilmez, `service` kalır. Stdio'da kişi kavramı yok.

- [ ] **Step 8: Tüm takım yeşil**

Çalıştır: `npm test`
Beklenen: 100 passed

- [ ] **Step 9: Commit**

```bash
git add src/audit.ts src/http.ts src/audit.actor.test.ts
git commit -m "feat(identity): denetim kaydi kisiyi adiyla yazsin

compare.html ve llms.txt'te acikca kabul ettigimiz acik buydu: denetim kaydi
baglanan SERVISI yaziyordu, kisiyi degil. Kisi basina token eslestiginde artik
kisi id'si yazilir ve actorAssurance ile kimligin NASIL kuruldugu beyan edilir.
Token dosyasi yoksa davranis birebir ayni kalir."
```

---

### Task 3: Makbuz v0.2 + doğrulayıcı

Artefaktın kendisi. **En kritik testi ilk sırada:** eski v0.1 makbuzları hâlâ doğrulanmalı.

**Files:**
- Modify: `src/receipt.ts` (satır 8 sürüm, `ReceiptActor` ~satır 14, `buildReceipt` ~satır 255)
- Modify: `bin/conarium-verify.mjs` (satır 28 sürüm, `schemaOk` ~satır 267)
- Test: `src/receipt.actor.test.ts` (yeni)

**Interfaces:**
- Consumes: Task 1'den `ActorAssurance`.
- Produces: `RECEIPT_VERSION = 'conarium-receipt/0.2'`; `ReceiptActor` artık `assurance` taşır; `ReceiptInput.actor` artık `{ id: string; type?: ActorType; assurance?: ActorAssurance }`.

- [ ] **Step 1: Testi yaz (kırmızı)**

`src/receipt.actor.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildReceipt, nextChainState, RECEIPT_VERSION, type ReceiptInput } from './receipt.js'

// sampleInput'u src/receipt.leak.test.ts'ten kopyala — orada hazır bir kurucu var.

describe('makbuz v0.2 aktörü', () => {
  it('sürüm 0.2', () => {
    expect(RECEIPT_VERSION).toBe('conarium-receipt/0.2')
  })

  it('aktör türü verilmezse service kalır ve shared-token beyan edilir', () => {
    const r = buildReceipt(sampleInput(), nextChainState(null), null)
    expect(r.actor.type).toBe('service')
    expect(r.actor.assurance).toBe('shared-token')
  })

  it('kişi token eşleştiyse user + per-user-token yazılır', () => {
    const inp = sampleInput()
    inp.actor = { id: 'ayse@sirket.com', type: 'user', assurance: 'per-user-token' }
    const r = buildReceipt(inp, nextChainState(null), null)
    expect(r.actor).toEqual({ type: 'user', id: 'ayse@sirket.com', assurance: 'per-user-token' })
  })

  it('user + shared-token kombinasyonu REDDEDILIR — kanıtsız kişi iddiası olamaz', () => {
    const inp = sampleInput()
    inp.actor = { id: 'ayse@sirket.com', type: 'user', assurance: 'shared-token' }
    expect(() => buildReceipt(inp, nextChainState(null), null)).toThrow(/shared-token/)
  })
})
```

Test imzasız makbuz üretiyorsa `process.env.CONARIUM_AUDIT_UNSIGNED = '1'` kur; `src/receipt.leak.test.ts` bu deseni kullanıyor.

- [ ] **Step 2: Kırmızıyı doğrula**

Çalıştır: `npx vitest run src/receipt.actor.test.ts`
Beklenen: FAIL — sürüm 0.1, `assurance` yok

- [ ] **Step 3: Şemayı ve sürümü güncelle**

`src/receipt.ts`:

```ts
export const RECEIPT_VERSION = 'conarium-receipt/0.2' as const
```

`ReceiptActor`:

```ts
export interface ReceiptActor {
  type: ActorType
  id: string
  /** Kimliğin nasıl kurulduğu — makbuz kimi değil, NASIL bilindiğini de taşır. */
  assurance: ActorAssurance
}
```

`ReceiptInput.actor` (satır ~105):

```ts
  actor: { id: string; type?: ActorType; assurance?: ActorAssurance }
```

`src/tokens.js`'ten tipi import et:

```ts
import type { ActorAssurance } from './tokens.js'
```

- [ ] **Step 4: `buildReceipt`'i güncelle**

Satır ~255'teki sabit satırı değiştir:

```ts
    actor: buildActor(input.actor),
```

Ve dosyaya yardımcıyı ekle (`buildReceipt`'in hemen üstüne):

```ts
/**
 * Kanıtsız kişi iddiasını YAPISAL olarak imkânsız kılar: 'user' yalnızca
 * doğrulanmış bir güvenceyle yazılabilir. Bu kural yorum değil, kod olmalı —
 * yorum bir sonraki değişiklikte unutulur.
 */
function buildActor(a: { id: string; type?: ActorType; assurance?: ActorAssurance }): ReceiptActor {
  const assurance: ActorAssurance = a.assurance ?? 'shared-token'
  const type: ActorType = a.type ?? 'service'
  if (type === 'user' && assurance === 'shared-token') {
    throw new Error(
      'buildReceipt: actor.type "user" cannot be claimed with assurance "shared-token" — ' +
        'a person may only be named when a per-user credential was verified',
    )
  }
  return { type, id: a.id, assurance }
}
```

Ayrıca satır ~229'daki artık yanlış olan yorumu güncelle: `actor.type is always "service" in v0.1` → v0.2 kuralını anlat.

- [ ] **Step 5: Yeşili doğrula**

Çalıştır: `npx vitest run src/receipt.actor.test.ts`
Beklenen: PASS (4 test)

- [ ] **Step 6: Doğrulayıcıyı iki sürüme aç**

`bin/conarium-verify.mjs` satır 28:

```js
const RECEIPT_V1 = 'conarium-receipt/0.1'
const RECEIPT_V2 = 'conarium-receipt/0.2'
```

`RECEIPT_VERSION` kullanan yerleri bu ikisine göre düzelt. `schemaOk` içindeki sürüm ve aktör kontrollerini değiştir:

```js
  if (r.v !== RECEIPT_V1 && r.v !== RECEIPT_V2) return `unsupported version ${r.v}`
  ...
  // v0.1: aktör "service" olmak zorunda (degismedi — eski makbuzlar aynen dogrulanir)
  if (r.v === RECEIPT_V1) {
    if (!r.actor || r.actor.type !== 'service') return 'actor.type must be "service" in v0.1'
  } else {
    if (!r.actor || (r.actor.type !== 'service' && r.actor.type !== 'user')) {
      return 'actor.type must be "service" or "user" in v0.2'
    }
    if (typeof r.actor.assurance !== 'string' || !r.actor.assurance) {
      return 'actor.assurance is required in v0.2'
    }
    if (r.actor.type === 'user' && r.actor.assurance === 'shared-token') {
      return 'actor.type "user" cannot carry assurance "shared-token"'
    }
  }
```

- [ ] **Step 7: Doğrulayıcı regresyonunu koş — EN KRİTİK ADIM**

Çalıştır: `npm test`
Beklenen: mevcut OTS fixture testleri (`test/fixtures/ots/`) **hâlâ geçiyor**. Bunlar v0.1 makbuzları; kırılırsa kendi geçmişimizi bozmuşuz demektir ve devam edilmez.

Ayrıca elle:

```bash
node bin/conarium-verify.mjs test/fixtures/ots/receipts.jsonl --pubkey test/fixtures/ots/pubkey.pem; echo "cikis: $?"
```
Beklenen: çıkış 0 (fixture adları farklıysa `test/fixtures/ots/` içeriğine bak).

- [ ] **Step 8: Commit**

```bash
git add src/receipt.ts bin/conarium-verify.mjs src/receipt.actor.test.ts
git commit -m "feat(receipt): v0.2 — makbuz kisiyi adiyla tasiyabilsin

Dogrulayici v0.1'de actor.type'in \"service\" olmasini sart kosuyordu, yani
\"user\" yazmak uretilen her makbuzu dogrulanamaz yapardi. Bu yuzden surum
artisi: v0.1 makbuzlari AYNEN dogrulanmaya devam eder (regresyon testiyle
korunuyor).

actor'a assurance eklendi: makbuz kimi degil, kimligin NASIL kuruldugunu da
tasir. 'user' + 'shared-token' kombinasyonu hem uretimde hem dogrulamada
reddedilir — kanitsiz kisi iddiasi yapisal olarak imkansiz."
```

---

### Task 4: Doğrulayıcı şema testleri + geriye uyum paritesi

Spec §8'in doğrulayıcı tarafı ve "hiçbir şey değişmedi" garantisi. Task 3 makbuzu **üretme** tarafında test etti; burası **doğrulama** tarafı. İkisi ayrı kod (`src/receipt.ts` ↔ `bin/conarium-verify.mjs`) ve ayrı kırılırlar.

**Files:**
- Test: `test/verify_actor.test.mjs` (yeni — `test/` altında, mevcut `test/spec_exitcode_drift.mjs` komşusu)

**Interfaces:**
- Consumes: Task 3'ten `RECEIPT_V2` şeması ve `bin/conarium-verify.mjs` çıkış kodları.
- Produces: yok (yalnız test).

- [ ] **Step 1: Doğrulayıcı şema testlerini yaz**

`test/verify_actor.test.mjs` — doğrulayıcıyı alt süreç olarak koşturup **çıkış kodunu** ölçer (kütüphaneyi değil, gerçek CLI'yi test eder):

```js
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** conarium-verify'i kos, cikis kodunu don. */
function verify(receipts) {
  const dir = mkdtempSync(join(tmpdir(), 'cnr-ver-'))
  const f = join(dir, 'receipts.jsonl')
  writeFileSync(f, receipts.map(r => JSON.stringify(r)).join('\n') + '\n')
  try {
    execFileSync(process.execPath, ['bin/conarium-verify.mjs', f], { stdio: 'pipe' })
    return 0
  } catch (e) {
    return e.status
  }
}

// Task 3'un urettigi gecerli bir v0.2 makbuzunu temel al; alanlari bozarak test et.
// Temel makbuzu uretmek icin src/receipt.ts'ten buildReceipt kullan (bkz receipt.actor.test.ts).

describe('dogrulayici aktor semasi', () => {
  it('v0.2 + user + per-user-token → kabul', () => {
    expect(verify([v2Receipt({ type: 'user', id: 'ayse@x.com', assurance: 'per-user-token' })])).toBe(0)
  })

  it('v0.2 + user + shared-token → sema hatasi (20)', () => {
    expect(verify([v2Receipt({ type: 'user', id: 'ayse@x.com', assurance: 'shared-token' })])).toBe(20)
  })

  it('v0.2 + assurance eksik → sema hatasi (20)', () => {
    expect(verify([v2Receipt({ type: 'service', id: 'conarium_c2' })])).toBe(20)
  })
})
```

`v2Receipt(actor)` yardımcısını dosyanın başında yaz: `buildReceipt` ile geçerli bir makbuz üret, sonra `actor` alanını verilen değerle **değiştir**. Uyarı: imza `chain.hash` üzerinden atıldığı için elle bozulan makbuz imza kontrolünden de düşebilir; bu testler **imzasız** makbuzla koşulmalı (`CONARIUM_AUDIT_UNSIGNED=1`) ki ölçülen şey şema olsun, imza olmasın.

- [ ] **Step 2: Kırmızıyı doğrula**

Çalıştır: `npx vitest run test/verify_actor.test.mjs`
Beklenen: Task 3 yapılmadıysa hepsi FAIL; yapıldıysa geçer.

- [ ] **Step 3: Geriye uyum parite testini yaz**

Aynı dosyaya ekle — spec §8/8: token dosyası yokken hiçbir şey değişmemeli.

```js
describe('geriye uyum', () => {
  it('token dosyasi YOKKEN uretilen makbuz service + shared-token olur', () => {
    // CONARIUM_TOKENS_FILE'i var olmayan bir yola kur
    process.env.CONARIUM_TOKENS_FILE = join(tmpdir(), 'cnr-yok-' + Date.now() + '.json')
    const r = v2Receipt(undefined)   // aktor verilmez
    expect(r.actor.type).toBe('service')
    expect(r.actor.assurance).toBe('shared-token')
    expect(verify([r])).toBe(0)
  })
})
```

- [ ] **Step 4: 401 yolunu test et**

Spec §8/6: depo varken bilinmeyen token kimlik üretmemeli **ve** istek reddedilmeli. Bunu `src/tokens.test.ts`'e ek olarak HTTP seviyesinde doğrula — `src/http.ts` içindeki kontrolün gerçekten 401 döndürdüğünü kanıtla. Mevcut HTTP testi yoksa **bu adımı atlama**, `resolveActor` + `tokenOk` bileşiminin 401 verdiğini birim seviyede kanıtla:

```js
it('depo varken bilinmeyen token ne kimlik uretir ne gecer', () => {
  const store = loadTokenStore(tokenFile([{ token: 'tok-ayse', id: 'ayse@x.com' }]))
  const kisi = resolveActor('sahte', store, 'conarium_c2')
  expect(kisi.isUser).toBe(false)          // kimlik uretmedi
  // tokenOk('sahte') de false olacagi icin http.ts 401 doner
})
```

- [ ] **Step 5: Tüm takım yeşil**

Çalıştır: `npm test`
Beklenen: hepsi geçiyor, v0.1 fixture'ları dahil.

- [ ] **Step 6: Commit**

```bash
git add test/verify_actor.test.mjs
git commit -m "test(verify): dogrulayici aktor semasi + geriye uyum paritesi

Uretme tarafi (src/receipt.ts) ile dogrulama tarafi (bin/conarium-verify.mjs)
ayri kod ve ayri kirilirlar; bu testler CLI'yi alt surec olarak kosturup
CIKIS KODUNU olcer. Kapsanan: user+shared-token reddi (20), assurance eksikligi
(20), gecerli v0.2 kabulu (0), ve token dosyasi yokken davranisin birebir ayni
kalmasi."
```

---

## Bitiş kontrolü

- [ ] `npm test` tamamen yeşil
- [ ] `node bin/conarium-verify.mjs` v0.1 fixture'ında çıkış 0
- [ ] Token dosyası **olmayan** bir kurulumda makbuz `service` + `shared-token` üretiyor
- [ ] Token dosyası olan kurulumda denetim kaydında kişi adı görünüyor

Bunlar geçtikten **sonra** (ayrı iş): `RECEIPT-SPEC.md` boşluk #1, `compare.html` "Per-user identity" satırı, `llms.txt` sınırlaması.
