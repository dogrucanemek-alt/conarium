import { describe, it, expect } from 'vitest';
import { redTeamConarium, allAttacks } from './index.js';

describe('redTeamConarium', () => {
  it('gerçek Governance ile çalışır: write + base64 PII DEFENDED (sertleştirme sonrası)', () => {
    const rep = redTeamConarium({ allowTables: ['public.customers'], maskColumns: ['*.email'] });
    expect(rep.total).toBe(allAttacks.length);
    expect(rep.results.find(r => r.id === 'wr-delete')!.defended).toBe(true);
    expect(rep.results.find(r => r.id === 'pii-base64')!.defended).toBe(true);
  });
});
