// Read-deny class fixes: denied files yield no text, open files stay readable. Provenance: HAND-DERIVED.
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from '../src/cli.js'
import { storeBlob } from '../src/disk_cache.js'
import { buildResumePacket } from '../src/resume.js'
import { SESSIONS_SUBDIR } from '../src/session_store.js'
import type { HookEvent } from '../src/hook_registry.js'
import { diagnoseEditFailure, loadNearMiss } from '../src/hooks_tool_failure.js'
import { resetReadDenyCache } from '../src/read_deny.js'
import { preSkillHandler } from '../src/hooks_skill.js'
import { setSkillOutputsDirForTesting, setSkillsSourceDirForTesting, storeOutput } from '../src/skill_cache.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const MARKER = 'denied-skill-marker-text'
let outputsDir: string
let proj: string
let prevCwd: string
let prevProjectDir: string | undefined
let stdout: string[]
let writeSpy: WriteSpy

beforeEach(() => {
  prevCwd = process.cwd()
  prevProjectDir = process.env['CLAUDE_PROJECT_DIR']
  outputsDir = mkdtempSync(join(tmpdir(), 'tg-rdskill-out-'))
  setSkillOutputsDirForTesting(outputsDir)
  proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-rdskill-')))
  mkdirSync(join(proj, '.claude'))
  const rules = { permissions: { deny: ['Read(locked/**)'] } }
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify(rules))
  for (const dir of ['locked', 'open']) {
    mkdirSync(join(proj, dir))
    writeFileSync(join(proj, dir, 'SKILL.md'), `# Doc\n\n## Usage\n${MARKER}\n<!-- COMPACT_END -->\n`)
  }
  process.chdir(proj)
  process.env['CLAUDE_PROJECT_DIR'] = proj
  resetReadDenyCache()
  stdout = []
  writeSpy = spyOnWrite(process.stdout, stdout)
})

afterEach(() => {
  writeSpy.mockRestore()
  process.chdir(prevCwd)
  if (prevProjectDir === undefined) delete process.env['CLAUDE_PROJECT_DIR']
  else process.env['CLAUDE_PROJECT_DIR'] = prevProjectDir
  resetReadDenyCache()
  setSkillOutputsDirForTesting(null)
  rmSync(outputsDir, { recursive: true, force: true })
  rmSync(proj, { recursive: true, force: true })
})

async function runCli(args: string[]): Promise<void> {
  const prev = process.exitCode
  process.exitCode = 0
  try {
    await run(['node', 'token-goat', ...args])
  } finally {
    process.exitCode = prev
  }
}

