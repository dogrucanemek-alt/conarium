/**
 * The desktop mark is the extracted SVG, not the 32×32 16-color favicon
 * and not the CSS gradient square.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'assets', 'conarium-mark.svg'), 'utf8')
assert.match(svg, /viewBox="0 0 32 32"/)
assert.match(svg, /circle cx="16" cy="16" r="9"/)
assert.match(svg, /stroke="#fff"/)
assert.match(svg, /r="3.4"/)
assert.doesNotMatch(svg, /linear-gradient/)

for (const f of ['conarium-mark.ico', 'conarium-mark.icns', 'conarium-mark-512.png']) {
  const p = join(root, 'assets', f)
  assert.ok(existsSync(p), `missing ${f}`)
  assert.ok(statSync(p).size > 32, `${f} looks empty`)
}

const ico = readFileSync(join(root, 'assets', 'conarium-mark.ico'))
assert.equal(ico[0], 0)
assert.equal(ico[1], 0)
assert.equal(ico[2], 1) // ICO
assert.ok(ico[4] >= 6, 'ICO should carry 16/32/48/64/128/256 layers')

const png = readFileSync(join(root, 'assets', 'conarium-mark-512.png'))
assert.equal(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a')
assert.equal(png.readUInt32BE(16), 512)
assert.equal(png.readUInt32BE(20), 512)

const nexusSvg = join(root, '..', 'nexus', 'assets', 'conarium-mark.svg')
if (existsSync(nexusSvg)) {
  assert.equal(
    readFileSync(nexusSvg, 'utf8'),
    svg,
    'nexus/assets/conarium-mark.svg must match the product file — no second drawing',
  )
}

const html = readFileSync(join(root, 'public', 'index.html'), 'utf8')
assert.match(html, /conarium-mark\.svg/)
assert.doesNotMatch(html, /logo-icon/)

console.log('PASS  ::  mark SVG + ico/icns/512png present; panel uses the SVG')
process.exit(0)
