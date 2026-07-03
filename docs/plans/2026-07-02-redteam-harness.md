# Conarium Red-Team Harness v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** NEO'nun Conarium'un `Governance` motoruna saldırıp savunmayı ölçen, DEFENDED/BYPASSED raporu üreten red-team harness'i.

**Architecture:** `nexus/redteam/` altında izole modüller. Saldırı case'leri (`AttackCase`) doğrudan `Governance` sınıfını çağırır: sorgu-zamanı `guardQuery` (PolicyError=blok), sonuç-zamanı `redact` (PII maske). Runner sınıflar, report üretir.

**Tech Stack:** TypeScript (ESM/NodeNext), tsx, vitest.

## Global Constraints

- ESM/NodeNext: **tüm importlar `.js` uzantısı kullanır** (repo konvansiyonu; örn. `import { Governance } from '../src/governance.js'`).
- `Governance` API (kanıtlı): `new Governance(policy: GovernancePolicy)`; `guardQuery(sql): GuardedQuery` — bloklarsa `PolicyError` fırlatır; `redact(result: QueryResult): GovernedQueryResult` — `QueryResult = { rows, rowCount, fields, sql? }`.
- Harness Conarium'u DEĞİŞTİRMEZ; sadece dışarıdan çağırır (salt-okunur saldırı).
- Test runner: `vitest run` (`npm test`).
- Dürüstlük: encode-base64 PII-exfil case'i **BYPASSED beklenir** (gerçek delik); harness bunu doğru tespit etmeli.

---

### Task 0: Test altyapısı + redteam/types.ts

**Files:**
- Modify: `package.json` (devDep vitest, script test)
- Create: `redteam/types.ts`

- [ ] **Step 1:** `package.json` → `devDependencies`'e `"vitest": "^2.0.0"`, `scripts`'e `"test": "vitest run"` ekle, sonra `npm install`.

- [ ] **Step 2:** `redteam/types.ts` oluştur:

```ts
import type { Governance } from '../src/governance.js';

export type AttackCategory = 'write_smuggle' | 'unauthorized_table' | 'multi_statement' | 'pii_exfil';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export interface AttackCase {
  id: string;
  category: AttackCategory;
  severity: Severity;
  description: string;
  run(gov: Governance): { defended: boolean; detail: string };
}

export interface AttackResult {
  id: string;
  category: AttackCategory;
  severity: Severity;
  description: string;
  defended: boolean;
  detail: string;
}

export interface RedTeamReport {
  ranAt: string;
  total: number;
  defended: number;
  bypassed: number;
  results: AttackResult[];
}
```

- [ ] **Step 3:** Doğrula: `npx tsx -e "import('./redteam/types.js').then(()=>console.log('types OK'))"` → "types OK"
- [ ] **Step 4:** Commit: `git add package.json redteam/types.ts && git commit -m "chore(redteam): test altyapısı + tipler"`

---

### Task 1: attacks/queryTime.ts (sorgu-zamanı saldırılar)

**Files:**
- Create: `redteam/attacks/queryTime.ts`
- Test: `redteam/attacks/queryTime.test.ts`

**Interfaces:**
- Produces: `queryTimeAttacks: AttackCase[]`

- [ ] **Step 1: Testi yaz:**

```ts
import { describe, it, expect } from 'vitest';
import { Governance } from '../../src/governance.js';
import { queryTimeAttacks } from './queryTime.js';

const gov = new Governance({ allowTables: ['public.customers'], maxRows: 100 });

describe('queryTimeAttacks', () => {
  it('tüm write/multi-statement/yetkisiz-tablo saldırıları DEFENDED (bloklanır)', () => {
    for (const atk of queryTimeAttacks) {
      const r = atk.run(gov);
      expect(r.defended, `${atk.id} savunulmalıydı: ${r.detail}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2:** `npx vitest run redteam/attacks/queryTime.test.ts` → FAIL
- [ ] **Step 3: Uygula:**

