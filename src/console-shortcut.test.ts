import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  installShortcut,
  linuxDesktopFile,
  macLauncherScript,
  nextAvailablePath,
  planShortcut,
  uninstallShortcut,
  windowsShortcutScript,
  writeBorn0600,
  STATE_REL,
  TOKEN_REL,
} from './console-shortcut.js'

describe('shortcut paths', () => {
  it('plans a .lnk on Windows, .app on mac, .desktop on Linux', () => {
    expect(planShortcut('win32', '/h').dest).toMatch(/Desktop[/\\]Conarium Console\.lnk$/)
    expect(planShortcut('darwin', '/h').dest).toMatch(/Applications[/\\]Conarium Console\.app$/)
    expect(planShortcut('linux', '/h').kind).toBe('desktop')
  })

  it('adds -2 when the name is taken', () => {
    const taken = new Set(['/h/Conarium Console.lnk'])
    expect(nextAvailablePath('/h/Conarium Console.lnk', (p) => taken.has(p))).toBe(
      '/h/Conarium Console-2.lnk',
    )
  })

  it('Windows script has WindowStyle 7 and no token', () => {
    const secret = 'console-token-must-not-appear'
    const ps = windowsShortcutScript({
      dest: 'C:\\Desk\\Conarium Console.lnk',
      nodePath: 'C:\\n\\node.exe',
      scriptPath: 'C:\\p\\conarium-console.mjs',
      workdir: 'C:\\w',
    })
    expect(ps).toMatch(/WindowStyle = 7/)
    expect(ps).toContain('--launch')
    expect(ps).not.toContain(secret)
  })

  it('mac launcher and linux desktop carry --launch, not a token', () => {
    const secret = 'tok-secret'
    const sh = macLauncherScript('/usr/bin/node', '/opt/conarium-console.mjs')
    const desk = linuxDesktopFile({
      nodePath: '/usr/bin/node',
      scriptPath: '/opt/conarium-console.mjs',
      workdir: '/home/u',
    })
    expect(sh).toContain('--launch')
    expect(desk).toContain('Terminal=false')
    expect(sh).not.toContain(secret)
    expect(desk).not.toContain(secret)
  })
})

describe('install / uninstall', () => {
  it('writes linux desktop + 0600 state, then removes them', () => {
    const home = mkdtempSync(join(tmpdir(), 'cnr-sc-'))
    const destDir = join(home, '.local', 'share', 'applications')
    mkdirSync(destDir, { recursive: true })
    const out = installShortcut({
      platform: 'linux',
      home,
      nodePath: '/usr/bin/node',
      scriptPath: '/opt/bin/conarium-console.mjs',
      workdir: '/proj',
      token: 'persist-me-token-24chars-min',
    })
    expect(existsSync(out.dest)).toBe(true)
    expect(readFileSync(out.dest, 'utf8')).toContain('--launch')
    expect(readFileSync(out.dest, 'utf8')).not.toContain('persist-me-token')
    const tokenFile = join(home, TOKEN_REL)
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe('persist-me-token-24chars-min')
    if (process.platform !== 'win32') {
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
      expect(statSync(join(home, STATE_REL)).mode & 0o777).toBe(0o600)
    }
    const { removed } = uninstallShortcut({ home })
    expect(removed).toBe(out.dest)
    expect(existsSync(out.dest)).toBe(false)
    expect(existsSync(tokenFile)).toBe(false)
  })

  it('Windows install runs COM script without embedding the token', () => {
    const home = mkdtempSync(join(tmpdir(), 'cnr-scw-'))
    let seen = ''
    const secret = 'persist-me-token-must-not-land-in-lnk'
    const out = installShortcut({
      platform: 'win32',
      home,
      nodePath: 'C:\\n\\node.exe',
      scriptPath: 'C:\\p\\conarium-console.mjs',
      workdir: 'C:\\w',
      token: secret,
      runWindows: (ps) => {
        seen = ps
      },
    })
    expect(out.kind).toBe('lnk')
    expect(seen).toMatch(/WindowStyle = 7/)
    expect(seen).toContain('--launch')
    expect(seen).not.toContain(secret)
    expect(readFileSync(join(home, TOKEN_REL), 'utf8').trim()).toBe(secret)
  })

  it('does not overwrite an existing shortcut', () => {
    const home = mkdtempSync(join(tmpdir(), 'cnr-sc2-'))
    const destDir = join(home, '.local', 'share', 'applications')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'conarium-console.desktop'), 'old\n')
    const out = installShortcut({
      platform: 'linux',
      home,
      nodePath: '/usr/bin/node',
      scriptPath: '/opt/bin/conarium-console.mjs',
      workdir: '/proj',
    })
    expect(out.collided).toBe(true)
    expect(out.dest).toMatch(/conarium-console-2\.desktop$/)
    expect(readFileSync(join(destDir, 'conarium-console.desktop'), 'utf8')).toBe('old\n')
  })
})

describe('writeBorn0600', () => {
  it('source pins mode 0o600 at writeFileSync (chmod is backstop only)', () => {
    const src = readFileSync(new URL('./console-shortcut.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/writeFileSync\(file, contents, \{ encoding: 'utf8', mode: 0o600 \}\)/)
  })

  it('writes the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-0600-'))
    const f = join(dir, 'x')
    writeBorn0600(f, 'hi\n')
    expect(readFileSync(f, 'utf8')).toBe('hi\n')
  })

  it.skipIf(process.platform === 'win32')('POSIX mode is 0600 at birth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cnr-0600p-'))
    const f = join(dir, 'x')
    writeBorn0600(f, 'hi\n')
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
})
