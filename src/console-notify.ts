/**
 * Show a launch failure to a human. No silent exit.
 */
import { spawnSync } from 'node:child_process'
import { writeBorn0600 } from './console-shortcut.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function notifyLaunchError(message: string, opts: { platform?: NodeJS.Platform; home?: string } = {}): void {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? process.env.CONARIUM_CONSOLE_HOME ?? homedir()
  const log = join(home, '.conarium', 'console-launch.log')
  try {
    writeBorn0600(log, `${new Date().toISOString()} ${message}\n`)
  } catch { /* still try a dialog */ }

  if (platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${message.replace(/'/g, "''")}', 'Conarium Console')`
    spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
    return
  }
  if (platform === 'darwin') {
    spawnSync('osascript', ['-e', `display dialog ${JSON.stringify(message)} with title "Conarium Console" buttons {"OK"}`], { stdio: 'ignore' })
    return
  }
  const zenity = spawnSync('zenity', ['--error', `--text=${message}`, '--title=Conarium Console'], { stdio: 'ignore' })
  if (zenity.status === 0) return
  spawnSync('notify-send', ['Conarium Console', message], { stdio: 'ignore' })
}

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
    return
  }
  if (platform === 'darwin') {
    spawnSync('open', [url], { stdio: 'ignore' })
    return
  }
  spawnSync('xdg-open', [url], { stdio: 'ignore' })
}
