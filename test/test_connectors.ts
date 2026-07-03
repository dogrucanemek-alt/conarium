import { DocsConnector } from '../src/connectors/docs.js';
import { PostgresConnector } from '../src/connectors/postgres.js';
import { Governance } from '../src/governance.js';
import { Audit } from '../src/audit.js';
import fs from 'fs';
import path from 'path';

// Setup Mock Docs directory
const mockDocsDir = './test_docs_mock';
if (!fs.existsSync(mockDocsDir)) {
  fs.mkdirSync(mockDocsDir);
  fs.writeFileSync(path.join(mockDocsDir, 'architecture.md'), 'The core architecture includes a postgres database and react frontend. Contact admin@dogrucan.com for details.');
  fs.writeFileSync(path.join(mockDocsDir, 'setup.txt'), 'To setup, run npm install. The master DB password is not stored here.');
}

async function runTests() {
  console.log('--- FAZ 5: CONNECTORS TEST ---');

  // Initialize Governance & Audit (from main branch's core implementation)
  const gov = new Governance({
    maskColumns: ['email', 'contentSnippet']
  });
  const audit = new Audit({ consumer: 'test_user' });

  // 1. Test Docs Connector
  const docs = new DocsConnector({ name: 'local_docs', config: { path: mockDocsDir } });
  await docs.connect();
  
  console.log('\n[TEST 1] Docs Connector Search (Keyword: "architecture")');
  const docsResultRaw = await docs.search('architecture');
  
  // Pass through Governance
  const docsResultSafe = gov.redact(docsResultRaw);
  
  // Pass through Audit
  audit.log({
    tool: 'search_docs',
    target: docs.name,
    rows: docsResultSafe.rowCount,
    decision: 'allow'
  });

  console.log('Docs Search Result (Masked by Governance):');
  console.log(JSON.stringify(docsResultSafe.rows, null, 2));


  // 2. Test Postgres Connector (Mock Mode)
  const pg = new PostgresConnector({ name: 'pg_mock', config: { mock: 'true' } });
  await pg.connect();

  console.log('\n[TEST 2] Postgres Connector (Mock Query)');
  const pgResultRaw = await pg.query('SELECT * FROM users');
  
  // Pass through Governance
  const pgResultSafe = gov.redact(pgResultRaw);

  // Pass through Audit
  audit.log({
    tool: 'query_db',
    target: pg.name,
    rows: pgResultSafe.rowCount,
    decision: 'allow'
  });

  console.log('Postgres Query Result (Masked by Governance):');
  console.log(JSON.stringify(pgResultSafe.rows, null, 2));

  // Cleanup
  fs.unlinkSync(path.join(mockDocsDir, 'architecture.md'));
  fs.unlinkSync(path.join(mockDocsDir, 'setup.txt'));
  fs.rmdirSync(mockDocsDir);

  console.log('\nAll connector tests completed successfully.');
}

runTests().catch(console.error);