```ts
import type { AttackCase } from '../types.js';
import type { Governance } from '../../src/governance.js';

function shouldBlock(gov: Governance, sql: string): { defended: boolean; detail: string } {
  try {
    gov.guardQuery(sql);
    return { defended: false, detail: `BYPASS — guardQuery izin verdi: ${sql}` };
  } catch (e: any) {
    return { defended: true, detail: `DEFENDED — ${e.message}` };
  }
}

export const queryTimeAttacks: AttackCase[] = [
  { id: 'wr-delete', category: 'write_smuggle', severity: 'CRITICAL', description: 'Düz DELETE',
    run: g => shouldBlock(g, 'DELETE FROM customers') },
  { id: 'wr-drop', category: 'write_smuggle', severity: 'CRITICAL', description: 'DROP TABLE',
    run: g => shouldBlock(g, 'DROP TABLE customers') },
  { id: 'wr-stacked', category: 'multi_statement', severity: 'CRITICAL', description: 'Stacked query ile gizli write',
    run: g => shouldBlock(g, 'SELECT 1; DROP TABLE customers') },
  { id: 'wr-update-comment', category: 'write_smuggle', severity: 'HIGH', description: 'Yorumla gizlenmiş UPDATE',
    run: g => shouldBlock(g, 'UPDATE customers SET name=1 -- SELECT') },
  { id: 'tbl-unauth', category: 'unauthorized_table', severity: 'HIGH', description: 'İzin listesi dışı tabloya erişim',
    run: g => shouldBlock(g, 'SELECT * FROM secret.admin_users') },
];
```

- [ ] **Step 4:** `npx vitest run redteam/attacks/queryTime.test.ts` → PASS
- [ ] **Step 5:** Commit: `git add redteam/attacks/queryTime.* && git commit -m "feat(redteam): sorgu-zamanı saldırılar"`

---

### Task 2: attacks/resultTime.ts (PII exfil — encode bypass'ı yakalar)

**Files:**
- Create: `redteam/attacks/resultTime.ts`
- Test: `redteam/attacks/resultTime.test.ts`

**Interfaces:**
- Produces: `resultTimeAttacks: AttackCase[]`

- [ ] **Step 1: Testi yaz:**

```ts
import { describe, it, expect } from 'vitest';
import { Governance } from '../../src/governance.js';
import { resultTimeAttacks } from './resultTime.js';

const gov = new Governance({ maskColumns: ['*.email'], maxRows: 100 });

describe('resultTimeAttacks', () => {
  it('düz-metin PII DEFENDED (maskelenir)', () => {
    const plain = resultTimeAttacks.find(a => a.id === 'pii-plaintext')!;
    expect(plain.run(gov).defended).toBe(true);
  });
  it('base64-encode PII BYPASSED (harness gerçek deliği yakalar)', () => {
    const enc = resultTimeAttacks.find(a => a.id === 'pii-base64')!;
    expect(enc.run(gov).defended).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run redteam/attacks/resultTime.test.ts` → FAIL
- [ ] **Step 3: Uygula:**

```ts
import type { AttackCase } from '../types.js';
import type { Governance } from '../../src/governance.js';
import type { QueryResult, GovernedQueryResult } from '../../src/types.js';

const PII_EMAIL = 'ahmet@wearu.app';
const PII_RE = /@[a-z0-9.-]+\.[a-z]{2,}|\b[1-9][0-9]{10}\b/i;

function containsRecoverablePII(governed: GovernedQueryResult): boolean {
  const flat = JSON.stringify(governed.rows);
  if (PII_RE.test(flat)) return true; // düz PII sağ kaldı
  for (const row of governed.rows) {
    for (const v of Object.values(row)) {
      if (typeof v === 'string' && /^[A-Za-z0-9+/]{8,}={0,2}$/.test(v)) {
        try {
          const dec = Buffer.from(v, 'base64').toString('utf8');
          if (PII_RE.test(dec)) return true; // encode ile kaçırılmış PII
        } catch { /* base64 değil */ }
      }
    }
  }
  return false;
}

function tryRedact(gov: Governance, rows: Record<string, unknown>[]): { defended: boolean; detail: string } {
  const result: QueryResult = { rows, rowCount: rows.length, fields: Object.keys(rows[0] ?? {}) };
  const governed = gov.redact(result);
  const leaked = containsRecoverablePII(governed);
  return {
    defended: !leaked,
    detail: leaked
      ? `BYPASS — PII geri-kazanılabilir: ${JSON.stringify(governed.rows)}`
      : `DEFENDED — maskelendi: ${JSON.stringify(governed.rows)}`,
  };
}

export const resultTimeAttacks: AttackCase[] = [
  { id: 'pii-plaintext', category: 'pii_exfil', severity: 'HIGH', description: 'Düz-metin e-posta çıktısı',
    run: g => tryRedact(g, [{ email: PII_EMAIL }]) },
  { id: 'pii-base64', category: 'pii_exfil', severity: 'CRITICAL', description: 'encode(email,base64) ile maske atlatma',
    run: g => tryRedact(g, [{ leak: Buffer.from(PII_EMAIL).toString('base64') }]) },
];
```

