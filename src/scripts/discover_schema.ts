import { PostgresConnector } from '../connectors/postgres.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('👁️ CONARIUM ŞEMA KEŞİF (SCHEMA DISCOVERY) MOTORU BAŞLATILIYOR... 👁️\n');

  const connectionString = process.env.ZION_READONLY_DSN;
  if (!connectionString) {
    console.error('HATA: ZION_READONLY_DSN ortam değişkeni bulunamadı.');
    console.error('Lütfen çalıştırmadan önce DSN i tanımlayın.');
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
    console.log('✅ ZION veritabanına bağlanıldı.');

    const tables = await pgConnector.listTables();
    console.log(`✅ ${tables.length} tablo bulundu. Şemalar analiz ediliyor...\n`);

    const policy: any = {
      maxRowsPerQuery: 100,
      tables: {},
      defaultPolicy: "deny"
    };

    const piiKeywords = ['email', 'mail', 'telefon', 'phone', 'tel', 'adres', 'address', 'tc', 'kimlik', 'ssn', 'kart', 'card', 'password', 'sifre', 'secret'];
    const sensitiveTableKeywords = ['finans', 'kredi', 'maas', 'sifre', 'secret', 'bilanco', 'muhasebe', 'salary', 'finance', 'password', 'token'];

    for (const table of tables) {
      const fullTableName = `${table.schema}.${table.name}`;
      try {
        const desc = await pgConnector.describeTable(fullTableName);
        
        // PII içeren kolonları otomatik bul
        const maskColumns = desc.columns
          .filter(c => piiKeywords.some(keyword => c.name.toLowerCase().includes(keyword)))
          .map(c => c.name);

        // Hassas tablo ismi kontrolü (varsa direkt DENY)
        const isSensitive = sensitiveTableKeywords.some(keyword => table.name.toLowerCase().includes(keyword));

        if (isSensitive) {
           policy.tables[fullTableName] = {
             allowed: false
           };
           console.log(`[!] HASSAS TABLO BLOKLANDI: ${fullTableName}`);
        } else {
           policy.tables[fullTableName] = {
             allowed: true,
             maskColumns: maskColumns
           };
           console.log(`[+] Tablo eklendi: ${fullTableName} | Maskelenecek PII Kolonları: [${maskColumns.join(', ')}]`);
        }

      } catch (err: any) {
        console.warn(`[!] Tablo okunamadı: ${fullTableName} - ${err.message}`);
      }
    }

    const outputPath = path.join(__dirname, '../../policy.zion.json');
    fs.writeFileSync(outputPath, JSON.stringify(policy, null, 2));
    
    console.log(`\n🎉 Şema analizi tamamlandı! Mükemmel policy dosyası oluşturuldu: ${outputPath}`);
    
  } catch (err: any) {
    console.error('❌ Bağlantı veya analiz hatası:', err.message);
  } finally {
    await pgConnector.disconnect();
  }
}

main().catch(console.error);
