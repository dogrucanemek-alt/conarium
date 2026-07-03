import { Governance } from '../src/governance.js'

// 1. PII MASKELEME BYPASS
// Zafiyet: Governance, dönen veride sütun isimlerine (keys) bakarak maskeleme yapıyor. 
// SQL içinde "SELECT email AS contact_info" yaparsak, dönen key "contact_info" olur.
// Maskeleme regex'i "contact_info"yu mask listesinde (*.email vs) bulamadığı için PII açıkta kalır.

const policy = {
  maskColumns: ['*.email', '*.tckn']
}
const gov = new Governance(policy)

const mockDbResult = {
  sql: "SELECT email AS contact_info FROM customers",
  rowCount: 1,
  fields: ["contact_info"],
  rows: [
    { _table: "customers", contact_info: "patron@sirket.com" }
  ]
}

const redacted = gov.redact(mockDbResult)
console.log("=== PII BYPASS TEST ===")
console.log("Policy masks:", policy.maskColumns)
console.log("SQL Query:", mockDbResult.sql)
console.log("Result:", redacted.rows[0])
console.log("BYPASS SUCCESS?", redacted.rows[0].contact_info === "patron@sirket.com" ? "YES (PII leaked!)" : "NO")
