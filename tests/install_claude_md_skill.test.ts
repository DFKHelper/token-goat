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
  findStrayClaudeMdBlocks,
  installClaudeMd,
  installSkill,
  skillDir,
  skillPath,
  uninstallClaudeMd,
  uninstallSkill,
} from '../src/install.js'
import { checkStrayClaudeMdBlocks } from '../src/cli_doctor.js'

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
    expect(content).toContain('token-goat map --compact')
    expect(content).toContain('token-goat refs')
    expect(content).toContain('token-goat changed --symbol')
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
    expect(content).toContain('token-goat map --compact')
    expect(content).toContain('token-goat refs')
    expect(content).toContain('token-goat changed --symbol')
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

describe('findStrayClaudeMdBlocks', () => {
  // Writes a markdown file under ~/.claude containing a real token-goat block, simulating a
  // user tidying the block out of CLAUDE.md into a "reference" file.
  const writeStray = (...segments: string[]): string => {
    installClaudeMd()
    const block = fs.readFileSync(claudeMdPath(), 'utf8')
    const p = path.join(TMP, '.claude', ...segments)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `# Notes\n\n${block}\n`)
    return p
  }

  it('reports nothing when the block lives only in CLAUDE.md', () => {
    installClaudeMd()
    expect(findStrayClaudeMdBlocks()).toEqual([])
  })

  it('reports nothing when no install has happened at all', () => {
    expect(findStrayClaudeMdBlocks()).toEqual([])
  })

  it('finds a block relocated into another markdown file', () => {
    const stray = writeStray('reference', 'tools.md')
    expect(findStrayClaudeMdBlocks()).toEqual([stray])
  })

  it('never reports CLAUDE.md itself, even though it holds the canonical block', () => {
    installClaudeMd()
    const strays = findStrayClaudeMdBlocks()
    expect(strays).not.toContain(claudeMdPath())
  })

  it('finds strays nested several directories deep', () => {
    const stray = writeStray('docs', 'notes', 'deep', 'cheatsheet.md')
    expect(findStrayClaudeMdBlocks()).toContain(stray)
  })

  it('ignores non-markdown files and markdown without the marker', () => {
    installClaudeMd()
    const dir = path.join(TMP, '.claude', 'reference')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Just notes, no marker here\n')
    fs.writeFileSync(path.join(dir, 'block.txt'), '<!-- token-goat-begin -->\n')
    expect(findStrayClaudeMdBlocks()).toEqual([])
  })

  it('skips node_modules so a vendored copy of the docs is not flagged', () => {
    const buried = writeStray('node_modules', 'some-pkg', 'README.md')
    expect(findStrayClaudeMdBlocks()).not.toContain(buried)
  })

  // Regression: a substring match flagged the pointer note left behind *after* correctly
  // relocating a block back to CLAUDE.md -- the file was clean, but its prose named the
  // marker, so doctor warned about it forever. Verbatim text that triggered it.
  it('does not flag prose that merely mentions the marker inline', () => {
    installClaudeMd()
    const p = path.join(TMP, '.claude', 'reference', 'tools.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      '**token-goat:** the command cheatsheet is a token-goat-managed block in ' +
        '`~/.claude/CLAUDE.md` (between `<!-- token-goat-begin -->` / `<!-- token-goat-end -->`), ' +
        'refreshed by `token-goat install`.\n',
    )
    expect(findStrayClaudeMdBlocks()).toEqual([])
  })

  it('does not flag an orphaned begin marker with no matching end', () => {
    installClaudeMd()
    const p = path.join(TMP, '.claude', 'partial.md')
    fs.writeFileSync(p, '<!-- token-goat-begin -->\n## token-goat\n\nsome notes, never closed\n')
    expect(findStrayClaudeMdBlocks()).toEqual([])
  })

  it('reports every stray when the block was copied to more than one file', () => {
    const a = writeStray('reference', 'tools.md')
    const b = writeStray('reference', 'cheatsheet.md')
    expect(findStrayClaudeMdBlocks()).toEqual([b, a].sort())
  })
})

describe('checkStrayClaudeMdBlocks', () => {
  it('passes when there is nothing to report', () => {
    installClaudeMd()
    const result = checkStrayClaudeMdBlocks(path.join(TMP, '.claude'))
    expect(result.status).toBe('ok')
  })

  it('warns and names the offending path when a stray exists', () => {
    installClaudeMd()
    const block = fs.readFileSync(claudeMdPath(), 'utf8')
    const stray = path.join(TMP, '.claude', 'reference', 'tools.md')
    fs.mkdirSync(path.dirname(stray), { recursive: true })
    fs.writeFileSync(stray, block)

    const result = checkStrayClaudeMdBlocks(path.join(TMP, '.claude'))
    expect(result.status).toBe('warn')
    expect(result.message).toContain(stray)
    // The warning has to say *why* it matters, or a user just re-tidies it back.
    expect(result.message).toContain('stale')
  })
})
