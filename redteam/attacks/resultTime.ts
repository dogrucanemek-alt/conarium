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
