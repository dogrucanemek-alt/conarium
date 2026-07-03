import { describe, it, expect } from 'vitest';
import { Governance } from '../../src/governance.js';
import { resultTimeAttacks } from './resultTime.js';

const gov = new Governance({ maskColumns: ['*.email'], maxRows: 100 });

describe('resultTimeAttacks', () => {
  it('düz-metin PII DEFENDED (maskelenir)', () => {
    const plain = resultTimeAttacks.find(a => a.id === 'pii-plaintext')!;
    expect(plain.run(gov).defended).toBe(true);
  });
  it('base64-encode PII artık DEFENDED (Conarium sertleştirildi — döngü kapandı)', () => {
    const enc = resultTimeAttacks.find(a => a.id === 'pii-base64')!;
    expect(enc.run(gov).defended).toBe(true);
  });
});
