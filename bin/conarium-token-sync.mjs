#!/usr/bin/env node
/**
 * Pull active token hashes from Supabase onto the local file the
 * countersign service already reads. One-way. Never wipes on error.
 *
 *   CONARIUM_SUPABASE_URL=… \
 *   CONARIUM_SUPABASE_SERVICE_ROLE=… \
 *   CONARIUM_ANCHOR_TOKENS=./anchor.tokens.json \
 *   node bin/conarium-token-sync.mjs
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function fail(message) {
  console.error(message)
  process.exit(1)
}

const url = (process.env.CONARIUM_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '')
const key = process.env.CONARIUM_SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY
const tokensPath = process.env.CONARIUM_ANCHOR_TOKENS
if (!url || !key) fail('CONARIUM_SUPABASE_URL and CONARIUM_SUPABASE_SERVICE_ROLE are required')
if (!tokensPath) fail('CONARIUM_ANCHOR_TOKENS is required')

const fetchImpl = globalThis.__conariumFetch || fetch

let json
try {
  const res = await fetchImpl(`${url}/rest/v1/conarium_anchor_token?status=eq.active&select=token_sha256,owner`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!res.ok) fail(`supabase http ${res.status} — token file left unchanged`)
  json = await res.json()
} catch (err) {
  fail(`supabase unreachable — token file left unchanged (${err.message})`)
}

if (!Array.isArray(json)) fail('supabase returned non-array JSON — token file left unchanged')

const out = { _conarium_sync: new Date().toISOString() }
for (const row of json) {
  if (!row || typeof row.token_sha256 !== 'string' || typeof row.owner !== 'string') {
    fail('supabase row missing token_sha256/owner — token file left unchanged')
  }
  if (!/^[0-9a-f]{64}$/i.test(row.token_sha256)) {
    fail('supabase row has a non-sha256 token_sha256 — token file left unchanged')
  }
  out[`sha256:${row.token_sha256}`] = row.owner
}

const tmp = join(dirname(tokensPath), `.anchor.tokens.${process.pid}.tmp`)
writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`)
renameSync(tmp, tokensPath)
console.error(`synced ${json.length} active token hash(es)`)
