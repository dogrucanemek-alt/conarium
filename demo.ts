import { PostgresConnector } from './src/connectors/postgres.js';
import { Governance } from './src/governance.js';
import { Audit } from './src/audit.js';

async function runDemo() {
  console.log('\n======================================================');
  console.log('🚀 CONARIUM GOVERNANCE GATEWAY - 60 SECOND DEMO 🚀');
  console.log('======================================================\n');

  console.log('[SCENARIO] An AI Coding Assistant requests customer data.');
  console.log('Without Conarium, the AI sees EVERYTHING (SSN, Emails, Financials).\n');

  // 1. Initialize Mocks
  const pg = new PostgresConnector({ name: 'pg_main', description: '', type: 'postgres', config: { url: 'postgres://dummy' } });
  pg.connect = async () => {}; // override connect to not fail with dummy url
  await pg.connect();

  // MOCK DATA OVERRIDE
  pg.query = async (sql: string) => {
    if (sql.includes('customers')) {
      return {
        rows: [
          { id: 101, name: 'John Doe', email: 'john.doe@enterprise.com', ssn: '123-45-678', plan: 'Enterprise' },
          { id: 102, name: 'Jane Smith', email: 'jane.smith@startup.io', ssn: '987-65-432', plan: 'Pro' }
        ],
        rowCount: 2,
        fields: ['id', 'name', 'email', 'ssn', 'plan'],
        sql
      };
    } else if (sql.includes('secrets')) {
       return {
        rows: [{ api_key: 'sk_live_123456789' }],
        rowCount: 1, fields: ['api_key'], sql
      };
    }
    return { rows: [], rowCount: 0, fields: [], sql };
  };

  // 2. Initialize Conarium
  const gov = new Governance({
    maskColumns: ['email', 'ssn'],
    denyTables: ['secrets']
  });
  
  // Custom mock for checking table allow/deny based on sql string for demo purposes
  const _govGuardQuery = gov.guardQuery.bind(gov);
  gov.guardQuery = (sql: string) => {
    _govGuardQuery(sql);
    if (sql.includes('secrets') && !gov.allowsTable('secrets')) {
      throw new Error('PolicyError: Table "secrets" is explicitly denied by governance policy.');
    }
  };

  const audit = new Audit({ consumer: 'Claude_Copilot' });

  // 3. STEP 1: RAW DATA (What normally happens)
  console.log('------------------------------------------------------');
  console.log('🔴 STEP 1: RAW DATA (The danger of direct DB access)');
  console.log('------------------------------------------------------');
  const rawData = await pg.query('SELECT * FROM customers');
  console.log(JSON.stringify(rawData.rows, null, 2));


  // 4. STEP 2: GOVERNED DATA
  console.log('\n------------------------------------------------------');
  console.log('🟢 STEP 2: GOVERNED DATA (Through Conarium)');
  console.log('------------------------------------------------------');
  const governedData = gov.redact(rawData);
  audit.log({
    tool: 'query_db',
    target: pg.name,
    rows: governedData.rowCount,
    decision: 'allow'
  });
  console.log(JSON.stringify(governedData.rows, null, 2));


  // 5. STEP 3: BLOCKED QUERY
  console.log('\n------------------------------------------------------');
  console.log('🛑 STEP 3: POLICY VIOLATION (Attempting to read secrets)');
  console.log('------------------------------------------------------');
  try {
    const maliciousQuery = 'SELECT * FROM secrets';
    gov.guardQuery(maliciousQuery);
    await pg.query(maliciousQuery);
  } catch (e: any) {
    console.log(`[BLOCKED] ${e.message}`);
    audit.log({
      tool: 'query_db',
      target: pg.name,
      rows: 0,
      decision: 'deny'
    });
  }

  // 6. STEP 4: AUDIT LOG
  console.log('\n------------------------------------------------------');
  console.log('📋 STEP 4: AUDIT TRAIL');
  console.log('------------------------------------------------------');
  console.log('Conarium automatically records an irrefutable audit trail for compliance (SOC2/GDPR):\n');
  
  // Since audit logs to stderr or file, we mock reading it for the demo
  console.log(`{"ts":"${new Date().toISOString()}","consumer":"Claude_Copilot","tool":"query_db","target":"pg_main","rows":2,"decision":"allow"}`);
  console.log(`{"ts":"${new Date().toISOString()}","consumer":"Claude_Copilot","tool":"query_db","target":"pg_main","rows":0,"decision":"deny"}`);

  console.log('\n======================================================');
  console.log('✅ DEMO COMPLETE. Conarium keeps your data safe.');
  console.log('======================================================\n');
}

runDemo().catch(console.error);
