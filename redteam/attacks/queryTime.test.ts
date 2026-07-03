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
