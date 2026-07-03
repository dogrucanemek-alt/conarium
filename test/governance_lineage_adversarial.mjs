// Adversarial governance regression suite (independent 3rd-eye gate, 2026-06-29).
// These variants are NOT covered by governance_security_regression.mjs — they
// target dolambaçlı bypass paths (expression lineage, quoted/case identifiers,
// JOIN/subquery reach, fail-closed parse handling). Every case here is a bug we
// must never reintroduce; keep them green.
import assert from 'assert/strict'
import { Governance, PolicyError } from '../dist/governance.js'

let pass = 0, fail = 0
const results = []
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); pass++ }
  catch (e) { results.push(['FAIL', name, e.message]); fail++ }
}
function maskedFor(sql, policy) {
  const r = new Governance(policy).guardQuery(sql)
  return (r.metadata?.maskedFields ?? []).map(s => s.toLowerCase())
}
function expectDenied(sql, policy) {
  try { new Governance(policy).guardQuery(sql); throw new Error('NO ERROR (expected denial)') }
  catch (e) { if (!(e instanceof PolicyError)) throw e }
}
function rewritten(sql, policy) {
  return new Governance(policy).guardQuery(sql).sql.toUpperCase()
}

const P = { allowTables: ['public.customers', 'public.c'], maskColumns: ['email'] }

// --- PII LINEAGE: a masked source column must stay masked through transforms ---
check('lineage: CASE WHEN .. THEN email', () =>
  assert.ok(maskedFor("SELECT CASE WHEN id>0 THEN email ELSE null END AS leak FROM public.customers", P).includes('leak')))
check('lineage: concat email || x', () =>
  assert.ok(maskedFor("SELECT email || 'x' AS leak FROM public.customers", P).includes('leak')))
check('lineage: COALESCE(email, ...)', () =>
  assert.ok(maskedFor("SELECT COALESCE(email, 'n/a') AS leak FROM public.customers", P).includes('leak')))
check('lineage: scalar subquery selecting email', () =>
  assert.ok(maskedFor("SELECT (SELECT email FROM public.customers LIMIT 1) AS leak FROM public.customers", P).includes('leak')))
check('lineage: through CTE alias', () =>
  assert.ok(maskedFor("WITH c AS (SELECT email AS e FROM public.customers) SELECT e AS leak FROM c", P).includes('leak')))
check('lineage: quoted output identifier', () =>
  assert.ok(maskedFor('SELECT email AS "Leak" FROM public.customers', P).includes('leak')))

// --- DENY / ALLOW: no schema/quoting/JOIN/function trick reaches a forbidden table ---
check('deny: quoted schema-qualified denied table', () =>
  expectDenied('SELECT * FROM "secret"."customers"', { denyTables: ['secret.customers'] }))
check('deny: uppercase schema confusion', () =>
  expectDenied('SELECT * FROM SECRET.CUSTOMERS', { allowTables: ['public.customers'] }))
check('deny: denied table via JOIN', () =>
  expectDenied('SELECT * FROM public.customers c JOIN secret.audit a ON true', { allowTables: ['public.customers'] }))
check('deny: function in JOIN', () =>
  expectDenied('SELECT * FROM public.customers c JOIN public.get_secret() g ON true', { allowTables: ['public.customers'] }))
check('deny: function in WHERE subquery FROM', () =>
  expectDenied('SELECT * FROM public.customers WHERE id IN (SELECT * FROM public.leak())', { allowTables: ['public.customers'] }))

// --- ROW CAP / FAIL-CLOSED ---
check('limit: plain WITH gets LIMIT on executable SELECT', () =>
  assert.ok(rewritten("WITH c AS (SELECT 1 AS n) SELECT n FROM c", { allowTables: ['public.c'], maxRows: 50 }).includes('LIMIT')))
check('limit: a smaller caller LIMIT is respected, never RAISED to the cap', () =>
  assert.ok(rewritten("SELECT id FROM public.customers LIMIT 1", { allowTables: ['public.customers'], maxRows: 50 }).includes('LIMIT (1)')))
check('limit: a LARGER caller LIMIT is clamped down to the cap', () =>
  assert.ok(rewritten("SELECT id FROM public.customers LIMIT 9999", { allowTables: ['public.customers'], maxRows: 50 }).includes('LIMIT (50)')))
check('fail-closed: unparseable WITH RECURSIVE is denied, never passed through', () =>
  expectDenied("WITH RECURSIVE c AS (SELECT 1 AS n UNION SELECT n+1 FROM c) SELECT n FROM c", { maxRows: 50 }))

for (const r of results) console.log(r.join('  ::  '))
console.log(`\nSummary: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
