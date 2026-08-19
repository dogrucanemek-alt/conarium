/**
 * Worker for test/receipt_sink_lock.test.ts.
 * Two OS processes import Audit separately — same-process heldLocks cannot
 * hide a missing receipt-sink lock.
 *
 * Runs via tsx so it loads src/ without a prior build.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { Audit } from '../src/audit.ts'

const receiptSink = process.env.CONARIUM_LOCK_RECEIPT
const auditSink = process.env.CONARIUM_LOCK_AUDIT || undefined
const goPath = process.env.CONARIUM_LOCK_GO
const readyPath = process.env.CONARIUM_LOCK_READY
const n = Number(process.env.CONARIUM_LOCK_N || '8')
const tag = process.env.CONARIUM_LOCK_TAG || String(process.pid)

if (!receiptSink || !goPath || !readyPath) {
  console.error('receipt_sink_lock_child: missing CONARIUM_LOCK_RECEIPT / _GO / _READY')
  process.exit(2)
}

function waitForGo(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (existsSync(path)) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error('go signal timeout'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

const audit = new Audit({
  sink: auditSink,
  receiptSink,
  receiptMeta: {
    model: { provider: 'test', name: 'lock-child', version: '1.0' },
    client: { name: `lock-${tag}`, version: '1.0' },
    destination: 'test/lock',
  },
})
writeFileSync(readyPath, `${process.pid}\n`)

await waitForGo(goPath, 20_000)

for (let i = 0; i < n; i++) {
  audit.log({ tool: 'query', target: `public.t${tag}`, denied: false, args: { i, tag } })
}
audit.close()
