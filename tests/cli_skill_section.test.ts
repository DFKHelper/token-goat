// Regression guard: `skill-section <name>::<heading>` (single positional arg form) used
// `nameHeading.split('::')` and rejected any spec where the split didn't produce exactly 2
// parts. A heading whose own text contains an embedded "::" pushes the split past 2 parts, so
// a perfectly valid spec naming a real skill and a real heading was rejected with the format
// error. This drives the real run() entry against a skill-outputs cache meta so it exercises
// the same separator-finding logic (findSpecSeparator / lastIndexOf) used by the file::symbol
// and file::Heading specs parsed elsewhere in the CLI.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { setSkillOutputsDirForTesting, storeOutput } from '../src/skill_cache.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let outputsDir: string
let sourceDir: string
let skillFile: string
let stdout: string[]
let writeSpy: WriteSpy

beforeEach(() => {
  outputsDir = mkdtempSync(join(tmpdir(), 'tg-skillsection-'))
  setSkillOutputsDirForTesting(outputsDir)
  sourceDir = mkdtempSync(join(tmpdir(), 'tg-skillsection-src-'))
  skillFile = join(sourceDir, 'SKILL.md')
  writeFileSync(skillFile, ['# Doc', '', '## Usage', 'usage body text', ''].join('\n'), 'utf-8')
  stdout = []
  writeSpy = spyOnWrite(process.stdout, stdout)
})

afterEach(() => {
  writeSpy.mockRestore()
  setSkillOutputsDirForTesting(null)
  rmSync(outputsDir, { recursive: true, force: true })
  rmSync(sourceDir, { recursive: true, force: true })
})

async function runSkillSection(spec: string): Promise<number | string | undefined> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', 'skill-section', spec])
    return process.exitCode
  } finally {
    process.exitCode = prev
  }
}

describe('skill-section spec parsing', () => {
  it('resolves a name::heading spec whose skill name has an embedded "::" segment', async () => {
    await storeOutput('sess-1', 'myskill::v2', 'cached body', { sourcePath: skillFile })

    const code = await runSkillSection('myskill::v2::Usage')

    expect(code).toBe(0)
    expect(stdout.join('')).toContain('usage body text')
  })
})

// Regression guard: cmdSkillSection deliberately sets process.exitCode = 1 (without throwing)
// when the requested heading isn't found in the skill file. The buildProgram() `guard()`
// wrapper that registers every guard-wrapped command (skill-section among them) used to run
// `process.exitCode = 0` unconditionally after the handler resolved, clobbering that 1 back to
// 0 and reporting a real "section not found" failure as success. Drive the real run() entry so
// this exercises the actual guard() + handler wiring, not the handler in isolation.
describe('skill-section exit code on a missing heading', () => {
  it('exits 1 instead of the guard() wrapper clobbering the handler-set exit code back to 0', async () => {
    await storeOutput('sess-1', 'myskill-notfound', 'cached body', { sourcePath: skillFile })

    const code = await runSkillSection('myskill-notfound::NoSuchHeading')

    expect(code).toBe(1)
  })
})
