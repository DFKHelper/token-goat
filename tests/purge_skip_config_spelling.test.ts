import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanReferences } from '../src/purge.js'

// HAND-DERIVED: a linked directory stands in for the two spellings one file gets from the OS (macOS /private/var against /var, a Windows 8.3 RUNNER~1 name against runneradmin), which CI hit and a short user name hides locally.
describe('scanReferences skipConfigs when the caller and the host spell one file differently', () => {
  let root: string
  let saved: string | undefined

  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-purge-skip-')))
    saved = process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('skips a config named through a link to its directory, so a settings file the caller already judged does not make the scan ambiguous', () => {
    const real = path.join(root, 'real')
    const alias = path.join(root, 'alias')
    fs.mkdirSync(path.join(real, 'claude'), { recursive: true })
    fs.writeFileSync(path.join(real, 'claude', 'settings.json'), '{ not json')
    fs.symlinkSync(real, alias, 'junction')
    process.env.CLAUDE_CONFIG_DIR = path.join(real, 'claude')
    const project = path.join(root, 'project')
    fs.mkdirSync(project)

    const unskipped = scanReferences({ cwd: project })
    expect(unskipped.ambiguous.some((m) => m.includes('is not valid JSON'))).toBe(true)

    const skipped = scanReferences({ cwd: project, skipConfigs: [path.join(alias, 'claude', 'settings.json')] })
    expect(skipped.ambiguous.filter((m) => m.includes('is not valid JSON'))).toEqual([])
  })
})
