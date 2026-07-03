import { describe, it, expect } from 'vitest';
import { Audit } from './audit.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Regression for the audit "no raw secrets in the log" claim: the sink must
// redact API keys, passwords and connection-string credentials, not only PII.
describe('audit maskArgs — secrets, not just PII', () => {
  it('redacts API keys, passwords and connection-string credentials', () => {
    const sink = path.join(os.tmpdir(), `conarium-audit-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.rmSync(sink, { force: true });
    const audit = new Audit({ sink, consumer: 'test' });
    audit.log({
      tool: 'query',
      denied: false,
      args: {
        key: 'sk_live_ABCDEFGHIJKLMNOP',
        line: 'password=SuperSecret123',
        dsn: 'postgres://user:hunter2@db.internal:5432/app',
      },
    });
    const content = fs.readFileSync(sink, 'utf8');
    fs.rmSync(sink, { force: true });
    expect(content).not.toContain('sk_live_ABCDEFGHIJKLMNOP');
    expect(content).not.toContain('hunter2');
    expect(content).not.toContain('SuperSecret123');
    expect(content).toContain('[MASKED_SECRET]');
  });
});
