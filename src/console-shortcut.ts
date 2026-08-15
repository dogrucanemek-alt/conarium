/**
 * Desktop shortcut for conarium-console. The shortcut holds a command,
 * never a token.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const SHORTCUT_NAME = 'Conarium Console'
export const STATE_REL = join('.conarium', 'console-shortcut.json')
export const TOKEN_REL = join('.conarium', 'console.token')

export interface ShortcutPlan {
  dest: string
  kind: 'lnk' | 'app' | 'desktop'
}

export interface ShortcutState {
  path: string
  workdir: string
  kind: ShortcutPlan['kind']
}

export function nextAvailablePath(preferred: string, exists: (p: string) => boolean = existsSync): string {
  if (!exists(preferred)) return preferred
  const m = preferred.match(/^(.*?)(\.[^./\\]+)?$/)
  const stem = m?.[1] ?? preferred
  const ext = m?.[2] ?? ''
  for (let n = 2; n < 100; n++) {
    const cand = `${stem}-${n}${ext}`
    if (!exists(cand)) return cand
  }
  throw new Error('could not find a free shortcut name')
}

export function planShortcut(
  platform: NodeJS.Platform,
  home: string,
): ShortcutPlan {
  if (platform === 'win32') {
    return { dest: join(home, 'Desktop', `${SHORTCUT_NAME}.lnk`), kind: 'lnk' }
  }
  if (platform === 'darwin') {
    return { dest: join(home, 'Applications', `${SHORTCUT_NAME}.app`), kind: 'app' }
  }
  return {
    dest: join(home, '.local', 'share', 'applications', 'conarium-console.desktop'),
    kind: 'desktop',
  }
}

export function writeBorn0600(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* windows */ }
}

export function packageAssetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
}

export function shortcutIconPath(
  platform: NodeJS.Platform,
  assetsDir = packageAssetsDir(),
): string | null {
  const name =
    platform === 'win32'
      ? 'conarium-mark.ico'
      : platform === 'darwin'
        ? 'conarium-mark.icns'
        : 'conarium-mark-512.png'
  const p = join(assetsDir, name)
  return existsSync(p) ? p : null
}

