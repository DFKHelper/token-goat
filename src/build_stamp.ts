/** Tells a process that its bundle was rebuilt under it. A package version changes only when someone bumps it, so a rebuild at the same version leaves a hook server or session that loaded the earlier bundle running old code under an unchanged version number. Every build inlines its identity (`BUILD_STAMP`, src/version.ts) and writes the same value to dist/build-info.json beside the chunks (scripts/build-stamp.mjs); a process compares the one it was built with against the one on disk now. Nothing here consults git. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DoctorResult } from './doctor_result.js'
import { BUILD_STAMP, VERSION } from './version.js'

export const BUILD_INFO_FILE = 'build-info.json'

export interface BuildInfo {
  version: string
  stamp: string
  builtAt?: string
}

/** The directory the running bundle's chunks sit in. Under tsx/vitest this is src/, which has no build-info.json, so every check below reads "no stamp on disk" from source. */
function bundleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url))
}

/** The stamp file in `dir` (default: beside the running bundle), or null when it is absent or unreadable -- an install from before stamps existed, or a source checkout. Fail-soft: a session start must not fail over a diagnostic. */
export function readBuildInfo(dir: string = bundleDir()): BuildInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, BUILD_INFO_FILE), 'utf8')) as Partial<BuildInfo> | null
    if (raw === null || typeof raw !== 'object' || typeof raw.stamp !== 'string' || raw.stamp === '' || typeof raw.version !== 'string') return null
    return { version: raw.version, stamp: raw.stamp, ...(typeof raw.builtAt === 'string' ? { builtAt: raw.builtAt } : {}) }
  } catch {
    return null
  }
}

export type BuildVerdict =
  | { kind: 'current'; stamp: string }
  | { kind: 'stale'; running: string; installed: string; version: string }
  | { kind: 'unverifiable'; running: string; reason: string }

/** Compares a process's build against the one on disk. Only a same-version mismatch between two real stamps is `stale`: a different version is the upgrade path's business (`update`), and `unknown` on either side proves nothing, so it is reported as unverifiable rather than guessed at. */
export function compareBuilds(running: { stamp: string; version: string }, installed: BuildInfo | null): BuildVerdict {
  if (installed === null) return { kind: 'unverifiable', running: running.stamp, reason: 'no build-info.json beside the bundle' }
  if (running.stamp === 'unknown' || installed.stamp === 'unknown') return { kind: 'unverifiable', running: running.stamp, reason: 'the build carries no commit stamp (built without .git)' }
  if (installed.version !== running.version) return { kind: 'unverifiable', running: running.stamp, reason: `installed version is ${installed.version}, not ${running.version}` }
  if (installed.stamp === running.stamp) return { kind: 'current', stamp: running.stamp }
  return { kind: 'stale', running: running.stamp, installed: installed.stamp, version: running.version }
}

export function staleBuildMessage(v: Extract<BuildVerdict, { kind: 'stale' }>): string {
  return `this process runs build ${v.running} of v${v.version}, but dist/ on disk is build ${v.installed} of the same version; restart it (or the session) to load the rebuilt code`
}

/** One line for a session-start context when this process is older than the bundle on disk, else null. */
export function staleBuildNote(dir?: string, running: { stamp: string; version: string } = { stamp: BUILD_STAMP, version: VERSION }): string | null {
  const verdict = compareBuilds(running, readBuildInfo(dir))
  return verdict.kind === 'stale' ? `[token-goat: ${staleBuildMessage(verdict)}]` : null
}

/** The doctor row: names the build that is running, and warns when dist/ on disk is a different build of the same version. Never `fail`: the code still works, it is just not the code on disk. */
export function checkBuild(dir?: string, running: { stamp: string; version: string } = { stamp: BUILD_STAMP, version: VERSION }): DoctorResult {
  const name = 'Build'
  const verdict = compareBuilds(running, readBuildInfo(dir))
  if (verdict.kind === 'stale') return { name, status: 'warn', message: staleBuildMessage(verdict) }
  if (verdict.kind === 'current') return { name, status: 'ok', message: `${verdict.stamp} (v${running.version}), matches dist/build-info.json` }
  return { name, status: 'ok', message: `${running.stamp} (v${running.version}); not checked against dist/: ${verdict.reason}` }
}
