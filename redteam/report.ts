import type { RedTeamReport } from './types.js';

export function renderMarkdown(r: RedTeamReport): string {
  const l: string[] = [];
  l.push(`# SMITH → CONARIUM · Savunma Karnesi`);
  l.push(`_Smith (kırmızı saldırgan) saldırır — Conarium/Neo (mavi muhafız) savunur._`);
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
