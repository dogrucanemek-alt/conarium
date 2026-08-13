/**
 * Update notice for long-running entrypoints.
 *
 * WHY
 * `conarium-doctor` can tell you a newer version exists, but nobody runs the
 * doctor on a Tuesday. The gateway is a background process an MCP client
 * launches; it can sit on a six-day-old build for weeks and nothing says so.
 * This prints one line at startup when a newer version is published.
 *
 * RULES THIS FOLLOWS
 * - **stderr only.** The stdio gateway speaks MCP over stdout; a stray line
 *   there corrupts the protocol stream. Never console.log here.
 * - **Never blocks and never throws.** A registry that is slow, down, or
 *   firewalled must not delay or fail a start. 2s budget, errors swallowed.
 * - **No telemetry.** The request asks the public registry for a version
 *   number. Nothing about this installation is sent — no id, no hostname, no
 *   usage. A bank will read this file.
 * - **Opt-out:** CONARIUM_NO_UPDATE_CHECK=1 disables it entirely, which also
 *   makes it a no-op on air-gapped installs that would otherwise wait 2s.
 */
import { createRequire } from 'module'

const REGISTRY_DEFAULT = 'https://registry.npmjs.org/@conarium-ai/core/latest'

export function installedVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** -1 / 0 / 1 on the numeric parts only; pre-release tags are ignored. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map((n) => Number(n) || 0)
  const pb = b.split('-')[0].split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
  }
  return 0
}

/**
 * Returns the notice text when a newer version is published, otherwise null.
 * Never throws.
 */
export async function updateNotice(
  opts: { installed?: string | null; timeoutMs?: number } = {},
): Promise<string | null> {
  if (process.env.CONARIUM_NO_UPDATE_CHECK === '1') return null
  const installed = opts.installed !== undefined ? opts.installed : installedVersion()
  if (!installed) return null

  const url = process.env.CONARIUM_NPM_REGISTRY || REGISTRY_DEFAULT
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 2000)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    const latest = typeof body?.version === 'string' ? body.version : null
    if (!latest || cmpSemver(latest, installed) <= 0) return null
    return `[conarium] update available: ${installed} → ${latest}  (npm i @conarium-ai/core@${latest})`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Fire-and-forget: prints to stderr if there is something to say. */
export function announceUpdate(): void {
  void updateNotice().then((msg) => {
    if (msg) console.error(msg)
  })
}
