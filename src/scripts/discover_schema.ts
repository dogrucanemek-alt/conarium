import { PostgresConnector } from '../connectors/postgres.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('CONARIUM SCHEMA DISCOVERY STARTING\n');

  const connectionString = process.env.ZION_READONLY_DSN;
  if (!connectionString) {
    console.error('ERROR: ZION_READONLY_DSN is not set.');
    console.error('Define the DSN before running this script.');
    process.exit(1);
  }

  const pgConnector = new PostgresConnector({
    type: 'postgres',
    name: 'zion_postgres',
    description: 'ZION schema discovery connection',
    config: {
      url: connectionString,
      mock: 'false'
    }
  });

  try {
    await pgConnector.connect();
    console.log('Connected to the ZION database.');

    const tables = await pgConnector.listTables();
    console.log(`${tables.length} table(s) found. Analysing schemas...\n`);

    const policy: any = {
      maxRowsPerQuery: 100,
      tables: {},
      defaultPolicy: "deny"
    };

    // Column-name tokens as they appear in the warehouse. Translating them
    // would stop the matcher from finding those columns.
    const piiKeywords = ['email', 'mail', 'telefon', 'phone', 'tel', 'adres', 'address', 'tc', 'kimlik', 'ssn', 'kart', 'card', 'password', 'sifre', 'secret'];
    const sensitiveTableKeywords = ['finans', 'kredi', 'maas', 'sifre', 'secret', 'bilanco', 'muhasebe', 'salary', 'finance', 'password', 'token'];

    for (const table of tables) {
      const fullTableName = `${table.schema}.${table.name}`;
      try {
        const desc = await pgConnector.describeTable(fullTableName);
        
        // Auto-detect columns whose names look like PII
        const maskColumns = desc.columns
          .filter(c => piiKeywords.some(keyword => c.name.toLowerCase().includes(keyword)))
          .map(c => c.name);

        // Sensitive table name → deny the table outright
        const isSensitive = sensitiveTableKeywords.some(keyword => table.name.toLowerCase().includes(keyword));

        if (isSensitive) {
           policy.tables[fullTableName] = {
             allowed: false
           };
           console.log(`[!] SENSITIVE TABLE BLOCKED: ${fullTableName}`);
        } else {
           policy.tables[fullTableName] = {
             allowed: true,
             maskColumns: maskColumns
           };
           console.log(`[+] Table added: ${fullTableName} | PII columns to mask: [${maskColumns.join(', ')}]`);
        }

      } catch (err: any) {
        console.warn(`[!] Could not read table: ${fullTableName} - ${err.message}`);
      }
    }

    const outputPath = path.join(__dirname, '../../policy.zion.json');
    fs.writeFileSync(outputPath, JSON.stringify(policy, null, 2));
    
    console.log(`\nSchema analysis finished. Policy file written: ${outputPath}`);
    
  } catch (err: any) {
    console.error('Connection or analysis error:', err.message);
  } finally {
    await pgConnector.disconnect();
  }
}

main().catch(console.error);
