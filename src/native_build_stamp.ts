/** The package version stamped into a native hook client at build time, read through its `--selftest`. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'

const BUILD = /^(\d+)\.(\d+)\.(\d+)$/

/** The `build` a binary's `--selftest` reports; undefined when it is absent, unstamped, or not a plain x.y.z. */
export function nativeBuildStamp(bin: string): string | undefined {
  if (!fs.existsSync(bin)) return undefined
  const res = spawnSync(bin, ['--selftest'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (res.error !== undefined || res.status !== 0) return undefined
  try {
    const build = (JSON.parse(res.stdout) as { build?: unknown }).build
    return typeof build === 'string' && BUILD.test(build) ? build : undefined
  } catch {
    return undefined
  }
}

/** Whether build `a` is strictly newer than build `b`, both plain x.y.z versions. */
export function newerBuild(a: string, b: string): boolean {
  const x = BUILD.exec(a)
  const y = BUILD.exec(b)
  if (x === null || y === null) return false
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return d > 0
  }
  return false
}
