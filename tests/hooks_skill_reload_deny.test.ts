import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { tempConfigPath } from './helpers/temp-config.js'
import { makeHookEvent } from './helpers/hook-event.js'

const state = vi.hoisted(() => ({ mode: 'allow' as 'allow' | 'deny' | 'throw', headingReads: 0 }))

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => tempConfigPath('tg-hooks-skill-reload-deny.toml') }
})
vi.mock('../src/bridges/registry.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, getHarnessName: () => 'copilot_cli' }
})
vi.mock('../src/read_deny.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    readDenial: (target: string) => {
      if (state.mode === 'throw') throw new Error('deny lookup failed for ' + target)
      return state.mode === 'deny' ? 'read refused: ' + target : null
    },
  }
})
vi.mock('../src/hint_target.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    hintTarget: () => {
      state.headingReads++
      return { real: true, name: 'SecretHeading' }
    },
  }
})

import { preSkillHandler } from '../src/hooks_skill.js'
import { setSkillOutputsDirForTesting, storeOutput } from '../src/skill_cache.js'
import { clearModuleCaches } from '../src/reset.js'

const SKILL = 'reload-deny-skill'
const SESSION = 'sess-reload-deny'
let root: string
let skillFile: string
let savedDirs: string | undefined

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reload-deny-'))
  const dir = path.join(root, 'skills', 'custom')
  fs.mkdirSync(dir, { recursive: true })
  skillFile = path.join(dir, 'SKILL.md')
  fs.writeFileSync(skillFile, '---\nname: ' + SKILL + '\n---\n# SecretHeading\nbody\n')
  setSkillOutputsDirForTesting(path.join(root, 'outputs'))
  savedDirs = process.env['COPILOT_SKILLS_DIRS']
  process.env['COPILOT_SKILLS_DIRS'] = path.join(root, 'skills')
  clearModuleCaches()
  state.mode = 'allow'
  state.headingReads = 0
  await storeOutput(SESSION, SKILL, 'cached body', { sourcePath: skillFile })
})

afterEach(() => {
  vi.restoreAllMocks()
  setSkillOutputsDirForTesting(null)
  if (savedDirs === undefined) delete process.env['COPILOT_SKILLS_DIRS']
  else process.env['COPILOT_SKILLS_DIRS'] = savedDirs
  fs.rmSync(root, { recursive: true, force: true })
})

function reload() {
  return preSkillHandler(makeHookEvent({ toolName: 'Skill', toolInput: { skill: SKILL }, sessionId: SESSION }))
}

describe('preSkillHandler cached reload on Copilot: the deny check precedes any read of the skill file', () => {
  it('a denied skill file is not read, names no heading and gets the placeholder', async () => {
    state.mode = 'deny'
    const read = vi.spyOn(fs, 'readFileSync')
    const out = await reload()
    expect(read.mock.calls.filter((c) => String(c[0]) === skillFile)).toEqual([])
    expect(state.headingReads).toBe(0)
    expect(JSON.stringify(out)).not.toContain('SecretHeading')
    expect(out.hookType).toBe('deny')
    expect(JSON.stringify(out)).toContain('<heading>')
  })

  it('a failing deny lookup answers as denied and never throws', async () => {
    state.mode = 'throw'
    const read = vi.spyOn(fs, 'readFileSync')
    const out = await reload()
    expect(read.mock.calls.filter((c) => String(c[0]) === skillFile)).toEqual([])
    expect(out.hookType).toBe('deny')
    expect(JSON.stringify(out)).toContain('<heading>')
  })

  it('an allowed skill file still gets the reload deny with its real heading', async () => {
    const out = await reload()
    expect(out.hookType).toBe('deny')
    expect(JSON.stringify(out)).toContain('SecretHeading')
    expect(JSON.stringify(out)).toContain('skill-section')
  })
})
