/**
 * Beyan listesi — her PII sınıfı için bir kanonik örnek.
 * Bir sınıf buradan düşerse test kırmızı yanar. Paket #14 telefonu
 * yazmadığı için 0.2.5 adayı 0532…'yi açık bıraktı ve 288 test yeşildi.
 *
 * KIRMA: classifyDigitRun'da `first === '0'` dalını sil → satır
 * `tr-cep` / `tr-sabit` / `tr-cep-bare` kırmızı
 * (`tel 05321234567` açık kalır).
 */
import assert from 'assert/strict'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const govJs = path.join(here, '..', 'dist', 'governance.js')
assert.ok(existsSync(govJs), 'dist/governance.js missing — test:checks runs build first')

const { Governance } = await import(pathToFileURL(govJs).href)
const { mrzCheckDigit } = await import(pathToFileURL(path.join(here, '..', 'dist', 'mrz.js')).href)
const gov = new Governance({ allowTables: ['public.notes'], maskColumns: [] })

function buildTd3() {
  const name = 'ERIKSSON<<ANNA<MARIA'.padEnd(39, '<')
  const line1 = `P<UTO${name}`
  const passport = 'L898902C3'
  const nat = 'UTO'
  const birth = '740812'
  const sex = 'F'
  const expiry = '120415'
  const personal = 'ZE184226B'.padEnd(14, '<')
  const body =
    passport +
    mrzCheckDigit(passport) +
    nat +
    birth +
    mrzCheckDigit(birth) +
    sex +
    expiry +
    mrzCheckDigit(expiry) +
    personal +
    mrzCheckDigit(personal)
  const composite = body.slice(0, 10) + body.slice(13, 20) + body.slice(21)
  const line2 = body + mrzCheckDigit(composite)
  return `${line1}\n${line2}`
}

const mrz = buildTd3()
const mrzBad = (() => {
  const [a, b] = mrz.split('\n')
  return `${a}\n${b.slice(0, 9)}${(Number(b[9]) + 1) % 10}${b.slice(10)}`
})()

const IP_ON = { allowTables: ['public.notes'], maskColumns: [], detectors: { ip: true } }

const TR = 'TR330006100519786457841326'
const DE = 'DE89370400440532013000'
const helloB64 = Buffer.from('merhaba dunya bugun hava cok guzel').toString('base64')
const sha = createHash('sha256').update('conarium').digest('hex')
const fullTckn = '12345678901'
  .split('')
  .map((d) => String.fromCharCode(0xff10 + Number(d)))
  .join('')

