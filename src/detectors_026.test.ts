/**
 * 0.2.6 — scan cap, detector toggles, IP, encoded @, MRZ, split TCKN.
 */
import { describe, expect, it } from 'vitest'
import { Governance } from './governance.js'
import { parseConariumConfig } from './config.js'
import { PII_SCAN_CHAR_CAP, resolveScanCharCap } from './digit_pii.js'
import { IPV4_OCTET_MAX, isStrictIpv4, isStrictIpv6, maskIps } from './ip_detect.js'
import { isTd3Mrz, maskMrz, mrzCheckDigit } from './mrz.js'
import { maskSplitTcknFields, tcknChecksumOk } from './tckn.js'
import { maskEntityEncodedEmails } from './digit_pii.js'

function buildTd3Fixture(): { line1: string; line2: string } {
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
  return { line1, line2: body + mrzCheckDigit(composite) }
}

const BASE = {
  connectors: [
    { type: 'docs' as const, name: 'docs', description: 'fixture', config: { path: './docs' } },
  ],
}

const gov = new Governance({ allowTables: ['public.notes'], maskColumns: [] })
const govIp = new Governance({
  allowTables: ['public.notes'],
  maskColumns: [],
  detectors: { ip: true },
})

describe('G0 — scanCharCap', () => {
  it('default cap still fail-closes on oversize', () => {
    expect(resolveScanCharCap(undefined)).toBe(PII_SCAN_CHAR_CAP)
    const big = 'merhaba dunya '.repeat(1300)
    expect(big.length).toBeGreaterThan(PII_SCAN_CHAR_CAP)
    const r = gov.maskPII(big)
    expect(r.masked).toBe('[MASKED_PII]')
    expect(r.count).toBe(1)
  })

  it('policy.scanCharCap raises the ceiling; oversize still masks', () => {
    const g = new Governance({
      allowTables: ['public.notes'],
      maskColumns: [],
      scanCharCap: 32,
    })
    expect(g.maskPII('hello').masked).toBe('hello')
    const r = g.maskPII('x'.repeat(33))
    expect(r.masked).toBe('[MASKED_PII]')
    expect(r.count).toBe(1)
  })

  it('raising the cap lets a long non-PII field through', () => {
    const text = 'merhaba dunya '.repeat(1300)
    expect(text.length).toBeGreaterThan(PII_SCAN_CHAR_CAP)
    const g = new Governance({
      allowTables: ['public.notes'],
      maskColumns: [],
      scanCharCap: 50_000,
    })
    const r = g.maskPII(text)
    expect(r.masked).toBe(text)
    expect(r.count).toBe(0)
  })

  it('CONARIUM_SCAN_CHAR_CAP overrides policy in resolveScanCharCap', () => {
    const prev = process.env.CONARIUM_SCAN_CHAR_CAP
    process.env.CONARIUM_SCAN_CHAR_CAP = '20'
    try {
      expect(resolveScanCharCap(100_000)).toBe(20)
    } finally {
      if (prev === undefined) delete process.env.CONARIUM_SCAN_CHAR_CAP
      else process.env.CONARIUM_SCAN_CHAR_CAP = prev
    }
  })

  it('Zod accepts scanCharCap and detectors.ip / detectors.mrz', () => {
    const cfg = parseConariumConfig({
      ...BASE,
      policy: { scanCharCap: 32_768, detectors: { ip: true, mrz: false } },
    })
    expect(cfg.policy?.scanCharCap).toBe(32_768)
    expect(cfg.policy?.detectors?.ip).toBe(true)
    expect(cfg.policy?.detectors?.mrz).toBe(false)
  })

  it('detectors: { tckn: false } is rejected — identity cannot be switched off', () => {
    expect(() =>
      parseConariumConfig({
        ...BASE,
        policy: { detectors: { tckn: false } },
      }),
    ).toThrow(/Unrecognized key/)
  })

  it('detectors: { email: false } / card / iban are rejected too', () => {
    for (const key of ['email', 'card', 'iban', 'phone', 'pan']) {
      expect(() =>
        parseConariumConfig({
          ...BASE,
          policy: { detectors: { [key]: false } },
        }),
        key,
      ).toThrow(/Unrecognized key/)
    }
  })
})

