import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.claude/` (mirrors tests/install_codex.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  claudeMdPath,
  installClaudeMd,
  installSkill,
  skillDir,
  skillPath,
  uninstallClaudeMd,
  uninstallSkill,
} from '../src/install.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-claudemd-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(TMP)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installClaudeMd', () => {
  it('writes the delimited block on a fresh install', () => {
    const result = installClaudeMd()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.path)).toBe(true)

    const content = fs.readFileSync(result.path, 'utf8')
    expect(content).toContain('<!-- token-goat-begin -->')
    expect(content).toContain('<!-- token-goat-end -->')
    expect(content).toContain('token-goat symbol NAME')
  })

  it('is idempotent (second call reports alreadyInstalled and does not duplicate the block)', () => {
    installClaudeMd()
    const second = installClaudeMd()
    expect(second.alreadyInstalled).toBe(true)

    const content = fs.readFileSync(claudeMdPath(), 'utf8')
    expect(content.split('<!-- token-goat-begin -->')).toHaveLength(2)
  })

  it('preserves pre-existing non-token-goat CLAUDE.md content outside the delimiters', () => {
    const p = claudeMdPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# My project notes\n\nAlways run `npm test` before committing.\n')

    installClaudeMd()

    const content = fs.readFileSync(p, 'utf8')
    expect(content).toContain('# My project notes')
    expect(content).toContain('Always run `npm test` before committing.')
    expect(content).toContain('<!-- token-goat-begin -->')
  })

  it('refreshes a stale block in place without touching surrounding content', () => {
    const p = claudeMdPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      '# Before\n\n<!-- token-goat-begin -->\nstale content\n<!-- token-goat-end -->\n\n# After\n',
    )

    const result = installClaudeMd()
    expect(result.alreadyInstalled).toBe(false)

    const content = fs.readFileSync(p, 'utf8')
    expect(content).toContain('# Before')
    expect(content).toContain('# After')
    expect(content).not.toContain('stale content')
    expect(content).toContain('token-goat symbol NAME')
  })
})

describe('uninstallClaudeMd', () => {
  it('removes the block and reports true when one was present', () => {
    installClaudeMd()
    expect(uninstallClaudeMd()).toBe(true)

    const content = fs.readFileSync(claudeMdPath(), 'utf8')
    expect(content).not.toContain('<!-- token-goat-begin -->')
  })

  it('reports false when no CLAUDE.md exists', () => {
    expect(uninstallClaudeMd()).toBe(false)
  })

  it('preserves surrounding content and reports false on a second call', () => {
    const p = claudeMdPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# My project notes\n')
    installClaudeMd()

    uninstallClaudeMd()
    const content = fs.readFileSync(p, 'utf8')
    expect(content).toContain('# My project notes')
    expect(content).not.toContain('<!-- token-goat-begin -->')

    expect(uninstallClaudeMd()).toBe(false)
  })
})

describe('installSkill', () => {
  it('writes SKILL.md on a fresh install', () => {
    const result = installSkill()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.path).toBe(skillPath())
    expect(fs.existsSync(result.path)).toBe(true)

    const content = fs.readFileSync(result.path, 'utf8')
    expect(content).toContain('name: token-goat')
    expect(content).toContain('token-goat symbol NAME')
  })

  it('is idempotent (second call reports alreadyInstalled)', () => {
    installSkill()
    const second = installSkill()
    expect(second.alreadyInstalled).toBe(true)
  })

  it('refreshes stale content in place', () => {
    const p = skillPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '---\nname: token-goat\n---\nstale body\n')

    const result = installSkill()
    expect(result.alreadyInstalled).toBe(false)

    const content = fs.readFileSync(p, 'utf8')
    expect(content).not.toContain('stale body')
    expect(content).toContain('token-goat symbol NAME')
  })
})

describe('uninstallSkill', () => {
  it('removes the skill directory and reports true when present', () => {
    installSkill()
    expect(uninstallSkill()).toBe(true)
    expect(fs.existsSync(skillDir())).toBe(false)
  })

  it('reports false when no skill directory exists', () => {
    expect(uninstallSkill()).toBe(false)
  })
})
