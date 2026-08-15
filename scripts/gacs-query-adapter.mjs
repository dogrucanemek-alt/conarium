#!/usr/bin/env node
/**
 * Product-side query helper. Lives outside conformance/ so the suite
 * itself imports no implementation modules.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Governance, PolicyError } from '../dist/governance.js'

const { values } = parseArgs({
  options: {
    policy: { type: 'string' },
    query: { type: 'string' },
  },
})

if (!values.policy || !values.query) {
  process.stderr.write('usage: --policy <file> --query <file>\n')
  process.exit(2)
}

const policy = JSON.parse(readFileSync(values.policy, 'utf8'))
const sql = readFileSync(values.query, 'utf8')

function emit(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`)
}

try {
  const gov = new Governance(policy)
  const out = gov.guardQuery(sql)
  emit({
    decision: 'allow',
    rewrittenSql: out.sql ?? '',
    maskedFields: out.metadata?.maskedFields ?? [],
    denyReason: '',
    receipt: {},
  })
} catch (err) {
  if (err instanceof PolicyError || err?.name === 'PolicyError') {
    emit({
      decision: 'deny',
      rewrittenSql: '',
      maskedFields: [],
      denyReason: String(err.message ?? ''),
      receipt: {},
    })
    process.exit(0)
  }
  process.stderr.write(String(err?.stack || err?.message || err) + '\n')
  process.exit(2)
}
