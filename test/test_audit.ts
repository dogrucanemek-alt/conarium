import { Audit } from '../src/audit.js';
import { Governance } from '../src/governance.js';
import fs from 'fs';

// Mock governance for masking
const gov = new Governance();

// Clean up previous test run if exists
const logFile = 'audit.test.jsonl';
if (fs.existsSync(logFile)) {
  fs.unlinkSync(logFile);
}

const audit = new Audit({ sink: logFile, consumer: 'developer_emekcan' });

async function runMockPipeline(tool: string, args: any, isDenied: boolean, rowsReturned: number) {
  // KRİTİK KURAL: Mask PII before passing to Audit!
  const maskResult = gov.maskPII(args);

  if (isDenied) {
    audit.log({
      tool,
      args: maskResult.masked,
      denied: true,
      reason: 'Policy deny',
      status: 'rejected',
      maskedCount: maskResult.count,
    });
    return;
  }

  audit.log({
    tool,
    args: maskResult.masked,
    denied: false,
    rowsReturned,
    maskedCount: maskResult.count,
    status: 'success'
  });
}

async function runTests() {
  console.log('--- FAZ 3: AUDIT LOG TEST ---');

  // Call 1: Allowed + PII
  await runMockPipeline('addUser', { name: 'John', email: 'john@doe.com', phone: '555-555-5555' }, false, 1);
  
  // Call 2: Denied
  await runMockPipeline('deleteUser', { userId: 123 }, true, 0);

  // Call 3: Normal
  await runMockPipeline('getUsers', { status: 'active' }, false, 15);

  console.log(`\nAudit log file '${logFile}' created. Reading contents:\n`);
  const logs = fs.readFileSync(logFile, 'utf8').trim().split('\n');

  for (const line of logs) {
    const entry = JSON.parse(line);
    console.log(`[${entry.timestamp}] ACTOR: ${entry.actor} | TOOL: ${entry.tool} | DENIED: ${entry.denied} | MASKED: ${entry.maskedCount}`);
    console.log(`  ARGS: ${JSON.stringify(entry.args)}`);
    
    // Test if raw PII leaked
    const rawLine = JSON.stringify(entry);
    if (rawLine.includes('john@doe.com') || rawLine.includes('555-555-5555')) {
      console.error('  ❌ FAILED: Raw PII leaked into audit log!');
    } else {
      console.log('  ✅ SUCCESS: No raw PII in this audit entry.');
    }
  }

  console.log('\nAll audit tests completed successfully.');
}

runTests().catch(console.error);
