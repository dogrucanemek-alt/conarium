import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Governance } from '../src/governance.js';
import { parseConariumConfig } from '../src/config.js';
import type { QueryResult } from '../src/types.js';

// Load the shipped example config (conarium.config.json) and prove the
// governance is actually enforced end-to-end. Synthetic data, real engine.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(__dirname, '../conarium.config.json'), 'utf8');
const config = parseConariumConfig(JSON.parse(raw));
const gov = new Governance(config.policy);

function blocked(sql: string): boolean {
  try { gov.guardQuery(sql); return false; } catch { return true; }
}

describe('conarium.config.json — governance is actually enforced', () => {
  it('denied tables are refused', () => {
    expect(blocked('SELECT * FROM public.credit_cards')).toBe(true);
    expect(blocked('SELECT * FROM public.salaries')).toBe(true);
    expect(blocked('SELECT * FROM public.secrets')).toBe(true);
    expect(blocked('SELECT * FROM public.admin_users')).toBe(true);
  });

  it('allowed tables pass', () => {
    expect(blocked('SELECT * FROM public.customers')).toBe(false);
    expect(blocked('SELECT * FROM public.orders')).toBe(false);
    expect(blocked('SELECT * FROM public.products')).toBe(false);
  });

  it('write operations are denied (DELETE/DROP)', () => {
    expect(blocked('DELETE FROM public.customers')).toBe(true);
    expect(blocked('DROP TABLE public.orders')).toBe(true);
  });

  it('PII masking works (email + national id are redacted)', () => {
    const result: QueryResult = {
      rows: [{ email: 'ahmet@test.com', national_id: '12345678901', name: 'Ahmet' }],
      rowCount: 1, fields: ['email', 'national_id', 'name'],
    };
    const governed = gov.redact(result);
    const flat = JSON.stringify(governed.rows);
    expect(flat).not.toContain('ahmet@test.com');
    expect(flat).not.toContain('12345678901');
  });

  it('row cap is 50 (not the default 100)', () => {
    expect(gov.maxRows()).toBe(50);
  });

  it('SELECT * masks configured PII columns — no star-projection leak', () => {
    const guard = gov.guardQuery('SELECT * FROM public.customers');
    const result: QueryResult = {
      rows: [{ id: 1, name: 'Alice', email: 'a@b.com', address: '42 Secret Street' }],
      rowCount: 1, fields: ['id', 'name', 'email', 'address'],
    };
    const governed = gov.redact(result, guard.aliases, guard.metadata);
    const flat = JSON.stringify(governed.rows);
    expect(flat).not.toContain('42 Secret Street'); // address is a mask column
    expect(flat).not.toContain('a@b.com');           // email is a mask column
    expect(flat).toContain('Alice');                 // name is NOT masked
  });

  it('row-locking selects (FOR SHARE / FOR UPDATE) are refused', () => {
    expect(blocked('SELECT * FROM public.customers FOR SHARE')).toBe(true);
    expect(blocked('SELECT id FROM public.customers FOR UPDATE')).toBe(true);
  });
});