describe('G1 — IP (default off)', () => {
  it('IPv4 is left in the clear when ip is unset', () => {
    const r = gov.maskPII('src 192.0.2.1 dst')
    expect(r.masked).toBe('src 192.0.2.1 dst')
    expect(r.count).toBe(0)
  })

  it('IPv4 is masked when detectors.ip is true', () => {
    const r = govIp.maskPII('src 192.0.2.1 dst')
    expect(r.masked).toBe('src [MASKED_PII] dst')
    expect(r.count).toBe(1)
  })

  it('IPv6, :: compression, mapped, loopback — masked only when on', () => {
    for (const ip of ['2001:db8::1', '::1', '::ffff:192.0.2.1', '127.0.0.1', '10.0.0.5']) {
      expect(gov.maskPII(ip).count, ip).toBe(0)
      expect(govIp.maskPII(ip).masked, ip).toBe('[MASKED_PII]')
    }
  })

  it('false positives: date, amount, leading-zero, five-octet, 256', () => {
    expect(isStrictIpv4('13.08.2026')).toBe(false)
    expect(isStrictIpv4('01.2.3.4')).toBe(false)
    expect(isStrictIpv4('256.1.1.1')).toBe(false)
    expect(isStrictIpv4('192.0.2.1')).toBe(true)
    expect(govIp.maskPII('13.08.2026 tarihli 45000 TL').count).toBe(0)
    expect(govIp.maskPII('tutar 1.250,00').count).toBe(0)
    expect(govIp.maskPII('host 11.22.33.44.55').count).toBe(0)
    expect(govIp.maskPII('01.2.3.4').count).toBe(0)
  })

  it('version 1.2.3.4 is structurally IPv4 — masked when ip is on (documented)', () => {
    expect(isStrictIpv4('1.2.3.4')).toBe(true)
    expect(govIp.maskPII('version 1.2.3.4').masked).toBe('version [MASKED_PII]')
    expect(gov.maskPII('version 1.2.3.4').masked).toBe('version 1.2.3.4')
  })

  it('KIRMA: octet ceiling is 255 — 256.1.1.1 is not an address', () => {
    expect(IPV4_OCTET_MAX).toBe(255)
    expect(isStrictIpv4('255.255.255.255')).toBe(true)
    expect(isStrictIpv4('256.1.1.1')).toBe(false)
    expect(maskIps('256.1.1.1').count).toBe(0)
  })

  it('mapped IPv6 rejects a leading-zero IPv4 tail', () => {
    expect(isStrictIpv6('::ffff:01.2.3.4')).toBe(false)
    expect(isStrictIpv6('::ffff:192.0.2.1')).toBe(true)
  })
})

describe('G2 — encoded @ is scan-only', () => {
  it('entity / json / percent emails mask; non-email encodings stay', () => {
    expect(gov.maskPII('yaz patron&#64;sirket.com').masked).toBe('yaz [MASKED_PII]')
    expect(gov.maskPII('yaz patron\\u0040sirket.com').masked).toBe('yaz [MASKED_PII]')
    expect(gov.maskPII('yaz patron%40sirket.com').masked).toBe('yaz [MASKED_PII]')
    expect(gov.maskPII('5&#64; magaza').masked).toBe('5&#64; magaza')
    expect(gov.maskPII('C:\\path\\u0040abc').masked).toBe('C:\\path\\u0040abc')
    expect(gov.maskPII('fiyat 5&#64; magaza').count).toBe(0)
  })

  it('does not chase &amp;#64;', () => {
    const r = gov.maskPII('yaz patron&amp;#64;sirket.com')
    expect(r.masked).toBe('yaz patron&amp;#64;sirket.com')
    expect(r.count).toBe(0)
  })

  it('KIRMA: dropping \\u0040 / %40 from the encoded-at class leaves those emails', () => {
    const json = maskEntityEncodedEmails('yaz patron\\u0040sirket.com')
    expect(json.text).toBe('yaz [MASKED_PII]')
    const pct = maskEntityEncodedEmails('yaz patron%40sirket.com')
    expect(pct.text).toBe('yaz [MASKED_PII]')
  })
})

