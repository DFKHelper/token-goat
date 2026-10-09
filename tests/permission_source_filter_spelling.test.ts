/** The permission-source filter (tests/setup/permission-source-filter.cjs) must admit a source under the run root whichever spelling of the root it is reached by: git records a linked worktree's main checkout by real path, so on macOS (/var is a link to /private/var) and Windows (8.3 RUNNER~1 against runneradmin) the root a fixture reads is spelled differently from the run root, and a lexical compare hid the main checkout's deny rule and the Codex rules file from the code under test. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cjs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'setup', 'permission-source-filter.cjs')

/** Ask the filter, installed for `root` in a fresh node process, about each source. */
function ask(root: string, sources: string[]): boolean[] {
  const probe = ["const f = globalThis[Symbol.for('token-goat.permission-source-filter')]", `process.stdout.write(JSON.stringify(${JSON.stringify(sources)}.map((s) => f(s))))`].join(';')
  const res = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, TG_TEST_PERMISSION_ROOT: root, NODE_OPTIONS: `--require "${cjs.replaceAll('\\', '/')}"` } })
  return JSON.parse(res.stdout) as boolean[]
}

describe('permission source filter path spelling', () => {
  // HAND-DERIVED: a directory link stands for macOS /var -> /private/var and for a Windows 8.3 name; the root is given by the link and the source by its target (or the reverse), as git's recorded worktree paths and the run root are on a CI runner.
  it('admits a source reached by the real path when the run root is a link, and the reverse', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-filter-spelling-')))
    try {
      const real = path.join(base, 'real')
      const link = path.join(base, 'link')
      fs.mkdirSync(path.join(real, 'main', '.claude'), { recursive: true })
      fs.symlinkSync(real, link, 'junction')
      const viaReal = path.join(real, 'main', '.claude', 'settings.local.json')
      const viaLink = path.join(link, 'main', '.claude', 'settings.local.json')
      expect(ask(link, [viaReal, viaLink])).toEqual([true, true])
      expect(ask(real, [viaReal, viaLink])).toEqual([true, true])
      // A source that does not exist yet is spelled through its nearest existing ancestor.
      expect(ask(link, [path.join(real, 'main', 'later', 'x.json')])).toEqual([true])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('still refuses a source outside the root, one named by the root itself, and a registry key', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-filter-spelling-')))
    try {
      const root = path.join(base, 'root')
      const outside = path.join(base, 'outside')
      fs.mkdirSync(root)
      fs.mkdirSync(outside)
      fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
      expect(ask(root, [path.join(outside, 'x.json'), root, 'registry:HKLM', path.join(root, '..', 'outside', 'x.json'), path.join(root, 'escape', 'x.json')])).toEqual([false, false, false, false, false])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})
