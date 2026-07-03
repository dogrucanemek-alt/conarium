import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Governance } from '../src/governance.js';
import { parseConariumConfig } from '../src/config.js';
import type { QueryResult } from '../src/types.js';

// ZION'un GERÇEK config'ini (conarium.config.json) yükle → koruma fiilen çalışıyor mu?
// Sahte veri, gerçek motor. Doğrucan verisine dokunmaz.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(__dirname, '../conarium.config.json'), 'utf8');
const config = parseConariumConfig(JSON.parse(raw));
const gov = new Governance(config.policy);

function blocked(sql: string): boolean {
  try { gov.guardQuery(sql); return false; } catch { return true; }
}

describe('ZION conarium.config.json — koruma FİİLEN uygulanıyor mu', () => {
  it('HASSAS tablolar REDDEDİLİR (kredi_kartlari/maaslar/bilanco/sirlar)', () => {
    expect(blocked('SELECT * FROM public.kredi_kartlari')).toBe(true);
    expect(blocked('SELECT * FROM public.calisan_maaslari')).toBe(true);
    expect(blocked('SELECT * FROM public.finans_bilanco')).toBe(true);
    expect(blocked('SELECT * FROM public.sirket_sirlari')).toBe(true);
  });

  it('İZİNLİ tablolar geçer (musteriler/satislar/urunler)', () => {
    expect(blocked('SELECT * FROM public.musteriler')).toBe(false);
    expect(blocked('SELECT * FROM public.satislar')).toBe(false);
    expect(blocked('SELECT * FROM public.urunler')).toBe(false);
  });

  it('yazma operasyonu reddedilir (DELETE/DROP)', () => {
    expect(blocked('DELETE FROM public.musteriler')).toBe(true);
    expect(blocked('DROP TABLE public.satislar')).toBe(true);
  });

  it('PII maskeleme çalışır (email + tc_kimlik → maskeli)', () => {
    const result: QueryResult = {
      rows: [{ email: 'ahmet@test.com', tc_kimlik: '12345678901', ad: 'Ahmet' }],
      rowCount: 1, fields: ['email', 'tc_kimlik', 'ad'],
    };
    const governed = gov.redact(result);
    const flat = JSON.stringify(governed.rows);
    expect(flat).not.toContain('ahmet@test.com');
    expect(flat).not.toContain('12345678901');
  });

  it('satır limiti 50 (varsayılan 100 değil)', () => {
    expect(gov.maxRows()).toBe(50);
  });
});
