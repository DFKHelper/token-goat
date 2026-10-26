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

/** Where the source-build walk may climb to (`stopAt`, inclusive) and which package root is the running build itself (`ownRoot`, never a source). */
export interface SourceWalk {
  stopAt?: string
  ownRoot?: string
}

/** The working directory, or null when it cannot be read (it was deleted under the process): a default must not throw. */
function currentDir(): string | null {
  try {
    return process.cwd()
  } catch {
    return null
  }
}

/** The token-goat checkout at `from` or an ancestor that has built dist/build-info.json, or null: the source build an installed copy is judged against. Reads package.json and the stamp file only, never git. A copy under a node_modules segment, or the running build's own package root, is not a source: judging an install against itself proves nothing. */
export function findSourceBuild(from: string | null = currentDir(), walk: SourceWalk = {}): { dir: string; info: BuildInfo } | null {
  if (from === null) return null
  const ownRoot = path.resolve(walk.ownRoot ?? path.dirname(bundleDir()))
  const stopAt = walk.stopAt === undefined ? null : path.resolve(walk.stopAt)
  let dir = path.resolve(from)
  for (;;) {
    const distDir = path.join(dir, 'dist')
    const info = isSourceCandidate(dir, ownRoot) ? readBuildInfo(distDir) : null
    if (info !== null) return { dir: distDir, info }
    const parent = path.dirname(dir)
    if (parent === dir || dir === stopAt) return null
    dir = parent
  }
}

function isSourceCandidate(dir: string, ownRoot: string): boolean {
  if (dir === ownRoot || dir.split(/[\\/]/).includes('node_modules')) return false
  return isTokenGoatCheckout(dir)
}

function isTokenGoatCheckout(dir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name === 'token-goat'
  } catch {
    return false
  }
}

/** Judges this process against dist/ beside it and against the source build reachable from `from`; a stale verdict on either side wins. */
function judgeBuild(dir: string | undefined, running: { stamp: string; version: string }, from: string | null, walk: SourceWalk): { stale: boolean; message: string } {
  const local = compareBuilds(running, readBuildInfo(dir))
  if (local.kind === 'stale') return { stale: true, message: staleBuildMessage(local) }
  const source = findSourceBuild(from, walk)
  if (source === null) return { stale: false, message: `${running.stamp} (v${running.version}); unverifiable: no token-goat source build with dist/build-info.json at or above ${from ?? 'the unreadable working directory'}` }
  const verdict = compareBuilds(running, source.info)
  if (verdict.kind === 'stale') return { stale: true, message: `this process runs build ${verdict.running} of v${verdict.version}, but the source build at ${source.dir} is build ${verdict.installed}; rebuild and reinstall, then restart to load it` }
  if (verdict.kind === 'current') return { stale: false, message: `${verdict.stamp} (v${running.version}), matches the source build at ${source.dir}` }
  return { stale: false, message: `${running.stamp} (v${running.version}); unverifiable against ${source.dir}: ${verdict.reason}` }
}

/** One line for a session-start context when this process is older than dist/ on disk or than the source build, else null. */
export function staleBuildNote(dir?: string, running: { stamp: string; version: string } = { stamp: BUILD_STAMP, version: VERSION }, from: string | null = currentDir(), walk: SourceWalk = {}): string | null {
  const judged = judgeBuild(dir, running, from, walk)
  return judged.stale ? `[token-goat: ${judged.message}]` : null
}

/** The doctor row: names the build that is running, and warns when it differs from dist/ beside it or from the source build reachable from `from`, the same version included. Never `fail`: the code still works, it is just not the code on disk. */
export function checkBuild(dir?: string, running: { stamp: string; version: string } = { stamp: BUILD_STAMP, version: VERSION }, from: string | null = currentDir(), walk: SourceWalk = {}): DoctorResult {
  const judged = judgeBuild(dir, running, from, walk)
  return { name: 'Build', status: judged.stale ? 'warn' : 'ok', message: judged.message }
}
