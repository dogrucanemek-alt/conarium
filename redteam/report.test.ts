import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './report.js';
import type { RedTeamReport } from './types.js';

const rep: RedTeamReport = {
  ranAt: '2026-07-02T00:00:00.000Z', total: 2, defended: 1, bypassed: 1,
  results: [
    { id: 'a', category: 'write_smuggle', severity: 'CRITICAL', description: 'x', defended: true, detail: 'ok' },
    { id: 'b', category: 'pii_exfil', severity: 'CRITICAL', description: 'y', defended: false, detail: 'leak' },
  ],
};

describe('renderMarkdown', () => {
  it('savunma karnesi + BYPASSED bulgularını listeler', () => {
    const md = renderMarkdown(rep);
    expect(md).toContain('1/2 savundu');
    expect(md).toContain('BYPASS');
    expect(md).toContain('b');
  });
});
