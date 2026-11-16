import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DoctorResult } from './doctor_result.js'
import { fencedCommand } from './hint_suggestion_guard.js'
import { realEntryPath } from './install_entry.js'
import { resolveOnPath } from './process_util.js'
import { extractErrorMessage } from './util.js'

const NAME = 'Hook entry build'

/** The token-goat bundle a wired hook command runs, or null when none names one (a native binary entry has none). */
function hookEntryBundle(wired: readonly (readonly string[])[]): string | null {
  for (const words of wired) {
    const bundle = words.find((word) => /token-goat\.mjs$/i.test(word))
    if (bundle !== undefined) return bundle
  }
  return null
}

/** The SHA-256 of a bundle, or why it cannot be read (a directory, EACCES): the doctor reports that as a warning rather than throwing. */
function sha256Of(file: string): { hash: string } | { error: string } {
  try {
    return { hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
  } catch (e) {
    return { error: extractErrorMessage(e) }
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** The bundle the PATH `token-goat` launcher runs, or null. Reads the disk only: no npm is spawned. */
export function pathCliBundle(): string | null {
  const launcher = resolveOnPath('token-goat')
  if (launcher === null) return null
  const bundle = process.platform === 'win32'
    ? path.join(path.dirname(launcher), 'node_modules', 'token-goat', 'dist', 'token-goat.mjs')
    : realEntryPath(launcher)
  return /token-goat\.mjs$/i.test(bundle) && isFile(bundle) ? bundle : null
}

/** Compares the bundle the hooks run with the one the PATH CLI runs. Null when no hook runs a bundle. */
export function checkHookEntryBuild(wired: readonly (readonly string[])[], pathCli: () => string | null = pathCliBundle): DoctorResult | null {
  const entry = hookEntryBundle(wired)
  if (entry === null) return null
  const recovery = `Recovery: run ${fencedCommand('token-goat doctor --fix')} from the installed build, then restart any running session.`
  if (!fs.existsSync(entry)) return { name: NAME, status: 'warn', message: `hooks run ${entry}, which does not exist. ${recovery}` }
  const cli = pathCli()
  if (cli === null) {
    return { name: NAME, status: 'warn', message: `hook entry build unknown: cannot find the PATH CLI build to compare with hook entry ${entry}; run npm install -g token-goat.` }
  }
  const entryRead = sha256Of(entry)
  if ('error' in entryRead) return { name: NAME, status: 'warn', message: `cannot read hook entry ${entry} (${entryRead.error}). ${recovery}` }
  const cliRead = sha256Of(cli)
  if ('error' in cliRead) return { name: NAME, status: 'warn', message: `cannot read the PATH CLI build ${cli} (${cliRead.error}); run npm install -g token-goat.` }
  const entryHash = entryRead.hash
  const cliHash = cliRead.hash
  if (entryHash === cliHash) return { name: NAME, status: 'ok', message: `hook entry ${entry} matches the PATH CLI build` }
  return {
    name: NAME,
    status: 'warn',
    message: `hook entry build != PATH CLI build: hooks run ${entry} (sha256 ${entryHash.slice(0, 12)}), the PATH CLI runs ${cli} (sha256 ${cliHash.slice(0, 12)}). ${recovery}`,
  }
}
