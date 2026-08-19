/**
 * Compare what standards/README.md asserts about the draft's posting
 * status with what the IETF Datatracker says.
 *
 * Unreachable Datatracker → SKIP (exit 0, prints SKIP). Silent green is
 * forbidden: the skip line must be visible. A reachable mismatch → FAIL.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOC = 'draft-dogru-scitt-disclosure-evidence'
const TRACKER = `https://datatracker.ietf.org/doc/${DOC}/`
const DOC_JSON =
  process.env.CONARIUM_DATATRACKER_DOC_JSON ||
  `https://datatracker.ietf.org/doc/${DOC}/doc.json`
const README = join(root, 'standards', 'README.md')

const text = readFileSync(README, 'utf8')
if (!text.includes(TRACKER)) {
  console.error(
    `FAIL: standards/README.md must point at ${TRACKER} (canonical record, not a copied status line)`,
  )
  process.exitCode = 1
} else {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8000)
  let doc
  try {
    const res = await fetch(DOC_JSON, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      console.log(`SKIP: datatracker unreachable (HTTP ${res.status})`)
    } else {
      doc = await res.json()
    }
  } catch (err) {
    const name = err?.name || 'Error'
    const message = err?.message || String(err)
    console.log(`SKIP: datatracker unreachable (${name}: ${message})`)
  } finally {
    clearTimeout(timer)
  }

  if (doc) {
    const latest = typeof doc.rev === 'string' ? doc.rev : null
    if (!latest || !/^\d+$/.test(latest)) {
      console.error(`FAIL: datatracker doc.json missing numeric rev: ${JSON.stringify(doc.rev)}`)
      process.exitCode = 1
    } else {
      const latestN = Number(latest)
      const claims = [
        ...text.matchAll(/`-(\d{2})`\s+is being prepared here and has not been submitted/gi),
        ...text.matchAll(/`-(\d{2})`[^.\n]{0,80}has not been submitted/gi),
      ]
      let mismatch = false
      for (const m of claims) {
        const n = Number(m[1])
        if (n <= latestN) {
          console.error(
            `FAIL: standards/README.md claims -${m[1]} is unsubmitted; ` +
              `datatracker latest is -${latest} (${DOC_JSON})`,
          )
          mismatch = true
        }
      }
      if (mismatch) process.exitCode = 1
      else {
        console.log(
          `datatracker draft status: README assertions match posted -${latest} (${DOC_JSON})`,
        )
      }
    }
  }
}