export function windowsShortcutScript(opts: {
  dest: string
  nodePath: string
  scriptPath: string
  workdir: string
  iconPath?: string | null
}): string {
  const q = (s: string) => s.replace(/'/g, "''")
  const lines = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$s = $ws.CreateShortcut('${q(opts.dest)}')`,
    `$s.TargetPath = '${q(opts.nodePath)}'`,
    `$s.Arguments = '"${q(opts.scriptPath)}" --launch'`,
    `$s.WorkingDirectory = '${q(opts.workdir)}'`,
    `$s.WindowStyle = 7`,
    `$s.Description = 'Conarium Console'`,
  ]
  if (opts.iconPath) lines.push(`$s.IconLocation = '${q(opts.iconPath)}'`)
  lines.push(`$s.Save()`)
  return lines.join('\n')
}

export function macLauncherScript(nodePath: string, scriptPath: string): string {
  // Single quotes are literal in sh, and the only character that can end the
  // quote is `'` itself. Escaping just `"` inside double quotes left `$(…)`,
  // backticks and `\` live in paths this code does not choose.
  const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh\nexec ${sh(nodePath)} ${sh(scriptPath)} --launch\n`
}

export function macInfoPlist(opts: { iconFile?: string | null } = {}): string {
  const icon = opts.iconFile
    ? `
  <key>CFBundleIconFile</key><string>${opts.iconFile}</string>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Conarium Console</string>
  <key>CFBundleIdentifier</key><string>dev.conarium.console</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>${icon}
</dict>
</plist>
`
}

export function linuxDesktopFile(opts: {
  nodePath: string
  scriptPath: string
  workdir: string
  iconPath?: string | null
}): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Conarium Console',
    `Exec="${opts.nodePath}" "${opts.scriptPath}" --launch`,
    `Path=${opts.workdir}`,
    'Terminal=false',
    'Categories=Utility;',
  ]
  if (opts.iconPath) lines.push(`Icon=${opts.iconPath}`)
  lines.push('')
  return lines.join('\n')
}

export function installShortcut(opts: {
  platform?: NodeJS.Platform
  home?: string
  nodePath?: string
  scriptPath: string
  workdir: string
  token?: string
  runWindows?: (script: string) => void
  assetsDir?: string
}): { dest: string; kind: ShortcutPlan['kind']; collided: boolean; iconMissing: boolean } {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? process.env.CONARIUM_CONSOLE_HOME ?? osHomedir()
  const nodePath = opts.nodePath ?? process.execPath
  const planned = planShortcut(platform, home)
  const dest = nextAvailablePath(planned.dest)
  const collided = dest !== planned.dest
  mkdirSync(dirname(dest), { recursive: true })
  const iconPath = shortcutIconPath(platform, opts.assetsDir ?? packageAssetsDir())
  const iconMissing = !iconPath

  if (planned.kind === 'lnk') {
    const script = windowsShortcutScript({
      dest,
      nodePath,
      scriptPath: opts.scriptPath,
      workdir: opts.workdir,
      iconPath,
    })
    if (script.includes(opts.token || '\u0000') && opts.token) {
      throw new Error('shortcut script must not contain the token')
    }
    const run = opts.runWindows ?? ((ps) => {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'powershell failed')
    })
    run(script)
  } else if (planned.kind === 'app') {
    const mac = dest
    mkdirSync(join(mac, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(mac, 'Contents', 'Resources'), { recursive: true })
    if (iconPath) {
      copyFileSync(iconPath, join(mac, 'Contents', 'Resources', 'conarium-mark.icns'))
    }
    writeFileSync(join(mac, 'Contents', 'Info.plist'), macInfoPlist({ iconFile: iconPath ? 'conarium-mark' : null }))
    const launcher = join(mac, 'Contents', 'MacOS', 'launcher')
    writeFileSync(launcher, macLauncherScript(nodePath, opts.scriptPath), { mode: 0o755 })
    try { chmodSync(launcher, 0o755) } catch { /* */ }
  } else {
    writeFileSync(
      dest,
      linuxDesktopFile({ nodePath, scriptPath: opts.scriptPath, workdir: opts.workdir, iconPath }),
    )
  }

  const state: ShortcutState = { path: dest, workdir: opts.workdir, kind: planned.kind }
  writeBorn0600(join(home, STATE_REL), JSON.stringify(state) + '\n')
  if (opts.token?.trim()) {
    writeBorn0600(join(home, TOKEN_REL), opts.token.trim() + '\n')
  }
  return { dest, kind: planned.kind, collided, iconMissing }
}

export function uninstallShortcut(opts: { home?: string } = {}): { removed: string | null } {
  const home = opts.home ?? process.env.CONARIUM_CONSOLE_HOME ?? osHomedir()
  const stateFile = join(home, STATE_REL)
  if (!existsSync(stateFile)) return { removed: null }
  let state: ShortcutState
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as ShortcutState
  } catch {
    return { removed: null }
  }
  if (state.path && existsSync(state.path)) {
    rmSync(state.path, { recursive: true, force: true })
  }
  try { unlinkSync(stateFile) } catch { /* */ }
  const tokenFile = join(home, TOKEN_REL)
  try { unlinkSync(tokenFile) } catch { /* */ }
  return { removed: state.path }
}

export function loadLaunchToken(home = process.env.CONARIUM_CONSOLE_HOME || osHomedir()): string | null {
  const fromEnv = process.env.CONARIUM_CONSOLE_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const file = join(home, TOKEN_REL)
  if (!existsSync(file)) return null
  const v = readFileSync(file, 'utf8').trim()
  return v || null
}

export function loadShortcutState(home = process.env.CONARIUM_CONSOLE_HOME || osHomedir()): ShortcutState | null {
  const file = join(home, STATE_REL)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ShortcutState
  } catch {
    return null
  }
}
