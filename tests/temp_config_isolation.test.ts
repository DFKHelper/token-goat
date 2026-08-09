// Regression guard for a cross-run test-isolation leak.
// Several test files redirect `constants.js::configPath()` at a real file so they can exercise the real `loadConfig()`; they used to build that path by joining the shared OS temp dir with a file name containing the current process id. The OS temp dir is shared between runs and OS pids are recycled, so the config one run's vitest fork wrote (tests/hooks_browser_image.test.ts's last test saves `image_shrink.enabled = false`; tests/indexing_config_gates.test.ts saves `large_file_symbol_only_kb = 1`) was still on disk when a later run's fork was handed the same pid -- and that stale file became the later run's *starting* config. tests/hooks_browser_image.test.ts then failed six assertions ('pass' instead of 'rewriteOutput') while passing in isolation. 1207 such stale files had accumulated in the temp dir.
// The fix is tests/helpers/temp-config.ts::tempConfigPath, which mkdtemps a fresh directory per call and removes it on process exit. This file locks in both halves: the helper's uniqueness, and the absence of any new pid-keyed config path.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tempConfigPath } from './helpers/temp-config.js'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))

describe('temp config path isolation', () => {
  it('gives every caller its own directory, and never an existing file', () => {
    const a = tempConfigPath('config.toml')
    const b = tempConfigPath('config.toml')
    expect(path.dirname(a)).not.toBe(path.dirname(b))
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(path.dirname(a))).toBe(true)
  })

  it('no test file keys a config/db temp path on process.pid (a recycled pid leaks state into a later run)', () => {
    const offenders: string[] = []
    for (const name of fs.readdirSync(TESTS_DIR)) {
      if (!name.endsWith('.test.ts')) continue
      const src = fs.readFileSync(path.join(TESTS_DIR, name), 'utf-8')
      for (const line of src.split(/\r?\n/)) {
        if (/tmpdir\(\)/.test(line) && /\$\{process\.pid\}\.(?:toml|sqlite)/.test(line)) offenders.push(`${name}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