- [ ] **Step 4:** `npx vitest run redteam/attacks/resultTime.test.ts` → PASS
- [ ] **Step 5:** Commit: `git add redteam/attacks/resultTime.* && git commit -m "feat(redteam): sonuç-zamanı PII-exfil (encode bypass tespiti)"`

---

### Task 3: runner.ts

**Files:**
- Create: `redteam/runner.ts`
- Test: `redteam/runner.test.ts`

**Interfaces:**
- Consumes: `AttackCase`, `RedTeamReport`, `Governance`
- Produces: `runRedTeam(gov: Governance, attacks: AttackCase[], now?: Date): RedTeamReport`

- [ ] **Step 1: Testi yaz:**

```ts
import { describe, it, expect } from 'vitest';
import { Governance } from '../src/governance.js';
import { runRedTeam } from './runner.js';
import type { AttackCase } from './types.js';

const fake: AttackCase[] = [
  { id: 'a', category: 'write_smuggle', severity: 'CRITICAL', description: 'x', run: () => ({ defended: true, detail: 'ok' }) },
  { id: 'b', category: 'pii_exfil', severity: 'CRITICAL', description: 'y', run: () => ({ defended: false, detail: 'leak' }) },
];

describe('runRedTeam', () => {
  it('defended/bypassed sayar', () => {
    const rep = runRedTeam(new Governance({}), fake, new Date('2026-07-02T00:00:00Z'));
    expect(rep.total).toBe(2);
    expect(rep.defended).toBe(1);
    expect(rep.bypassed).toBe(1);
  });
});
```

- [ ] **Step 2:** `npx vitest run redteam/runner.test.ts` → FAIL
- [ ] **Step 3: Uygula:**

```ts
import type { Governance } from '../src/governance.js';
import type { AttackCase, AttackResult, RedTeamReport } from './types.js';

export function runRedTeam(gov: Governance, attacks: AttackCase[], now: Date = new Date()): RedTeamReport {
  const results: AttackResult[] = attacks.map(atk => {
    const { defended, detail } = atk.run(gov);
    return { id: atk.id, category: atk.category, severity: atk.severity, description: atk.description, defended, detail };
  });
  return {
    ranAt: now.toISOString(),
    total: results.length,
    defended: results.filter(r => r.defended).length,
    bypassed: results.filter(r => !r.defended).length,
    results,
  };
}
```

- [ ] **Step 4:** `npx vitest run redteam/runner.test.ts` → PASS
- [ ] **Step 5:** Commit: `git add redteam/runner.* && git commit -m "feat(redteam): runner + sınıflandırma"`

---

### Task 4: report.ts

**Files:**
- Create: `redteam/report.ts`
- Test: `redteam/report.test.ts`

**Interfaces:**
- Consumes: `RedTeamReport`
- Produces: `renderMarkdown(report: RedTeamReport): string`

- [ ] **Step 1: Testi yaz:**

```ts
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './report.js';
import type { RedTeamReport } from './types.js';

const rep: RedTeamReport = {
  ranAt: '2026-07-02T00:00:00.000Z', total: 2, defended: 1, bypassed: 1,
  results: [
    { id: 'a', category: 'write_smuggle', severity: 'CRITICAL', description: 'x', defended: true, detail: 'ok' },
    { id: 'b', category: 'pii_exfil', severity: 'CRITICAL', description: 'y', defended: false, detail: 'leak' },
  ],
};

describe('renderMarkdown', () => {
  it('savunma karnesi + BYPASSED bulgularını listeler', () => {
    const md = renderMarkdown(rep);
    expect(md).toContain('1/2 savundu');
    expect(md).toContain('BYPASS');
    expect(md).toContain('b');
  });
});
```

- [ ] **Step 2:** `npx vitest run redteam/report.test.ts` → FAIL
- [ ] **Step 3: Uygula:**