describe('skill commands honor host Read deny rules', () => {
  it('skill-section refuses a denied skill file and prints the same section from an open one', async () => {
    await storeOutput('s1', 'lockedskill', 'cached', { sourcePath: join(proj, 'locked', 'SKILL.md') })
    await storeOutput('s1', 'openskill', 'cached', { sourcePath: join(proj, 'open', 'SKILL.md') })
    await runCli(['skill-section', 'lockedskill::Usage'])
    expect(stdout.join('')).not.toContain(MARKER)
    await runCli(['skill-section', 'openskill::Usage'])
    expect(stdout.join('')).toContain(MARKER)
  })

  it('skill-body refuses a denied skill file and prints an open one', async () => {
    await storeOutput('s1', 'lockedskill', 'cached', { sourcePath: join(proj, 'locked', 'SKILL.md') })
    await storeOutput('s1', 'openskill', 'cached', { sourcePath: join(proj, 'open', 'SKILL.md') })
    await runCli(['skill-body', 'lockedskill'])
    expect(stdout.join('')).not.toContain(MARKER)
    await runCli(['skill-body', 'openskill'])
    expect(stdout.join('')).toContain(MARKER)
  })

  it('compact-doc --heading (legacy mode) refuses a denied file and prints an open one', async () => {
    await runCli(['compact-doc', join(proj, 'locked', 'SKILL.md'), '--heading', 'Usage'])
    expect(stdout.join('')).not.toContain(MARKER)
    await runCli(['compact-doc', join(proj, 'open', 'SKILL.md'), '--heading', 'Usage'])
    expect(stdout.join('')).toContain(MARKER)
  })

  it('a failed Edit gets no near-miss advice quoting a denied file, and gets it for an open one', async () => {
    await loadNearMiss()
    const nbsp = String.fromCharCode(160)
    const body = `# notes\n- keep it as a note only, never${nbsp}sent from here ${MARKER}.\n`
    const oldString = `- keep it as a note only, never sent from here ${MARKER}.`
    const failed = (file: string): string | null =>
      diagnoseEditFailure(
        {
          eventName: 'post_tool_use_failure',
          toolName: 'Edit',
          toolInput: { file_path: file, old_string: oldString, new_string: 'x' },
          sessionId: 'rd-skills',
          agentId: undefined,
          raw: { session_id: 'rd-skills', tool_name: 'Edit', cwd: proj },
        } as unknown as HookEvent,
        'String to replace not found in file.',
      )
    writeFileSync(join(proj, 'locked', 'a.txt'), body)
    writeFileSync(join(proj, 'open', 'a.txt'), body)
    expect(failed(join(proj, 'locked', 'a.txt'))).toBeNull()
    expect(failed(join(proj, 'open', 'a.txt')) ?? '').toContain(MARKER)
  })

  it('the oversized first-load skill deny inlines no compact slice from a denied skill file', async () => {
    const compact = `Compact summary ${MARKER}.`
    const big = `${compact}\n<!-- COMPACT_END -->\n${'x'.repeat(7000)}`
    for (const dir of ['locked', 'open']) {
      mkdirSync(join(proj, dir, 'big-skill'), { recursive: true })
      writeFileSync(join(proj, dir, 'big-skill', 'SKILL.md'), big)
    }
    const preEvent = makeHookEvent({
      eventName: 'pre_tool_use',
      toolName: 'Skill',
      toolInput: { skill: 'big-skill' },
      sessionId: 'rd-skill-pre',
      raw: { cwd: proj },
    })
    setSkillsSourceDirForTesting(join(proj, 'locked'))
    const denied = await preSkillHandler(preEvent)
    setSkillsSourceDirForTesting(join(proj, 'open'))
    const open = await preSkillHandler(preEvent)
    setSkillsSourceDirForTesting(null)
    expect(open.hookType).toBe('deny')
    expect(JSON.stringify(denied)).not.toContain(MARKER)
    expect(JSON.stringify(open)).toContain(MARKER)
  })

  it('the resume packet omits a denied skill checklist and keeps an open one', async () => {
    const sessionId = 'rd-resume'
    expect(storeBlob(SESSIONS_SUBDIR, sessionId, { files: [], bashOutputs: [] })).toBe(true)
    const body = `# S\n\n## Checklist\n- ${MARKER}\n\n## Other\nx\n`
    for (const dir of ['locked', 'open']) {
      writeFileSync(join(proj, dir, 'sk.md'), body)
      await storeOutput(sessionId, `${dir}-skill`, body, { sourcePath: join(proj, dir, 'sk.md') })
    }
    const packet = (await buildResumePacket(sessionId)) ?? ''
    const lockedPart = packet.split('open-skill')[0] ?? ''
    expect(packet).toContain('locked-skill')
    expect(lockedPart.includes(MARKER)).toBe(false)
    expect(packet.split(MARKER).length - 1).toBe(1)
  })

  it('write-file --from refuses a denied source file and copies an open one', async () => {
    writeFileSync(join(proj, 'locked', 'src.txt'), MARKER)
    writeFileSync(join(proj, 'open', 'src.txt'), MARKER)
    const lockedDest = join(proj, 'out-locked.txt')
    const openDest = join(proj, 'out-open.txt')
    await runCli(['write-file', lockedDest, '--from', join(proj, 'locked', 'src.txt')])
    await runCli(['write-file', openDest, '--from', join(proj, 'open', 'src.txt')])
    expect(existsSync(lockedDest)).toBe(false)
    expect(existsSync(openDest)).toBe(true)
  })

  it('image-slice --out writes nothing from a denied image and writes the slice of an open one', async () => {
    // HAND-DERIVED: the 1x1 PNG from the PNG specification's minimal example (one white pixel).
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
    const png = Buffer.from(b64, 'base64')
    writeFileSync(join(proj, 'locked', 'p.png'), png)
    writeFileSync(join(proj, 'open', 'p.png'), png)
    const lockedOut = join(proj, 'slice-locked.png')
    const openOut = join(proj, 'slice-open.png')
    await runCli(['image-slice', join(proj, 'locked', 'p.png'), '--out', lockedOut])
    await runCli(['image-slice', join(proj, 'open', 'p.png'), '--out', openOut])
    expect(existsSync(lockedOut)).toBe(false)
    expect(existsSync(openOut)).toBe(true)
  })

  it('skill-compact --path refuses a denied file before it caches a compact from it', async () => {
    await runCli(['skill-compact', 'lockedskill', '--path', join(proj, 'locked', 'SKILL.md')])
    await runCli(['skill-body', 'lockedskill', '--compact'])
    expect(stdout.join('')).not.toContain(MARKER)
    await runCli(['skill-compact', 'openskill', '--path', join(proj, 'open', 'SKILL.md')])
    expect(process.exitCode ?? 0).toBe(0)
  })
})
