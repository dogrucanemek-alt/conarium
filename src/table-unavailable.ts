/**
 * Assistant-facing table errors must not distinguish "denied" from "missing".
 * The audit log keeps the real reason. Timing is a residual side channel:
 * a deny never reaches the connector (that stays); a missing table may.
 */
export function tableUnavailableMessage(table: string): string {
  return `Access to table '${table}' is not available.`
}

export function tableUnavailableError(table: string): Error {
  return new Error(tableUnavailableMessage(table))
}

export function tableFromAccessDeny(message: string): string | undefined {
  const m = message.match(/Access to table '([^']+)' is not permitted by policy/)
  return m?.[1]
}

export function isMissingTableMessage(message: string): boolean {
  return /not found|does not exist|invalid object name|ora-00942|unknown table|unknown relation/i.test(
    message,
  )
}

/** After the real reason is in the audit log, rewrite the assistant error. */
export function publicizeTableError(err: unknown, fallbackTable?: string): never {
  const msg = err instanceof Error ? err.message : String(err)
  const denied = tableFromAccessDeny(msg)
  if (denied) throw tableUnavailableError(denied)
  if (isMissingTableMessage(msg)) {
    const named =
      msg.match(/(?:table|relation)\s+(?:not found:\s*)?['"]?([a-zA-Z0-9_.]+)/i)?.[1] ??
      fallbackTable
    throw tableUnavailableError(named ?? 'unknown')
  }
  throw err
}
