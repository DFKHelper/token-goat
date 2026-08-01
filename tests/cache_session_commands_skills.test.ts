/**
 * Regression coverage for SKILLCACHE-NO-EVICTION: the 'skills' cache subdir was
 * missing from CACHE_SUBDIRS in cache_session_commands.ts, so prune-cache and
 * clean-cache never evicted skill-output files, unlike every other cache subdir.
 *
 * Kept in its own file (rather than tests/cache_session_commands.test.ts) because
 * that file has unrelated in-progress edits from a concurrent agent this session;
 * this file only touches skill_cache.ts's directory override plus the two CLI
 * command entry points, so it stays isolated from that work.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cmdCleanCache, cmdPruneCache } from '../src/cache_session_commands.js'
import { storeOutput, setSkillOutputsDirForTesting, getAllCachedSkills, SKILLS_OUTPUT_SUBDIR } from '../src/skill_cache.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let tmpHome: string
let tmpSkillsDir: string
let prevHome: string | undefined
let stdoutLines: string[]
let writeSpy: WriteSpy

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmd-cache-skills-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome

  tmpSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-skills-cache-'))
  setSkillOutputsDirForTesting(tmpSkillsDir)

  stdoutLines = []
  writeSpy = spyOnWrite(process.stdout, stdoutLines)
})

afterEach(() => {
  writeSpy.mockRestore()
  setSkillOutputsDirForTesting(null)
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {
    // best-effort cleanup
  }
  try { fs.rmSync(tmpSkillsDir, { recursive: true, force: true }) } catch {
    // best-effort cleanup
  }
})

function capturedOutput(): string {
  return stdoutLines.join('')
}

describe('cmdCleanCache / cmdPruneCache - skills subdir wiring', () => {
  it('includes the skills subdir in JSON removed report', () => {
    cmdCleanCache({ json: true })
    const parsed = JSON.parse(capturedOutput()) as { removed: Record<string, number>; total: number }
    expect(typeof parsed.removed[SKILLS_OUTPUT_SUBDIR]).toBe('number')
  })

  it('clean-cache actually evicts an expired skill output (fail-on-buggy: skills was absent from CACHE_SUBDIRS, so nothing was ever pruned)', async () => {
    const meta = await storeOutput('sess1', 'oldskill', 'Old body')
    expect(meta).not.toBeNull()

    const metaPath = path.join(tmpSkillsDir, `${meta!.outputId}.meta`)
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { ts: number }
    raw.ts = Date.now() - 48 * 3600 * 1000
    fs.writeFileSync(metaPath, JSON.stringify(raw, null, 2))

    cmdCleanCache({})
    const out = capturedOutput()
    expect(out).toContain(`${SKILLS_OUTPUT_SUBDIR}: removed 1`)

    const remaining = await getAllCachedSkills()
    expect(remaining.find((s) => s.name === 'oldskill')).toBeUndefined()
    expect(fs.existsSync(metaPath)).toBe(false)
    expect(fs.existsSync(path.join(tmpSkillsDir, `${meta!.outputId}.txt`))).toBe(false)
  })

  it('prune-cache respects --max-count for the skills subdir', async () => {
    const metaA = await storeOutput('sess1', 'skillA', 'Body A')
    const metaB = await storeOutput('sess1', 'skillB', 'Body B')
    expect(metaA).not.toBeNull()
    expect(metaB).not.toBeNull()

    cmdPruneCache({ maxCount: '1' })
    const out = capturedOutput()
    expect(out).toContain(`${SKILLS_OUTPUT_SUBDIR}: removed 1`)

    const remaining = await getAllCachedSkills()
    expect(remaining.length).toBe(1)
  })
})
