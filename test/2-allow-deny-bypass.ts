import { Governance } from '../src/governance.js'

// 2. ALLOW/DENY BYPASS
// Zafiyet: guardQuery() fonksiyonu sadece "DROP, INSERT" gibi WRITE tokenlarını engelliyor.
// Hangi tablodan veri çekildiğini (FROM yasakli_tablo) kontrol ETMİYOR.
// filterTables() sadece yapay zekanın tablo listesini görmesini (şema keşfini) engelliyor,
// ama AI tablo adını biliyorsa veya tahmin ederse "SELECT * FROM yasakli_tablo" yazdığında sorgu çalışır!

const policy = {
  denyTables: ['secret_salaries', 'top_secret_*']
}
const gov = new Governance(policy)

const maliciousQuery = "SELECT * FROM secret_salaries"

console.log("=== ALLOW/DENY BYPASS TEST ===")
console.log("Policy denied tables:", policy.denyTables)
console.log("Malicious Query:", maliciousQuery)

let bypassed = false
try {
  gov.guardQuery(maliciousQuery)
  bypassed = true
} catch (e: any) {
  console.log("Guard caught it:", e.message)
}

console.log("BYPASS SUCCESS?", bypassed ? "YES (Query allowed to run!)" : "NO")