const rows = [
  { id: 'tr-cep', input: 'tel 05321234567', masked: 'tel [MASKED_PII]', count: 1 },
  { id: 'tr-sabit', input: 'tel 02321234567', masked: 'tel [MASKED_PII]', count: 1 },
  { id: 'tr-cep-bare', input: '05321234567', masked: '[MASKED_PII]', count: 1 },
  { id: 'tr-cep-plus90', input: 'tel +905321234567', masked: 'tel [MASKED_PII]', count: 1 },
  {
    id: 'tr-cep-in-sentence',
    input: 'Musteri: Ahmet, tel: 05321234567, siparis 12345',
    masked: 'Musteri: [MASKED_PII], tel: [MASKED_PII], siparis 12345',
    count: 2,
  },
  { id: 'tckn', input: '12345678901', masked: '[MASKED_PII]', count: 1 },
  { id: 'card-luhn', input: '4111111111111111', masked: '[MASKED_PII]', count: 1 },
  { id: 'iban', input: `havale ${TR} tamam`, masked: 'havale [MASKED_PII] tamam', count: 1 },
  {
    id: 'two-iban',
    input: `${TR} ve ${DE} ayni.`,
    masked: '[MASKED_PII] ve [MASKED_PII] ayni.',
    count: 2,
  },
  { id: 'email', input: 'yaz patron@sirket.com', masked: 'yaz [MASKED_PII]', count: 1 },
  {
    id: 'zwsp-iban',
    input: 'havale TR33\u200b0006100519786457841326 tamam',
    masked: 'havale [MASKED_PII] tamam',
    count: 1,
  },
  {
    id: 'zwsp-email',
    input: 'yaz patron\u200b@sirket.com',
    masked: 'yaz [MASKED_PII]',
    count: 1,
  },
  { id: 'homoglyph-at', input: 'yaz patron＠sirket.com', masked: 'yaz [MASKED_PII]', count: 1 },
  { id: 'fullwidth-tckn', input: `tckn ${fullTckn}`, masked: 'tckn [MASKED_PII]', count: 1 },
  { id: 'labelled-name', input: 'Yetkili: Ayse Demir', masked: 'Yetkili: [MASKED_PII]', count: 1 },
  { id: 'order-20', input: '12345678901234567890', masked: '12345678901234567890', count: 0 },
  { id: 'luhn-false-16', input: '1234567890123456', masked: '1234567890123456', count: 0 },
  { id: 'date-amount', input: '13.08.2026 tarihli 45000 TL', masked: '13.08.2026 tarihli 45000 TL', count: 0 },
  { id: 'sha256', input: `digest ${sha}`, masked: `digest ${sha}`, count: 0 },
  { id: 'b64-selam', input: `encoded: ${helloB64}`, masked: `encoded: ${helloB64}`, count: 0 },
  { id: 'email-entity', input: 'yaz patron&#64;sirket.com', masked: 'yaz [MASKED_PII]', count: 1 },
  { id: 'email-json-escape', input: 'yaz patron\\u0040sirket.com', masked: 'yaz [MASKED_PII]', count: 1 },
  { id: 'email-pct', input: 'yaz patron%40sirket.com', masked: 'yaz [MASKED_PII]', count: 1 },
  { id: 'entity-not-email', input: '5&#64; magaza', masked: '5&#64; magaza', count: 0 },
  { id: 'ipv4-off-default', input: 'src 192.0.2.1 dst', masked: 'src 192.0.2.1 dst', count: 0 },
  {
    id: 'ipv4-on',
    policy: IP_ON,
    input: 'src 192.0.2.1 dst',
    masked: 'src [MASKED_PII] dst',
    count: 1,
  },
  {
    id: 'ipv6-on',
    policy: IP_ON,
    input: 'peer 2001:db8::1 ok',
    masked: 'peer [MASKED_PII] ok',
    count: 1,
  },
  {
    id: 'date-not-ipv4-when-ip-on',
    policy: IP_ON,
    input: '13.08.2026 tarihli 45000 TL',
    masked: '13.08.2026 tarihli 45000 TL',
    count: 0,
  },
  {
    id: 'version-is-ipv4-when-ip-on',
    policy: IP_ON,
    input: 'version 1.2.3.4',
    masked: 'version [MASKED_PII]',
    count: 1,
  },
  { id: 'mrz-td3', input: mrz, masked: '[MASKED_PII]', count: 1 },
  { id: 'mrz-checksum-fail', input: mrzBad, masked: mrzBad, count: 0 },
]

let pass = 0
let fail = 0
for (const row of rows) {
  try {
    const g = row.policy ? new Governance(row.policy) : gov
    const r = g.maskPII(row.input)
    assert.equal(r.masked, row.masked, `${row.id} masked`)
    assert.equal(r.count, row.count, `${row.id} count`)
    if (row.count > 0) {
      assert.doesNotMatch(String(r.masked), /\d\[MASKED_PII\]/, `${row.id} no prefix glued to mask`)
    }
    pass++
    console.log(`PASS  ::  ${row.id}`)
  } catch (err) {
    fail++
    console.log(`FAIL  ::  ${row.id}\n        ${err.message}`)
  }
}

console.log(`\nSummary: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
