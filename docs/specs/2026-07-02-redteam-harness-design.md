# Conarium Red-Team Harness v1 — Tasarım Belgesi

- **Tarih:** 2026-07-02 · **Sahip:** Emek Can Doğru + Claude (gate)
- **Konum:** `nexus/redteam/` (Conarium repo, `@conarium-ai/core`)
- **Bağlam:** STRATEJI.md Faz 1 — "NEO Conarium'a saldırır, Conarium bloklar" demosu + Faz 2 purple-team döngüsünün tohumu.

## 1. Amaç
NEO'nun red-team kolu, Conarium'un `Governance` motoruna bir **saldırı bataryası** fırlatır; her saldırının **SAVUNULDU** (Conarium bloklamış/maskelemiş) mı yoksa **BYPASS** (geçmiş/PII sızmış) mı olduğunu ölçer. Her BYPASS = Conarium'u sertleştirecek gerçek bir politika deliği. Çıktı hem **demo** (NEO saldırır, Conarium savunur) hem de purple-team döngüsünün girdisi.

## 2. Kapsam
### Dahil (MVP — Yaklaşım ①: doğrudan kütüphane çağrısı)
İki savunma katmanına saldırı:
- **Sorgu-zamanı (`guardQuery`)**: yazma-op kaçakçılığı, yetkisiz tablo (JOIN/UNION/subquery ile), çoklu-statement, parse hileleri.
- **Sonuç-zamanı (`redact`/`maskPII`)**: PII exfiltration — encode/base64, alias, format kırma (PII'yi parçalayıp maskeyi atlatma).
- Rapor: her saldırı → {DEFENDED | BYPASSED} + severity + detay (JSON + Markdown).

### Hariç (sonra)
- Kara-kutu MCP saldırısı (② yaklaşım) ve canlı-AI prompt-injection (③).
- Politikayı OTOMATİK düzeltme (bulguyu üretiriz; düzeltme insan onayı — STRATEJI Tier 2).

## 3. Mimari
```
runRedTeam(governance, policy) →
  1. attacks[] topla (queryTime + resultTime saldırı case'leri)
  2. her case'i çalıştır → AttackResult { defended, detail }
  3. sınıflandır: DEFENDED (blok/maske) vs BYPASSED (geçti/sızdı)
  4. RedTeamReport üret (stats + bulgular)
```
`Governance` motorunu doğrudan import eder (aynı repo). Bir test `GovernancePolicy` ile örnek şirket senaryosu kurar.

## 4. Modüller (`nexus/redteam/`)
| Modül | Sorumluluk |
|---|---|
| `types.ts` | `AttackCase`, `AttackResult`, `RedTeamReport` |
| `attacks/queryTime.ts` | Sorgu-zamanı saldırı case'leri (write-smuggle, unauthorized-table, multi-statement) |
| `attacks/resultTime.ts` | Sonuç-zamanı PII-exfil case'leri (encode/base64, alias, format-break) |
| `runner.ts` | Case'leri `Governance`'a karşı çalıştır → defended/bypassed sınıfla |
| `report.ts` | `RedTeamReport` → Markdown + JSON |
| `index.ts` | `runRedTeam` orkestratör + CLI (`npx tsx redteam/index.ts`) |

## 5. Veri Modeli
```ts
type AttackCategory = 'write_smuggle' | 'unauthorized_table' | 'multi_statement' | 'pii_exfil';
type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';

interface AttackCase {
  id: string;
  category: AttackCategory;
  severity: Severity;
  description: string;
  // Conarium'a saldırıyı uygula; Conarium savundu mu döndür.
  run(gov: Governance): { defended: boolean; detail: string };
}

interface AttackResult { case: AttackCase; defended: boolean; detail: string; }

interface RedTeamReport {
  ranAt: string;
  total: number;
  defended: number;
  bypassed: number;
  results: AttackResult[]; // BYPASSED'lar = bulgular
}
```

## 6. Saldırı Case Örnekleri (davranış)
- **write_smuggle:** `guardQuery("DELETE FROM users")`, `"SELECT 1; DROP TABLE x"`, yorumla gizli write → **DEFENDED beklenir** (PolicyError).
- **unauthorized_table:** izin-dışı tabloya `JOIN`/`UNION SELECT` → **DEFENDED beklenir**.
- **pii_exfil (encode):** `redact` katmanına, `encode(email,'base64')` sonucu gibi base64 bir PII değeri ver → maske regex'i yakalamaz → **BYPASSED beklenir** (bilinen gerçek delik; harness'in görevi bunu DOĞRU tespit etmek).

## 7. Sınıflandırma Mantığı
- Sorgu-zamanı: `guardQuery` **PolicyError fırlattıysa** → DEFENDED. Fırlatmadıysa (yetkisiz erişim/write geçtiyse) → BYPASSED.
- Sonuç-zamanı: sahte sonuç satırı `redact`'ten geçir; PII string'i çıktıda **`[MASKED_PII]` değilse** → BYPASSED (sızıntı).

## 8. Test Stratejisi (TDD)
- Her saldırı case'i için birim test: bilinen-savunulan case DEFENDED döner; encode-base64 case BYPASSED döner (harness'in bypass'ı DOĞRU yakaladığını kanıtlar — Conarium'u değil, harness'i test eder).
- `runner` testi: karışık case seti → doğru defended/bypassed sayısı.
- `report` testi: bulgu içeren rapor Markdown'da BYPASSED'ları listeler.

## 9. Başarı Kriteri (MVP "bitti")
Gerçek `Governance` + örnek policy ile `runRedTeam` çalışınca:
1. En az write-smuggle **DEFENDED**, encode-base64 PII-exfil **BYPASSED** doğru sınıflanır.
2. Markdown + JSON rapor üretilir (Conarium'un savunma karnesi).
3. Testler geçer.
4. Çıktı, Faz 1 demosunun ham materyali olur ("NEO N saldırdı, Conarium X savundu, Y bypass — işte sertleştirilecekler").

## 10. Bağımlılık
- `@conarium-ai/core` `Governance` sınıfı (aynı repo, `src/governance.ts`).
- Test runner: vitest (yoksa eklenir).
- Ek dış bağımlılık yok.
