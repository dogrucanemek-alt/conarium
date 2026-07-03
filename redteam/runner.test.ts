import { describe, it, expect } from 'vitest';
import { Governance } from '../src/governance.js';
import { runRedTeam } from './runner.js';
import type { AttackCase } from './types.js';

const fake: AttackCase[] = [
  { id: 'a', category: 'write_smuggle', severity: 'CRITICAL', description: 'x', run: () => ({ defended: true, detail: 'ok' }) },
  { id: 'b', category: 'pii_exfil', severity: 'CRITICAL', description: 'y', run: () => ({ defended: false, detail: 'leak' }) },
];

describe('runRedTeam', () => {
  it('defended/bypassed sayar', () => {
    const rep = runRedTeam(new Governance({}), fake, new Date('2026-07-02T00:00:00Z'));
    expect(rep.total).toBe(2);
    expect(rep.defended).toBe(1);
    expect(rep.bypassed).toBe(1);
  });
});
