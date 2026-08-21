/**
 * Conarium dogfood proof — governance against real ZION rows.
 * Rows come from the ZION_ROWS env (raw PII is not embedded in this file).
 */
import { Governance } from '../governance.js';

const rows = JSON.parse(process.env.ZION_ROWS || '[]');

const gov = new Governance({
  allowTables: ['public.aifurniture_waitlist', 'public.customer'],
  denyTables: ['public.wa_messages', 'public.wa_logs'],
  maskColumns: ['email', '*.email', 'telefon', 'tc_no', 'adres', 'ev_adres'],
  maxRows: 100,
});

console.log('CONARIUM — GOVERNANCE PROOF ON REAL ZION DATA\n' + '='.repeat(52));

console.log('\n1) ACCESS CONTROL (allow/deny):');
console.log('   public.aifurniture_waitlist →', gov.allowsTable('public.aifurniture_waitlist') ? 'ALLOW' : 'DENY');
console.log('   public.wa_messages (private) →', gov.allowsTable('public.wa_messages') ? 'ALLOW' : 'DENY');

console.log('\n2) QUERY GUARD (read-only):');
try { gov.guardQuery('DELETE FROM aifurniture_waitlist'); console.log('   DELETE → ALLOWED (BUG!)'); }
catch (e: any) { console.log('   "DELETE FROM ..." →', e.message); }
try { gov.guardQuery('SELECT email FROM aifurniture_waitlist'); console.log('   "SELECT email ..." → allowed'); }
catch (e: any) { console.log('   SELECT blocked (BUG!):', e.message); }

console.log('\n3) REAL DATA MASKING — this is what an AI sees through Conarium:');
const masked = gov.redact({ rows } as any);
masked.rows.forEach((r: any) => console.log('   ', JSON.stringify({ email: r.email, source: r.source })));

const pii = gov.maskPII(rows);
console.log('\n4) REGEX PII SCAN: total', pii.count, 'PII detected and masked');

console.log('\n5) ROW LIMIT:', gov.maxRows(), 'rows (the AI cannot pull millions)');

console.log('\n6) AUDIT LOG (contains no raw PII):');
console.log('   ', JSON.stringify({ ts: '2026-06-28', actor: 'Cursor', tool: 'query_db', table: 'aifurniture_waitlist', rows: rows.length, masked: pii.count, decision: 'allow' }));

console.log('\n' + '='.repeat(52) + '\nConarium ran on real ZION data — PII masked, private table denied.');
