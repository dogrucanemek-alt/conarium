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
