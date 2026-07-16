/**
 * C1 launcher — same-process (no nested spawn; Cursor MCP-safe).
 * Loads Supabase URL/key from jarvis-web .env.local, never prints secrets.
 */
import { readFileSync, existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const dist = join(root, 'dist', 'index.js')
const configPath = join(root, 'conarium.config.c1.json')
const envPath = process.env.CONARIUM_ENV_FILE ||
  'C:/Users/emek.dogru/Desktop/1/X/jarvis-web/.env.local'

function loadEnvFile(path) {
  if (!existsSync(path)) throw new Error(`env file missing: ${path}`)
  const out = {}
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

if (!existsSync(dist)) {
  console.error('[conarium-c1] dist/index.js missing — run npm run build')
  process.exit(1)
}
if (!existsSync(configPath)) {
  console.error('[conarium-c1] conarium.config.c1.json missing')
  process.exit(1)
}

const fileEnv = loadEnvFile(envPath)
const url = fileEnv.NEXT_PUBLIC_SUPABASE_URL || fileEnv.SUPABASE_URL
const key = fileEnv.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('[conarium-c1] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

process.env.CONARIUM_SUPABASE_URL = url
process.env.CONARIUM_SUPABASE_KEY = key

// Ensure dist/index.js sees --config (it reads process.argv)
process.argv = [process.argv[0], dist, '--config', configPath]

// Prove which policy file this process loaded (Cursor stale-process debug).
try {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  const zion = (cfg.connectors || []).find(c => c.name === 'zion-rest')
  const n = (zion?.config?.allowTables || '').split(',').filter(Boolean).length
  const p = (cfg.policy?.allowTables || []).filter(t => String(t).startsWith('zion.')).length
  console.error(`[conarium-c1] config=${configPath}`)
  console.error(`[conarium-c1] zion connector allow=${n} policy zion allow=${p}`)
} catch (e) {
  console.error('[conarium-c1] config probe failed:', e.message)
}

console.error('[conarium-c1] starting MCP same-process (zion-rest + docs)')
await import(pathToFileURL(dist).href)
