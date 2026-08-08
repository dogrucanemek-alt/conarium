#!/usr/bin/env node
/**
 * conarium-anchor-service — run the hosted anchoring endpoint.
 *
 * Usage:
 *   CONARIUM_ANCHOR_TOKENS=./anchor.tokens.json \
 *   CONARIUM_ANCHOR_BASE_URL=https://anchor.conarium.dev \
 *   node bin/conarium-anchor-service.mjs
 *
 * Env:
 *   CONARIUM_ANCHOR_TOKENS    required — JSON map of {"token":"owner-id"}
 *   CONARIUM_ANCHOR_BASE_URL  required — public origin used to build verify URLs
 *   CONARIUM_ANCHOR_STORE     default ./anchor-store.jsonl
 *   CONARIUM_ANCHOR_PORT      default 8797
 *   CONARIUM_ANCHOR_HOST      default 127.0.0.1 (put a TLS proxy in front)
 *   CONARIUM_ANCHOR_RATE      default 60 submissions per owner per minute
 *   CONARIUM_ANCHOR_UPGRADE_MINUTES  default 60; 0 disables the background pass
 *
 * Exits non-zero on missing configuration rather than starting an endpoint that
 * accepts anonymous writes — an anchoring service anyone can write to is a disk
 * filling up, not a service.
 */
import { existsSync } from 'fs'
import { createAnchorService, loadTokensFile } from '../dist/anchor-service.js'

function need(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`missing required env ${name}`)
    process.exit(2)
  }
  return v
}

const tokensPath = need('CONARIUM_ANCHOR_TOKENS')
const baseUrl = need('CONARIUM_ANCHOR_BASE_URL')

if (!existsSync(tokensPath)) {
  console.error(`token file not found: ${tokensPath}`)
  process.exit(2)
}

const tokens = loadTokensFile(tokensPath)
if (tokens.size === 0) {
  console.error(`token file ${tokensPath} defines no tokens — refusing to start`)
  process.exit(2)
}

const storePath = process.env.CONARIUM_ANCHOR_STORE ?? './anchor-store.jsonl'
const port = Number(process.env.CONARIUM_ANCHOR_PORT ?? 8797)
const host = process.env.CONARIUM_ANCHOR_HOST ?? '127.0.0.1'
const submitsPerMinute = Number(process.env.CONARIUM_ANCHOR_RATE ?? 60)
const upgradeMinutes = Number(process.env.CONARIUM_ANCHOR_UPGRADE_MINUTES ?? 60)

const { app, runUpgrade } = createAnchorService({ storePath, tokens, publicBaseUrl: baseUrl, submitsPerMinute })

app.listen(port, host, () => {
  console.log(`conarium-anchor listening on http://${host}:${port}`)
  console.log(`  store   ${storePath}`)
  console.log(`  owners  ${new Set(tokens.values()).size}`)
  console.log(`  public  ${baseUrl}`)
})

// Bitcoin confirmation takes hours, so nobody should have to remember to run
// the upgrade. This loop is the difference between a proof and a promise.
if (upgradeMinutes > 0) {
  const tick = async () => {
    try {
      const r = await runUpgrade()
      if (r.upgraded) console.log(`upgraded ${r.upgraded}/${r.checked} pending anchor(s)`)
    } catch (err) {
      console.error(`upgrade pass failed: ${err.message}`)
    }
  }
  setInterval(tick, upgradeMinutes * 60_000).unref?.()
  setTimeout(tick, 10_000).unref?.()
}
