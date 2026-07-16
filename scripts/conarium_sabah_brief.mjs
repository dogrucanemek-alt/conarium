/**
 * Conarium sabah brief — zion-rest queries → markdown file.
 * Usage: node scripts/conarium_sabah_brief.mjs
 * Writes: AI_GOVERNANCE/cursor_memory/sabah_conarium.md (no secrets)
 */
import { spawn } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const launcher = join(
  'C:/Users/emek.dogru/Desktop/projeler/Documents/conarium-public/scripts/start-mcp-c1.mjs'
)
const outDir = 'C:/Users/emek.dogru/AI_GOVERNANCE/cursor_memory'
const outFile = join(outDir, 'sabah_conarium.md')
const nodeExe = 'C:/Program Files/nodejs/node.exe'

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
}

function runMcp(messages) {
  return new Promise((resolve, reject) => {
    const p = spawn(nodeExe, [launcher], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (err += d))
    p.on('error', reject)
    setTimeout(() => {
      for (const m of messages) p.stdin.write(m)
      p.stdin.end()
    }, 200)
    setTimeout(() => {
      try { p.kill() } catch {}
      resolve({ out, err })
    }, 12000)
  })
}

function parseToolResults(out) {
  const map = {}
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.id == null || !o.result?.content?.[0]?.text) continue
    const t = o.result.content[0].text
    if (t.startsWith('Error:')) {
      map[o.id] = { error: t }
      continue
    }
    try { map[o.id] = JSON.parse(t) } catch { map[o.id] = { raw: t.slice(0, 500) } }
  }
  return map
}

function fmtRows(payload, max = 8) {
  if (payload?.error) return `_Hata: ${payload.error}_\n`
  const rows = payload?.rows || []
  if (!rows.length) return '_boş_\n'
  const keys = Object.keys(rows[0]).filter(k => !/phone|email|gsm|tckn/i.test(k)).slice(0, 6)
  const lines = ['| ' + keys.join(' | ') + ' |', '| ' + keys.map(() => '---').join(' | ') + ' |']
  for (const r of rows.slice(0, max)) {
    lines.push('| ' + keys.map(k => String(r[k] ?? '')).join(' | ') + ' |')
  }
  return lines.join('\n') + '\n'
}

const { out, err } = await runMcp([
  rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sabah', version: '1' } }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  rpc(2, 'tools/call', { name: 'query', arguments: { connector: 'zion-rest', sql: 'SELECT * FROM zion.v_dead_stock_summary LIMIT 1' } }),
  rpc(3, 'tools/call', { name: 'query', arguments: { connector: 'zion-rest', sql: 'SELECT * FROM zion.v_branch_summary LIMIT 10' } }),
  rpc(4, 'tools/call', { name: 'query', arguments: { connector: 'zion-rest', sql: 'SELECT * FROM zion.v_stock_runout LIMIT 10' } }),
  rpc(5, 'tools/call', { name: 'query', arguments: { connector: 'zion-rest', sql: 'SELECT * FROM zion.v_ship_summary LIMIT 1' } }),
])

const r = parseToolResults(out)
const now = new Date().toISOString()
const md = `# Conarium sabah — ${now}

> Kaynak: zion-rest (Codes sync aynası). Canlı Codes değil. PII maskeli alanlar atlandı.

## 1) Ölü stok
${fmtRows(r[2], 3)}

## 2) Şube özet
${fmtRows(r[3], 10)}

## 3) Stock runout
${fmtRows(r[4], 10)}

## 4) Sevk özet
${fmtRows(r[5], 3)}

## Not
- |marj| uçuksa önce maliyet/veri_hatası hipotezi.
- 3 hamleyi Agent skill \`conarium-sabah\` ile yorumla.

## stderr (kısa)
\`\`\`
${err.split('\\n').filter(l => /allow=|Connected|running|Fatal/.test(l)).slice(0, 8).join('\\n')}
\`\`\`
`

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, md, 'utf8')
console.error('[sabah] wrote', outFile)
