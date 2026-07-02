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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { run } from '../src/cli.js'
import { setSkillOutputsDirForTesting, storeOutput } from '../src/skill_cache.js'

let outputsDir: string
let sourceDir: string
let skillFile: string
let stdout: string[]
let writeSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  outputsDir = mkdtempSync(join(tmpdir(), 'tg-skillsection-'))
  setSkillOutputsDirForTesting(outputsDir)
  sourceDir = mkdtempSync(join(tmpdir(), 'tg-skillsection-src-'))
  skillFile = join(sourceDir, 'SKILL.md')
  writeFileSync(skillFile, ['# Doc', '', '## Usage', 'usage body text', ''].join('\n'), 'utf-8')
  stdout = []
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
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
