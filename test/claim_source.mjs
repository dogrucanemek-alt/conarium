#!/usr/bin/env node
/**
 * The rule list has one source. This file locks that, and locks the SOC 2
 * rule being language-independent: "SOC2-konform" must fail, "No SOC 2" must not.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowedOn, CLAIMS_SOURCE, loadRules, scanSurfaces, SURFACES } from './claim_discipline.mjs'

const rules = loadRules(CLAIMS_SOURCE)
assert.equal(rules.length, 14, 'the published list is the thirteen already-caught phrasings plus the automatic-anchor overclaim of 2026-08-20')

const src = readFileSync(fileURLToPath(new URL('./claim_discipline.mjs', import.meta.url)), 'utf8')
const denetciSrc = readFileSync(fileURLToPath(new URL('./denetci.mjs', import.meta.url)), 'utf8')
assert.equal(src.includes('const SURFACES = ['), false, 'claim_discipline.mjs must not carry a second copy of the surface list')
assert.equal(denetciSrc.includes('const SURFACES = ['), false, 'denetci.mjs must not carry a second copy of the surface list')
assert.ok(src.includes('claim_surfaces.mjs'), 'claim_discipline.mjs must load surfaces from the published source')
assert.ok(denetciSrc.includes('claim_surfaces.mjs'), 'denetci.mjs must load surfaces from the published source')
assert.equal(
  SURFACES.length,
  24,
  'twenty-four review documents: twenty-three named in surfaces.json (ADOPTION-EVIDENCE.md joined on 2026-08-23) plus the current draft revision, derived from the tree rather than listed',
)
assert.equal(
  src.includes('const BANNED'),
  false,
  'claim_discipline.mjs must not carry a second copy of the rule list',
)
assert.ok(
  src.includes('docs/claims/retracted-phrasings.json'),
  'the runner must name the published source',
)

const soc2 = rules.find((r) => r.id === 'soc2')
assert.ok(soc2, 'soc2 rule missing from the published list')
assert.equal(soc2.re.source, 'SOC\\s?2', 'SOC 2 must be the word itself, not an English readiness suffix')
assert.ok(soc2.allow, 'SOC 2 must allow the honest denial')

const hits = [
  'SOC2 & GDPR ready',
  'SOC2 & DSGVO-konform',
  'SOC2 et RGPD',
  'SOC2 e GDPR',
  'SOC2和GDPR要求',
  'SOC2 और GDPR तैयार',
  'SOC2 y GDPR',
  'SOC2 и GDPR',
]
for (const line of hits) {
  assert.equal(soc2.re.test(line), true, `SOC 2 rule must see: ${line}`)
  assert.equal(Boolean(soc2.allow && soc2.allow.test(line)), false, `allow must not excuse: ${line}`)
}

const honest = [
  'No SOC 2. No ISO. Neither is planned.',
  'We do not have SOC 2, an external penetration test, or a formal security',
  'SOC 2 yok. ISO yok. İkisi de planlanmıyor.',
  'There is no SOC 2 audit and no independent penetration test',
  'Kein SOC 2 — siehe LIMITATIONS',
  'Pas de SOC 2 — voir LIMITATIONS',
  'Sin SOC 2 — ver LIMITATIONS',
  'Nessun SOC 2 — vedi LIMITATIONS',
  'Нет SOC 2 — см. LIMITATIONS',
  '无SOC 2 — 见 LIMITATIONS',
  'SOC 2 नहीं — LIMITATIONS देखें',
  '**We do not have** SOC 2, an external penetration test, or a formal security',
  'It has <b>no</b> third-party security certification (SOC 2 / ISO). Neither is planned.',
]
for (const line of honest) {
  assert.equal(soc2.re.test(line), true, `SOC 2 word is present: ${line}`)
  assert.equal(allowedOn(line, soc2.allow), true, `allow must pass honest denial: ${line}`)
}

const dir = mkdtempSync(join(tmpdir(), 'conarium-claims-'))
writeFileSync(join(dir, 'LIMITATIONS.md'), 'No SOC 2. No ISO.\n')
writeFileSync(join(dir, 'docs.html'), '<h2>What the production scanner refuses to pretend</h2>\n')
const { failures } = scanSurfaces({
  surfaces: ['LIMITATIONS.md', 'docs.html'],
  rootDir: dir,
  rules,
})
assert.equal(failures.length, 0, `honest LIMITATIONS / docs.html must not trip:\n${failures.join('\n')}`)

const missing = join(dir, 'no-such.json')
assert.throws(() => loadRules(missing), /kural kaynağı yok — paketi güncelle/)

const byId = Object.fromEntries(rules.map((r) => [r.id, r]))
for (const id of ['cert-on-roadmap', 'phones-home', 'no-false-positives', 'node-18-floor']) {
  assert.ok(byId[id], `${id} missing from the published list`)
}

const certHits = [
  'It has no third-party security certification (SOC 2 / ISO) yet — those are on the roadmap',
  'SOC 2 yok. ISO yok. Bağımsız sızma testi yok. Yol haritasında.',
  'SOC2-konform — on the roadmap',
]
for (const line of certHits) {
  assert.equal(byId['cert-on-roadmap'].re.test(line), true, `cert-on-roadmap must see: ${line}`)
  assert.equal(allowedOn(line, byId['cert-on-roadmap'].allow), false, `cert-on-roadmap must not excuse: ${line}`)
}
for (const line of [
  'No SOC 2. No ISO. Neither is planned: they certify organisations that hold',
  'SOC 2 yok. ISO yok. İkisi de planlanmıyor.',
  'No independent penetration test — that one is on the roadmap.',
]) {
  assert.equal(
    byId['cert-on-roadmap'].re.test(line) && !allowedOn(line, byId['cert-on-roadmap'].allow),
    false,
    `cert-on-roadmap must pass honest: ${line}`,
  )
}

assert.equal(byId['phones-home'].re.test('It needs no inbound port and never phones home.'), true)
assert.equal(allowedOn('The only outbound call is an npm version check at startup.', byId['phones-home'].allow), true)

assert.equal(byId['no-false-positives'].re.test('Non-PII text is left intact (no false positives).'), true)
assert.equal(byId['no-false-positives'].re.test('others were false positives and are dismissed'), false)

assert.equal(byId['node-18-floor'].re.test('With Node (≥18)'), true)
assert.equal(byId['node-18-floor'].re.test('With Node (≥20)'), false)
assert.equal(allowedOn('It said >=18 until 2026-08-17, and that was wrong rather than merely unverified', byId['node-18-floor'].allow), true)
assert.equal(allowedOn('on Node 18 the gateway fails at initialize', byId['node-18-floor'].allow), true)

console.log('claim source: 14 rules, one file, SOC 2 language-independent, four 08-18 overclaims locked, automatic-anchor overclaim locked, honest denial allowed, missing source red')
