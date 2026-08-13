#!/usr/bin/env node
/**
 * Prove the demo through the real MCP gateway: query → masked rows →
 * signed receipt → independent verify. Importing Governance here would
 * prove the class, not the product.
 *
 * Needs: Postgres on the DSN in conarium.config.json, and
 * CONARIUM_AUDIT_SIGNING_KEY pointing at the Ed25519 private PEM
 * (conarium-init --out ./_keys). The key path is never passed on argv.
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..', '..')
const gatewayJs = join(pkgRoot, 'dist/index.js')
const verifyJs = join(pkgRoot, 'bin', 'conarium-verify.mjs')
const configPath = join(here, 'conarium.config.json')
const receiptPath = join(here, 'conarium-receipts.jsonl')
const auditPath = join(here, 'conarium-audit.jsonl')

function fail(msg) {
  console.error(`FAIL  ${msg}`)
  process.exitCode = 1
}

function pass(msg) {
  console.log(`PASS  ${msg}`)
}

function countLines(p) {
  if (!existsSync(p)) return 0
  const t = readFileSync(p, 'utf8').trim()
  return t ? t.split('\n').filter(Boolean).length : 0
}

function lastJsonl(p) {
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function textOf(result) {
  const parts = result?.content ?? []
  return parts.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n')
}

function pubFromPriv(priv) {
  if (priv.endsWith('.pem') && !priv.endsWith('.pub.pem')) return `${priv.slice(0, -4)}.pub.pem`
  return `${priv}.pub.pem`
}

if (!existsSync(gatewayJs)) {
  fail(`gateway missing (${gatewayJs}) — npm run build, or install the package`)
  process.exit(1)
}

const signingKey = process.env.CONARIUM_AUDIT_SIGNING_KEY?.trim()
if (!signingKey) {
  fail('CONARIUM_AUDIT_SIGNING_KEY is not set')
  console.error('  → npx conarium-init --out ./_keys')
  console.error('  → export CONARIUM_AUDIT_SIGNING_KEY="$PWD/_keys/audit-ed25519.pem"')
  process.exit(1)
}
if (!existsSync(signingKey)) {
  fail(`signing key file not found (path only; contents not printed)`)
  process.exit(1)
}

const pubkey = pubFromPriv(signingKey)
if (!existsSync(pubkey) || !existsSync(`${pubkey}.keyid`)) {
  fail(`verifier needs ${pubkey} and ${pubkey}.keyid — conarium-init writes both; do not delete them`)
  process.exit(1)
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
const url = cfg.connectors?.[0]?.config?.url ?? ''
if (!url.includes('127.0.0.1') || !url.includes('54329')) {
  fail('demo DSN is not the local compose port — refusing to start the gateway')
  process.exit(1)
}

const beforeReceipts = countLines(receiptPath)

const env = { ...getDefaultEnvironment(), CONARIUM_AUDIT_SIGNING_KEY: signingKey }
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [gatewayJs, '--config', configPath],
  cwd: here,
  env,
  stderr: 'pipe',
})

const client = new Client({ name: 'demo-bank-prove', version: '0.0.0' })

try {
  await client.connect(transport)

  const allowed = await client.callTool({
    name: 'query',
    arguments: {
      sql: 'SELECT holder_name, tckn, iban, balance_try FROM public.accounts LIMIT 5',
    },
  })
  if (allowed.isError) {
    fail(`accounts query was denied: ${textOf(allowed)}`)
  } else {
    const body = JSON.parse(textOf(allowed))
    const row = body.rows?.[0]
    if (!row) fail('accounts query returned no rows — is Postgres up on 54329?')
    else if (row.tckn !== '[MASKED_PII]' || row.iban !== '[MASKED_PII]') {
      fail(`tckn/iban not masked: ${JSON.stringify({ tckn: row.tckn, iban: row.iban })}`)
    } else if (row.balance_try === undefined || row.balance_try === '[MASKED_PII]') {
      fail('balance_try should remain visible')
    } else {
      pass('query public.accounts → tckn/iban [MASKED_PII], balance_try visible')
    }
  }

  const afterQuery = countLines(receiptPath)
  if (afterQuery !== beforeReceipts + 1) {
    fail(`receipt file did not grow by 1 (before=${beforeReceipts} after=${afterQuery}) — gateway did not emit a receipt`)
  } else {
    pass(`receipt file grew ${beforeReceipts} → ${afterQuery}`)
  }

  if (afterQuery > 0) {
    const rec = lastJsonl(receiptPath)
    const objects = (rec.dataRefs ?? []).map((d) => d.object)
    if (!objects.includes('public.accounts')) {
      fail(`last receipt object is not public.accounts (got ${JSON.stringify(objects)})`)
    } else if (!rec.policy || typeof rec.policy !== 'object' || !rec.policy.id) {
      fail('last receipt has an empty policy field')
    } else {
      pass(`last receipt object=public.accounts policy.id=${rec.policy.id}`)
    }
  }

  const verified = spawnSync(process.execPath, [verifyJs, receiptPath, '--pubkey', pubkey], {
    cwd: here,
    encoding: 'utf8',
  })
  const vout = `${verified.stdout || ''}${verified.stderr || ''}`
  if (verified.status !== 0 || !/receipt\(s\) verified/.test(vout)) {
    fail(`conarium-verify exit ${verified.status}: ${vout.trim().slice(0, 800)}`)
  } else {
    pass('conarium-verify EXIT 0 · receipt(s) verified')
  }

  let denied = false
  let denyText = ''
  try {
    const blocked = await client.callTool({
      name: 'query',
      arguments: { sql: 'SELECT pan FROM public.card_vault' },
    })
    denyText = textOf(blocked)
    denied = Boolean(blocked.isError) || /not permitted|denied|card_vault/i.test(denyText)
  } catch (e) {
    denied = true
    denyText = e.message
  }
  if (!denied) fail(`card_vault was not denied: ${denyText}`)
  else {
    const audit = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : ''
    const logged = audit.split('\n').filter(Boolean).some((line) => {
      try {
        const e = JSON.parse(line)
        return e.denied === true && /card_vault/i.test(JSON.stringify(e.args ?? e.reason ?? e.target ?? ''))
      } catch {
        return false
      }
    })
    if (!logged) fail('card_vault deny did not land in the audit log')
    else pass('public.card_vault denied and logged')
  }
} catch (e) {
  fail(e.message)
} finally {
  try {
    await client.close()
  } catch {
    /* gateway already gone */
  }
}

if (process.exitCode === 1) {
  console.error('prove-receipt failed — the gateway, not a helper class, must produce the receipt')
}
