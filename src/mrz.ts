/**
 * Passport MRZ (ICAO 9303 TD3) — two lines × 44 characters, `P` in position 1,
 * 7-3-1 weighted check digits. A checksum miss is not an MRZ: leave it.
 *
 * TD1/TD2 are not implemented. A free-text "letter + eight digits" pattern
 * is deliberately absent (product codes and order numbers share it).
 *
 * KIRMA: skip any of the five check-digit tests → a mutated line 2 still
 * masks, and the "checksum-fail is left alone" test goes red.
 */
const WEIGHTS = [7, 3, 1]

export function mrzCheckDigit(data: string): string {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]
    let v: number
    if (ch === '<') v = 0
    else if (ch >= '0' && ch <= '9') v = ch.charCodeAt(0) - 48
    else if (ch >= 'A' && ch <= 'Z') v = ch.charCodeAt(0) - 55
    else return ''
    sum += v * WEIGHTS[i % 3]
  }
  return String(sum % 10)
}

function isTd3Line1(line: string): boolean {
  return line.length === 44 && /^P[A-Z0-9<]{43}$/.test(line)
}

function isTd3Line2(line: string): boolean {
  if (line.length !== 44) return false
  if (!/^[A-Z0-9<]{44}$/.test(line)) return false
  if (mrzCheckDigit(line.slice(0, 9)) !== line[9]) return false
  if (mrzCheckDigit(line.slice(13, 19)) !== line[19]) return false
  if (mrzCheckDigit(line.slice(21, 27)) !== line[27]) return false
  if (mrzCheckDigit(line.slice(28, 42)) !== line[42]) return false
  const composite = line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43)
  if (mrzCheckDigit(composite) !== line[43]) return false
  const sex = line[20]
  if (sex !== 'M' && sex !== 'F' && sex !== '<') return false
  return true
}

export function isTd3Mrz(line1: string, line2: string): boolean {
  return isTd3Line1(line1) && isTd3Line2(line2)
}

const TD3_BLOCK = /P[A-Z0-9<]{43}(?:\r?\n)[A-Z0-9<]{44}/g

export function maskMrz(text: string): { text: string; count: number } {
  if (!text.includes('\n')) return { text, count: 0 }
  let count = 0
  const next = text.replace(TD3_BLOCK, (block) => {
    const nl = block.includes('\r\n') ? '\r\n' : '\n'
    const i = block.indexOf(nl)
    const line1 = block.slice(0, i)
    const line2 = block.slice(i + nl.length)
    if (!isTd3Mrz(line1, line2)) return block
    count++
    return '[MASKED_PII]'
  })
  return { text: next, count }
}

