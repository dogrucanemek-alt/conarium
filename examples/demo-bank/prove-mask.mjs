#!/usr/bin/env node
/**
 * Prove the demo policy against the live demo database.
 * Expects docker compose up on 127.0.0.1:54329.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const postgres = require('postgres')
const { Governance, PolicyError } = await import(pathToFileURL(join(here, '..', '..', 'dist', 'governance.js')).href)

const cfg = JSON.parse(readFileSync(join(here, 'conarium.config.json'), 'utf8'))
const url = cfg.connectors[0].config.url
if (!url.includes('127.0.0.1') || !url.includes('54329')) {
  console.error('demo DSN is not the local compose port — refusing to query')
  process.exitCode = 1
  process.exit()
}

const sql = postgres(url, { max: 1 })
const gov = new Governance(cfg.policy)

try {
  const rows = await sql`select holder_name, tckn, iban, balance_try from accounts limit 5`
  const redacted = gov.redact(
    {
      rowCount: rows.length,
      fields: ['holder_name', 'tckn', 'iban', 'balance_try'],
      rows: rows.map((r) => ({ ...r, _table: 'public.accounts' })),
    },
    {},
  )
  const sample = redacted.rows[0]
  if (!sample) throw new Error('no rows from demo db — is compose up?')
  if (sample.tckn !== '[MASKED_PII]' || sample.iban !== '[MASKED_PII]') {
    throw new Error(`expected tckn/iban masked, got ${JSON.stringify({ tckn: sample.tckn, iban: sample.iban })}`)
  }
  if (typeof sample.balance_try === 'undefined' || sample.balance_try === '[MASKED_PII]') {
    throw new Error('balance_try should remain visible')
  }
  console.log('ok  accounts.tckn / accounts.iban → [MASKED_PII]')

  let denied = false
  try {
    gov.guardQuery('SELECT pan FROM public.card_vault')
  } catch (e) {
    if (e instanceof PolicyError || /denied|not allowed|card_vault/i.test(e.message)) denied = true
    else throw e
  }
  if (!denied) throw new Error('card_vault was not denied')
  console.log('ok  public.card_vault denied')
} finally {
  await sql.end({ timeout: 1 })
}
