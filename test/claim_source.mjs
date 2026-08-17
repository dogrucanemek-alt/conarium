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
import { allowedOn, CLAIMS_SOURCE, loadRules, scanSurfaces } from './claim_discipline.mjs'

const rules = loadRules(CLAIMS_SOURCE)
assert.equal(rules.length, 9, 'the published list must stay at the nine already-caught phrasings')

const src = readFileSync(fileURLToPath(new URL('./claim_discipline.mjs', import.meta.url)), 'utf8')
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
  'No SOC 2. No ISO. No independent penetration test. On the roadmap.',
  'We do not have SOC 2, an external penetration test, or a formal security',
  'SOC 2 yok. ISO yok. Bağımsız sızma testi yok. Yol haritasında.',
  'It has no third-party security certification (SOC 2 / ISO) yet — those are on the roadmap',
  'There is no SOC 2 audit and no independent penetration test',
  'Kein SOC 2 — siehe LIMITATIONS',
  'Pas de SOC 2 — voir LIMITATIONS',
  'Sin SOC 2 — ver LIMITATIONS',
  'Nessun SOC 2 — vedi LIMITATIONS',
  'Нет SOC 2 — см. LIMITATIONS',
  '无SOC 2 — 见 LIMITATIONS',
  'SOC 2 नहीं — LIMITATIONS देखें',
  '**We do not have** SOC 2, an external penetration test, or a formal security',
  'It has <b>no</b> third-party security certification (SOC 2 / ISO) yet — those are on the roadmap',
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

console.log('claim source: 9 rules, one file, SOC 2 language-independent, honest denial allowed, missing source red')