```ts
import type { RedTeamReport } from './types.js';

export function renderMarkdown(r: RedTeamReport): string {
  const l: string[] = [];
  l.push(`# Conarium Savunma Karnesi (NEO Red-Team)`);
  l.push(`Tarih: ${r.ranAt}`, '');
  l.push(`**Sonuç: ${r.defended}/${r.total} savundu, ${r.bypassed} bypass.**`, '');
  const bypassed = r.results.filter(x => !x.defended);
  if (bypassed.length) {
    l.push(`## 🚨 Sertleştirilecekler (BYPASS)`);
    for (const b of bypassed) l.push(`- [${b.severity}] ${b.id} — ${b.description}\n  - ${b.detail}`);
    l.push('');
  }
  l.push(`## ✅ Savunulanlar (DEFENDED)`);
  for (const d of r.results.filter(x => x.defended)) l.push(`- [${d.severity}] ${d.id} — ${d.description}`);
  return l.join('\n');
}
```

- [ ] **Step 4:** `npx vitest run redteam/report.test.ts` → PASS
- [ ] **Step 5:** Commit: `git add redteam/report.* && git commit -m "feat(redteam): savunma karnesi render"`

---

### Task 5: index.ts (orkestratör + CLI)

**Files:**
- Create: `redteam/index.ts`
- Test: `redteam/index.test.ts`

**Interfaces:**
- Consumes: `runRedTeam`, `queryTimeAttacks`, `resultTimeAttacks`, `Governance`
- Produces: `allAttacks: AttackCase[]`, `redTeamConarium(policy): RedTeamReport`

- [ ] **Step 1: Testi yaz:**

```ts
import { describe, it, expect } from 'vitest';
import { redTeamConarium, allAttacks } from './index.js';

describe('redTeamConarium', () => {
  it('gerçek Governance ile çalışır: write DEFENDED + base64 PII BYPASS', () => {
    const rep = redTeamConarium({ allowTables: ['public.customers'], maskColumns: ['*.email'] });
    expect(rep.total).toBe(allAttacks.length);
    expect(rep.results.find(r => r.id === 'wr-delete')!.defended).toBe(true);
    expect(rep.results.find(r => r.id === 'pii-base64')!.defended).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run redteam/index.test.ts` → FAIL
- [ ] **Step 3: Uygula:**

```ts
import { Governance } from '../src/governance.js';
import type { GovernancePolicy } from '../src/types.js';
import type { AttackCase, RedTeamReport } from './types.js';
import { queryTimeAttacks } from './attacks/queryTime.js';
import { resultTimeAttacks } from './attacks/resultTime.js';
import { runRedTeam } from './runner.js';
import { renderMarkdown } from './report.js';

export const allAttacks: AttackCase[] = [...queryTimeAttacks, ...resultTimeAttacks];

export function redTeamConarium(policy: GovernancePolicy): RedTeamReport {
  return runRedTeam(new Governance(policy), allAttacks);
}

// CLI: npx tsx redteam/index.ts
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  const rep = redTeamConarium({ allowTables: ['public.customers'], maskColumns: ['*.email'], maxRows: 100 });
  console.log(renderMarkdown(rep));
}
```

- [ ] **Step 4:** `npx vitest run redteam/index.test.ts` → PASS. Sonra tüm suite: `npm test` → hepsi PASS.
- [ ] **Step 5:** Commit: `git add redteam/index.* && git commit -m "feat(redteam): orkestratör + CLI"`

---

### Task 6: Canlı çalıştırma (demo materyali)

**Files:**
- (kod yok — canlı doğrulama)

- [ ] **Step 1: Harness'i gerçek Conarium'a karşı çalıştır:**

Run: `npx tsx redteam/index.ts`

Beklenen: Markdown "Savunma Karnesi" — write/unauthorized saldırıları DEFENDED, `pii-base64` BYPASS olarak listelenir (Conarium'un gerçek deliği = Faz 1 demosunun ham materyali + Faz 2 sertleştirme girdisi).

- [ ] **Step 2:** Raporu kaydet: `npx tsx redteam/index.ts > redteam/last-report.md` (gitignore'a `redteam/last-report.md` ekle).

---

## Self-Review

**Spec coverage:** ✅ query-time saldırılar (T1), result-time PII-exfil + encode bypass (T2), runner sınıflandırma (T3), savunma karnesi (T4), orkestratör+CLI (T5), canlı demo (T6). Test stratejisi her task'ta.

**Placeholder scan:** Tüm adımlarda gerçek kod; TODO/TBD yok.

**Type consistency:** `AttackCase.run(gov): {defended, detail}` T0'da tanımlı, T1/T2/T5 aynı kullanıyor. `runRedTeam(gov, attacks, now?)` T3↔T5 tutarlı. `QueryResult` `{rows,rowCount,fields}` gerçek tiple (types.ts:63) uyumlu. Importlar `.js` uzantılı (repo konvansiyonu).

**Not:** encode-base64 case'i bilerek BYPASS beklenir — bu Conarium'un gerçek deliği; harness'in görevi onu doğru yakalamak (Conarium'u kusursuz göstermek değil).