describe('G3 — MRZ TD3', () => {
  const { line1, line2 } = buildTd3Fixture()
  const block = `${line1}\n${line2}`

  it('fixture is 2×44 and checksums', () => {
    expect(line1).toHaveLength(44)
    expect(line2).toHaveLength(44)
    expect(isTd3Mrz(line1, line2)).toBe(true)
    expect(mrzCheckDigit(line2.slice(0, 9))).toBe(line2[9])
  })

  it('valid TD3 is masked (mrz default on)', () => {
    const r = gov.maskPII(`pasaport\n${block}`)
    expect(r.masked).toBe('pasaport\n[MASKED_PII]')
    expect(r.count).toBe(1)
  })

  it('checksum-fail TD3 is left alone', () => {
    const badLine2 =
      line2.slice(0, 9) + ((Number(line2[9]) + 1) % 10).toString() + line2.slice(10)
    expect(isTd3Mrz(line1, badLine2)).toBe(false)
    const r = gov.maskPII(`${line1}\n${badLine2}`)
    expect(r.masked).toBe(`${line1}\n${badLine2}`)
    expect(r.count).toBe(0)
  })

  it('random 44-char lines are not MRZ', () => {
    const a = 'P<' + 'A'.repeat(42)
    const b = 'A'.repeat(44)
    expect(gov.maskPII(`${a}\n${b}`).count).toBe(0)
  })

  it('detectors.mrz false leaves a valid TD3', () => {
    const g = new Governance({
      allowTables: ['public.notes'],
      maskColumns: [],
      detectors: { mrz: false },
    })
    expect(g.maskPII(block).masked).toBe(block)
  })

  it('KIRMA: maskMrz without checksum would still fire — production does not', () => {
    const bad = line2.slice(0, 9) + ((Number(line2[9]) + 1) % 10).toString() + line2.slice(10)
    expect(maskMrz(`${line1}\n${bad}`).count).toBe(0)
    expect(maskMrz(block).count).toBe(1)
  })
})

describe('G4a — split TCKN on similar keys', () => {
  it('10000000146 checksum holds; 12345678901 does not', () => {
    expect(tcknChecksumOk('10000000146')).toBe(true)
    expect(tcknChecksumOk('12345678901')).toBe(false)
  })

  it('tckn_1 + tckn_2 with a valid join are masked on the row', () => {
    const result = gov.redact({
      rows: [{ tckn_1: '10000', tckn_2: '000146', note: 'ok' }],
      rowCount: 1,
      fields: ['tckn_1', 'tckn_2', 'note'],
    })
    expect(result.rows[0].tckn_1).toBe('[MASKED_PII]')
    expect(result.rows[0].tckn_2).toBe('[MASKED_PII]')
    expect(result.rows[0].note).toBe('ok')
  })

  it('checksum-fail split (12345+678901) is left', () => {
    const result = gov.redact({
      rows: [{ tckn_1: '12345', tckn_2: '678901' }],
      rowCount: 1,
      fields: ['tckn_1', 'tckn_2'],
    })
    expect(result.rows[0].tckn_1).toBe('12345')
    expect(result.rows[0].tckn_2).toBe('678901')
  })

  it('unrelated keys are not combined', () => {
    const row = { tckn: '10000', phone: '000146' }
    const r = maskSplitTcknFields(row)
    expect(r.count).toBe(0)
    expect(row.tckn).toBe('10000')
  })
})
