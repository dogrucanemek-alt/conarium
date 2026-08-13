import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { installedVersion } from './update-check.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as { version: string }
const SERVER_SRC = readFileSync(join(HERE, 'server.ts'), 'utf8')

describe('MCP serverInfo.version', () => {
  it('installedVersion matches package.json', () => {
    expect(installedVersion()).toBe(PKG.version)
  })

  it('buildServer reads the installed version, not a frozen 0.1.0', () => {
    expect(SERVER_SRC).toMatch(/installedVersion\(\)/)
    expect(SERVER_SRC).not.toMatch(/config\.serverVersion\s*\|\|\s*['"]0\.1\.0['"]/)
  })
})
