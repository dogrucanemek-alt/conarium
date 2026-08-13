#!/usr/bin/env node
/**
 * Demoyu kosturmus bir makinede `npm publish` calisirsa ne gider?
 *
 * 08-13'te olculdu: `files` izin listesinde "examples" oldugu icin
 * examples/demo-bank/_keys/audit-ed25519.pem (OZEL IMZA ANAHTARI) ve
 * conarium-receipts.jsonl tarball'a giriyordu. .gitignore npm'i baglamaz;
 * git temiz gorunurken paket kirliydi. README de "not in the npm tarball"
 * diyordu, yani beyan da yanlisti.
 *
 * Bu test artefaktlari GERCEKTEN uretip `npm pack --dry-run --json` ciktisina
 * bakar. test-vectors/ altindaki receipts.jsonl ve .pub.pem ise girmek
 * ZORUNDA: elemenin fazla genis olmadigi da burada kilitlenir.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const demo = join(root, 'examples', 'demo-bank')
const keysDir = join(demo, '_keys')
const artefacts = [
  join(keysDir, 'audit-ed25519.pem'),
  join(keysDir, 'audit-ed25519.pub.pem'),
  join(keysDir, 'audit-ed25519.pub.pem.keyid'),
  join(demo, 'conarium-receipts.jsonl'),
  join(demo, 'conarium-audit.jsonl'),
]

let failed = 0
const pass = (m) => console.log(`PASS  ${m}`)
const fail = (m) => {
  console.error(`FAIL  ${m}`)
  failed++
}

const preexisting = artefacts.filter((p) => existsSync(p))
if (preexisting.length) {
  console.error(`refusing to run: ${preexisting[0]} already exists — bu test kendi urettigini siler`)
  process.exit(2)
}

mkdirSync(keysDir, { recursive: true })
for (const p of artefacts) writeFileSync(p, 'SAHTE-ARTEFAKT-TEST\n')

try {
  // Node 20+ Windows'ta .cmd dosyasini shell olmadan calistirmiyor (EINVAL/ENOENT).
  const win = process.platform === 'win32'
  const res = spawnSync(win ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: win,
  })
  // ⛔ Burada process.exit() YOK: finally'yi atlar ve uretilen OZEL ANAHTARI
  // repoda birakir. Anahtar birakmaya karsi yazilmis test, anahtar birakamaz.
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout || '(cikti yok)')
    throw new Error('npm pack --dry-run basarisiz')
  }
  const files = JSON.parse(res.stdout)[0].files.map((f) => f.path.replace(/\\/g, '/'))

  const leaked = files.filter((f) => f.startsWith('examples/') && /_keys\/|\.jsonl$|\.pem$|\.keyid$/.test(f))
  if (leaked.length) fail(`uretilmis artefakt tarball'da: ${leaked.join(', ')}`)
  else pass('examples/ altindaki anahtar ve JSONL artefaktlari tarball disinda')

  // Sinif kontrolu, ornek kontrolu DEGIL. 08-13'te examples/ altindaki sizinti
  // kapatildi ama ayni delik test-vectors/ altinda duruyordu: git .gitignore ile
  // ozel anahtari diskaridi tutuyor, npm ise `files` izin listesi yuzunden onu
  // pakete koyuyordu. 0.2.0 YAYINLANDI ve icinde bir BEGIN PRIVATE KEY vardi —
  // ustelik ayni pakette giden test-vectors/README.md "ozel yarisi yayinlanmadi
  // ve yayinlanmayacak" diyordu. Paket kendi belgesini yalanlamayacak.
  const privateKeys = files.filter((f) => f.endsWith('.pem') && !f.endsWith('.pub.pem'))
  if (privateKeys.length) fail(`pakette OZEL ANAHTAR var: ${privateKeys.join(', ')}`)
  else pass('pakette tek bir ozel anahtar yok (yalnizca *.pub.pem)')

  const publicKey = files.filter((f) => f.endsWith('vector-key.pub.pem') || f.endsWith('vector-key.pub.pem.keyid'))
  if (publicKey.length !== 2) {
    fail(`vektor ACIK anahtari ve keyid yan dosyasi pakette olmali (bulunan: ${publicKey.length}) — yoksa dogrulayici her vektore 13 der`)
  } else pass('vektorlerin acik anahtari + keyid yan dosyasi yerinde')

  const demoFiles = files.filter((f) => f.startsWith('examples/demo-bank/'))
  const expected = ['conarium.config.json', 'docker-compose.yml', 'prove-mask.mjs', 'prove-receipt.mjs', 'README.md', 'seed.sql']
  const missing = expected.filter((e) => !demoFiles.includes(`examples/demo-bank/${e}`))
  if (missing.length) fail(`eleme fazla genis, demo dosyasi dusuruldu: ${missing.join(', ')}`)
  else pass('demo paketinin 6 kaynak dosyasi tarball\'da duruyor')

  const vectorReceipts = files.filter((f) => f.startsWith('test-vectors/') && f.endsWith('.jsonl'))
  const vectorKeys = files.filter((f) => f.startsWith('test-vectors/') && (f.endsWith('.pub.pem') || f.endsWith('.keyid')))
  if (!vectorReceipts.length) fail('test-vectors/*.jsonl tarball\'dan dustu — ucuncu taraf vektorleri kosturamaz')
  else if (!vectorKeys.length) fail('test-vectors acik anahtari/keyid dustu — dogrulayici her makbuza 13 der')
  else pass(`konformans vektorleri etkilenmedi (${vectorReceipts.length} jsonl, ${vectorKeys.length} anahtar dosyasi)`)
} catch (e) {
  fail(e.message)
} finally {
  rmSync(keysDir, { recursive: true, force: true })
  rmSync(join(demo, 'conarium-receipts.jsonl'), { force: true })
  rmSync(join(demo, 'conarium-audit.jsonl'), { force: true })
  const left = artefacts.filter((p) => existsSync(p))
  if (left.length) fail(`temizlik eksik, artefakt kaldi: ${left.join(', ')}`)
}

console.log(`\npack artefakt testleri: ${failed === 0 ? 'hepsi gecti' : `${failed} basarisiz`}`)
process.exit(failed === 0 ? 0 : 1)
