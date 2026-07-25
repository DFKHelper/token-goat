/**
 * Guard against hand-rolled Windows path normalization in test fixtures.
 *
 * A test that builds a synthetic file_path/session-path fixture by hand-flipping
 * backslashes to forward slashes and lowercasing the drive letter (instead of importing
 * normalizePath from src/paths.ts) silently diverges from it on a runner whose %TEMP% is
 * pinned to its 8.3 short form -- GitHub's windows-latest uses `RUNNER~1`, and
 * normalizePath expands that to its long form while a hand-rolled version does not. The
 * fixture then never matches what the app's own normalizePath-routed code produces at
 * runtime, so the test fails on CI while passing on a dev machine whose %TEMP% happens not
 * to be short-form. This exact anti-pattern has already caused three separate incidents
 * (commit 442f42d3, the cmdHot --project regression test, and cli_waste.test.ts's
 * no-transcript-found --json test in commit f592ea05) -- the third one slipped past this
 * guard's original detection, which additionally required a dedicated `[A-Za-z]`
 * drive-letter capture-group regex to be present; a blanket whole-string `.toLowerCase()`
 * folds the drive letter too without needing one, so that variant went undetected. The
 * drive-letter-regex requirement is dropped below so this guard makes a fourth one fail
 * loudly and locally instead of silently only on CI.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const TESTS_DIR = path.join(ROOT, 'tests')

function walkTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTestFiles(full, out)
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

// The literal regex-literal token a hand-rolled backslash-to-forward-slash conversion uses.
const BACKSLASH_TO_SLASH_TOKEN = '/\\\\/g'

describe('no hand-rolled Windows path normalization in test fixtures', () => {
  it('every test file that flips backslashes to slashes for a path fixture and also lowercases it imports normalizePath from src/paths.ts instead of reimplementing it', () => {
    const offenders: string[] = []
    for (const file of walkTestFiles(TESTS_DIR)) {
      const src = fs.readFileSync(file, 'utf8')
      if (!src.includes(BACKSLASH_TO_SLASH_TOKEN)) continue
      if (!src.toLowerCase().includes('tolowercase()')) continue
      const importsNormalizePath = /from\s+['"](\.\.\/)+src\/paths\.js['"]/.test(src) && src.includes('normalizePath')
      if (importsNormalizePath) continue
      offenders.push(path.relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })
})
