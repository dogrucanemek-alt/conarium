/**
 * Per-person identity — token store.
 *
 * Why a token, not a declaration: a name the client sends (such as
 * X-Conarium-Actor) has not been verified by anyone; signing it onto the
 * receipt is worse than an honest 'service' value. Conarium already verifies
 * the token, so it KNOWS who connected.
 *
 * Tokens are not stored in plaintext — only a SHA-256 hash. Even if the
 * file leaks, nobody's token is captured.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

export type ActorAssurance = 'shared-token' | 'per-user-token'

export interface ResolvedActor {
  id: string
  assurance: ActorAssurance
  isUser: boolean
}

/**
 * The path is read on every call, NOT at module load.
 * If it were captured as a constant, changing `CONARIUM_TOKENS_FILE`
 * afterwards would affect nothing — including tests, which would silently
 * measure the wrong thing.
 */
function varsayilanYol(): string {
  return process.env.CONARIUM_TOKENS_FILE || 'conarium.tokens.json'
}

/** hash → person id. If the file is missing, null = per-person identity is off (not an error). */
export function loadTokenStore(path: string = varsayilanYol()): Map<string, string> | null {
  if (!existsSync(path)) return null
  let raw: { tokens?: { sha256?: string; id?: string }[] }
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    // We THROW on purpose, we do not silently return null: returning null
    // would turn off per-person identity unnoticed and everyone would become
    // 'service' again — a silent drop is far more dangerous than a noisy error.
    throw new Error(`loadTokenStore: ${path} unreadable or invalid JSON — ${(e as Error).message}`)
  }
  const map = new Map<string, string>()
  for (const t of raw.tokens ?? []) {
    if (typeof t.sha256 === 'string' && typeof t.id === 'string' && t.sha256 && t.id) {
      map.set(t.sha256.toLowerCase(), t.id)
    }
  }
  return map
}

/**
 * Resolves the incoming token to a person. If there is no match it NEVER
 * invents a person identity — it falls back to shared-token behavior.
 */
export function resolveActor(
  supplied: string,
  store: Map<string, string> | null,
  fallbackId: string,
): ResolvedActor {
  if (store && supplied) {
    const h = createHash('sha256').update(supplied).digest('hex')
    const id = store.get(h)
    if (id) return { id, assurance: 'per-user-token', isUser: true }
  }
  return { id: fallbackId, assurance: 'shared-token', isUser: false }
}
