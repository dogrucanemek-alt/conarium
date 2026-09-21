#!/usr/bin/env node
/**
 * Conarium stdio entrypoint (local MCP for Cursor / Claude Code / Codex).
 * Server core lives in server.ts — shared with the remote HTTP entrypoint (http.ts).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { loadConfig, bootDeps, buildServer, type ConariumDeps } from './server.js'
import type { ConariumConfig } from './types.js'
import * as updateCheck from './update-check.js'
import { writeKeyPairFiles } from './keys.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { DemoConnector } from './connectors/demo.js'

export const DEMO_BANNER = '[conarium] demo mode: sample rows, not a database'
export const DEMO_PRODUCTION_REFUSAL =
  '[conarium] --demo refuses to start when NODE_ENV=production'

export class DemoModeRefused extends Error {
  readonly exitCode = 1
  constructor(message = DEMO_PRODUCTION_REFUSAL) {
    super(message)
    this.name = 'DemoModeRefused'
  }
}

export function parseCliFlags(argv: string[] = process.argv.slice(2)): {
  demo: boolean
  keep: boolean
} {
  return {
    demo: argv.includes('--demo'),
    keep: argv.includes('--keep'),
  }
}

export function demoStartBlocker(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV === 'production') return DEMO_PRODUCTION_REFUSAL
  return null
}

/** In-memory config for `--demo`. Never read from a file. */
export function buildDemoConfig(dir: string): ConariumConfig {
  return {
    serverName: 'Conarium',
    consumer: 'demo',
    connectors: [
      {
        type: 'demo',
        name: 'demo',
        description: 'In-memory sample rows, not a database',
        config: {},
      },
    ],
    policy: {
      allowTables: ['public.customers', 'public.orders'],
      denyTables: ['public.secrets'],
      maskColumns: ['email', '*.card'],
      maxRows: 3,
      allowConnectors: ['demo'],
    },
    audit: {
      sink: join(dir, 'audit.jsonl'),
      receiptSink: join(dir, 'receipts.jsonl'),
    },
  }
}

export function demoVerifyCommand(receiptsPath: string, publicKeyPath: string): string {
  return `conarium-verify ${receiptsPath} --pubkey ${publicKeyPath}`
}

export interface DemoSession {
  dir: string
  keep: boolean
  publicKeyPath: string
  receiptsPath: string
  auditPath: string
  verifyCommand: string
  deps: ConariumDeps
  server: Server
  connector: DemoConnector
  stop(): Promise<void>
}

/**
 * Build the demo process: ephemeral dir, one-shot Ed25519 pair, real
 * `bootDeps` / `buildServer`. Does not attach stdio and does not call
 * `announceUpdate`.
 */
export async function bootDemo(opts: { keep?: boolean } = {}): Promise<DemoSession> {
  const blocked = demoStartBlocker()
  if (blocked) throw new DemoModeRefused(blocked)

  console.error(DEMO_BANNER)

  const dir = mkdtempSync(join(tmpdir(), 'conarium-demo-'))
  const keys = writeKeyPairFiles(join(dir, 'audit-ed25519'), 'demo')
  const prevSigning = process.env.CONARIUM_AUDIT_SIGNING_KEY
  process.env.CONARIUM_AUDIT_SIGNING_KEY = keys.privatePath

  const config = buildDemoConfig(dir)
  let deps: ConariumDeps
  try {
    deps = await bootDeps(config)
  } catch (err) {
    if (prevSigning === undefined) delete process.env.CONARIUM_AUDIT_SIGNING_KEY
    else process.env.CONARIUM_AUDIT_SIGNING_KEY = prevSigning
    throw err
  }

  const connector = deps.connectors.find((c): c is DemoConnector => c instanceof DemoConnector)
  if (!connector) {
    deps.audit.close()
    if (prevSigning === undefined) delete process.env.CONARIUM_AUDIT_SIGNING_KEY
    else process.env.CONARIUM_AUDIT_SIGNING_KEY = prevSigning
    throw new Error('demo connector was not installed')
  }

  const server = buildServer(deps)
  const receiptsPath = config.audit!.receiptSink!
  const auditPath = config.audit!.sink!
  const verifyCommand = demoVerifyCommand(receiptsPath, keys.publicPath)
  const keep = Boolean(opts.keep)
  let stopped = false

  return {
    dir,
    keep,
    publicKeyPath: keys.publicPath,
    receiptsPath,
    auditPath,
    verifyCommand,
    deps,
    server,
    connector,
    async stop() {
      if (stopped) return
      stopped = true
      for (const conn of deps.connectors) await conn.disconnect().catch(() => {})
      deps.audit.close()
      if (prevSigning === undefined) delete process.env.CONARIUM_AUDIT_SIGNING_KEY
      else process.env.CONARIUM_AUDIT_SIGNING_KEY = prevSigning
      if (keep) {
        console.error(verifyCommand)
        return
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export async function attachStdio(
  server: Server,
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): Promise<void> {
  const transport = new StdioServerTransport(stdin, stdout)
  await server.connect(transport)
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const flags = parseCliFlags(argv.slice(2))

  if (flags.demo) {
    const blocked = demoStartBlocker()
    if (blocked) {
      console.error(blocked)
      process.exit(1)
    }
    const session = await bootDemo({ keep: flags.keep })
    await attachStdio(session.server)
    console.error(`[conarium] MCP server running - ${session.deps.connectors.length} connector(s) active`)
    if (flags.keep) console.error(session.verifyCommand)
    const shutdown = async () => {
      await session.stop()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  const config = loadConfig()
  const deps = await bootDeps(config)
  const server = buildServer(deps)

  await attachStdio(server)
  console.error(`[conarium] MCP server running - ${deps.connectors.length} connector(s) active`)
  updateCheck.announceUpdate()

  process.on('SIGINT', async () => {
    for (const conn of deps.connectors) await conn.disconnect().catch(() => {})
    deps.audit.close()
    process.exit(0)
  })
}

/**
 * main() runs only when the file is executed directly. Importing it from a
 * test must not start the stdio server or call process.exit.
 */
const dogrudanCalistirildi = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return true
  }
})()

if (dogrudanCalistirildi) {
  main().catch((err) => {
    console.error('[conarium] Fatal:', err)
    process.exit(1)
  })
}
