// The identity of one build of dist/, for telling two builds of the same package version apart.
//
// A version bump is the only thing that distinguishes a rebuilt install from the one a long-lived process (a hook server, a resident worker) loaded earlier, and a rebuild between bumps does not change it. The stamp is taken here, at build time, and inlined into the bundle (`__TG_BUILD__`, scripts/build-options.mjs) and written beside it as dist/build-info.json. Nothing computes it at run time: an installed copy has no repository to ask.

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const BUILD_INFO_FILE = 'build-info.json'
export const UNKNOWN_STAMP = 'unknown'

/** The short commit of `root`'s checkout, or `unknown` when there is no git, no .git (a source tarball) or no commit yet. Never throws: a build must not fail for want of an identity. */
export function shortCommit(root) {
  try {
    const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    const sha = res.status === 0 ? res.stdout.trim() : ''
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : UNKNOWN_STAMP
  } catch {
    return UNKNOWN_STAMP
  }
}

/** `<commit>-<UTC build time>`, e.g. `208288b15-20261024T153012Z`. `now` is injectable so a test can build twice at fixed instants. */
export function computeBuildStamp(root, now = new Date()) {
  const commit = shortCommit(root)
  const builtAt = now.toISOString()
  return { commit, builtAt, stamp: `${commit}-${builtAt.replace(/[-:]/g, '').replace(/[.]\d+Z$/, 'Z')}` }
}

export function buildInfoPath(root) {
  return path.join(root, 'dist', BUILD_INFO_FILE)
}

/** Removed before a build starts so a build that dies half way leaves no file claiming the chunks it did not finish are current. */
export function clearBuildInfo(root) {
  rmSync(buildInfoPath(root), { force: true })
}

export function writeBuildInfo(root, version, info) {
  const file = buildInfoPath(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ version, ...info }, null, 2)}\n`)
}
