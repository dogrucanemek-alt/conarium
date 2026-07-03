import { Audit } from '../src/audit.js'

// 4. AUDIT BÜTÜNLÜĞÜ (LOG FORGERY / BLINDNESS)
// Zafiyet: index.ts içinde "audit.log(...)" fonksiyonu çağrılırken, AI'nin çalıştırdığı GERÇEK SQL SORGU METNİ (sql: a.sql) loga YAZILMIYOR!
// Sadece "tool: 'query', rowsReturned: X" yazılıyor.
// Yani AI "SELECT * FROM public_data" de yapsa, "SELECT credit_card FROM secret_vault" de yapsa, logda ikisi de tamamen aynı görünüyor!
// Bu tam bir körlüktür. Uyum görevlisi (compliance officer) ne sorulduğunu asla bilemez.

const mockAuditSink = []
class MockAudit extends Audit {
  constructor() {
    super()
  }
  log(entry: any) {
    mockAuditSink.push(entry)
  }
}

const audit = new MockAudit()

// Senaryo 1: Masum sorgu
const innocentQuery = "SELECT name FROM users"
audit.log({ tool: 'query', target: 'postgres', rowsReturned: 5, denied: false })

// Senaryo 2: Veri çalma sorgusu
const maliciousQuery = "SELECT credit_card FROM secrets"
audit.log({ tool: 'query', target: 'postgres', rowsReturned: 5, denied: false })

console.log("=== AUDIT BLINDNESS BYPASS TEST ===")
console.log("Innocent Query:", innocentQuery)
console.log("Malicious Query:", maliciousQuery)
console.log("Audit Log 1:", mockAuditSink[0])
console.log("Audit Log 2:", mockAuditSink[1])

const isBlind = JSON.stringify(mockAuditSink[0]) === JSON.stringify(mockAuditSink[1])
console.log("BYPASS SUCCESS?", isBlind ? "YES (Queries are indistinguishable in logs!)" : "NO")
