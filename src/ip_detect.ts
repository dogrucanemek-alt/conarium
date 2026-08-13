/**
 * Structural IP detector. Opt-in (`policy.detectors.ip === true`).
 *
 * IPv4 is parsed here, not via `net.isIP`: Node accepts a leading zero
 * (`01.2.3.4`) which we reject. Octets are 0–255 with no leading zeros
 * except the value `0`.
 *
 * Version / IP collision: `1.2.3.4` is a valid IPv4 address. There is no
 * deterministic way to tell it from a four-part version number. When the
 * detector is on, it is masked. Dates (`13.08.2026`) fail the leading-zero
 * rule; amounts (`1.250,00`) are not four dotted octets. Loopback and
 * private ranges are masked too — they are still addresses. SOC teams that
 * need them in the clear leave `ip` at the default (false).
 *
 * KIRMA: drop `n > IPV4_OCTET_MAX` → `256.1.1.1` becomes an address.
 */
export const IPV4_OCTET_MAX = 255

export function isStrictIpv4(s: string): boolean {
  const parts = s.split('.')
  if (parts.length !== 4) return false
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return false
    const n = Number(p)
    if (n > IPV4_OCTET_MAX) return false
  }
  return true
}

function isHexGroup(g: string): boolean {
  return /^[0-9A-Fa-f]{1,4}$/.test(g)
}

/**
 * RFC 4291 / 5952 subset: eight hextets, a single `::` compression, and
 * IPv4-mapped (`::ffff:192.0.2.1`) whose dotted tail uses isStrictIpv4.
 */
export function isStrictIpv6(s: string): boolean {
  let inner = s
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1)
  const zone = inner.indexOf('%')
  if (zone !== -1) inner = inner.slice(0, zone)

  const lastColon = inner.lastIndexOf(':')
  if (lastColon !== -1 && inner.includes('.', lastColon)) {
    const tail = inner.slice(lastColon + 1)
    if (!isStrictIpv4(tail)) return false
    inner = `${inner.slice(0, lastColon + 1)}0:0`
  }

  if (inner.includes(':::')) return false
  const compressions = inner.match(/::/g)
  if (compressions && compressions.length > 1) return false

  if (compressions?.length === 1) {
    const [left, right] = inner.split('::')
    const L = left === '' ? [] : left.split(':')
    const R = right === '' ? [] : right.split(':')
    if (L.some((g) => !isHexGroup(g)) || R.some((g) => !isHexGroup(g))) return false
    // `::` must stand for at least one missing group.
    if (L.length + R.length >= 8) return false
    return true
  }

  const groups = inner.split(':')
  if (groups.length !== 8) return false
  return groups.every(isHexGroup)
}

const DOTTED_RUN = /(?<![\d.])(?:\d{1,3}\.)+\d{1,3}(?![\d.])/g
const V6_CANDIDATE =
  /(?<![0-9A-Fa-f:])\[?(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?:\.(?:0|[1-9]\d{0,2})){0,3}\]?(?![0-9A-Fa-f:])/g

export function maskIps(text: string): { text: string; count: number } {
  let count = 0
  let out = text.replace(V6_CANDIDATE, (m) => {
    if (!isStrictIpv6(m)) return m
    count++
    return '[MASKED_PII]'
  })
  out = out.replace(DOTTED_RUN, (m) => {
    if (!isStrictIpv4(m)) return m
    count++
    return '[MASKED_PII]'
  })
  return { text: out, count }
}
