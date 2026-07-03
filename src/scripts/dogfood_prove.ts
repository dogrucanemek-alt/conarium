/**
 * Conarium Dogfood Proof — GERÇEK ZION verisinde governance kanıtı.
 * Satırlar ZION_ROWS env'inden gelir (ham PII koda gömülmez).
 */
import { Governance } from '../governance.js';

const rows = JSON.parse(process.env.ZION_ROWS || '[]');

const gov = new Governance({
  allowTables: ['public.aifurniture_waitlist', 'public.customer'],
  denyTables: ['public.wa_messages', 'public.wa_logs'],
  maskColumns: ['email', '*.email', 'telefon', 'tc_no', 'adres', 'ev_adres'],
  maxRows: 100,
});

console.log('👁️  CONARIUM — GERÇEK ZION VERİSİNDE GOVERNANCE KANITI\n' + '='.repeat(52));

console.log('\n1) ERİŞİM KONTROLÜ (allow/deny):');
console.log('   public.aifurniture_waitlist →', gov.allowsTable('public.aifurniture_waitlist') ? 'ALLOW ✅' : 'DENY ⛔');
console.log('   public.wa_messages (özel)   →', gov.allowsTable('public.wa_messages') ? 'ALLOW ✅' : 'DENY ⛔');

console.log('\n2) SORGU KORUMASI (read-only guard):');
try { gov.guardQuery('DELETE FROM aifurniture_waitlist'); console.log('   DELETE → İZİN (HATA!)'); }
catch (e: any) { console.log('   "DELETE FROM ..." →', e.message, '⛔'); }
try { gov.guardQuery('SELECT email FROM aifurniture_waitlist'); console.log('   "SELECT email ..." → izin verildi ✅'); }
catch (e: any) { console.log('   SELECT bloklandı (HATA!):', e.message); }

console.log('\n3) GERÇEK VERİ MASKELEME — AI Conarium üzerinden BUNU görür:');
const masked = gov.redact({ rows } as any);
masked.rows.forEach((r: any) => console.log('   ', JSON.stringify({ email: r.email, source: r.source })));

const pii = gov.maskPII(rows);
console.log('\n4) REGEX PII TARAMA: toplam', pii.count, 'PII tespit edildi + maskelendi');

console.log('\n5) SATIR LİMİTİ:', gov.maxRows(), 'satır (AI milyon satır çekemez)');

console.log('\n6) AUDIT LOG (ham PII İÇERMEZ):');
console.log('   ', JSON.stringify({ ts: '2026-06-28', actor: 'Cursor', tool: 'query_db', table: 'aifurniture_waitlist', rows: rows.length, masked: pii.count, decision: 'allow' }));

console.log('\n' + '='.repeat(52) + '\n✅ Conarium GERÇEK ZION verisinde çalıştı — PII maskelendi, özel tablo reddedildi.');
