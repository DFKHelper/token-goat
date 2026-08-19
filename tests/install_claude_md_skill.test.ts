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
import { buildGuidanceBlock, buildGuidanceBody } from '../src/bridges/guidance_block.js'

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
    expect(content).toContain('answer one question first')
    expect(content).toContain('violation, not an oversight')
    expect(content).toContain('Read, Grep, and Glob')
    expect(content).toContain('Fallback clauses may name')
    expect(content).toContain('never tool identifiers')
    expect(content).toContain(
      "Fallback clauses may name your harness's own native read, search, and edit tools, or its shell helpers. Shell binaries and editor programs are commands invoked through the shell tool, never tool identifiers, and must never appear in an agent's tools frontmatter or an allowed-tools list. This paragraph deliberately names no specific tool or binary: instruction-file loaders harvest such names into a tool allowlist and then warn that every one of them is unknown.",
    )
    expect(content).toContain('`map --compact`')
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
    expect(content).toContain('answer one question first')
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
  const CLAUDE_FALLBACK_CLAUSE = "Claude Code's own Read, Grep, and Glob preference rules"
  const sharedBody = buildGuidanceBody(CLAUDE_FALLBACK_CLAUSE)

  it('writes SKILL.md on a fresh install', () => {
    const result = installSkill()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.path).toBe(skillPath())
    expect(fs.existsSync(result.path)).toBe(true)

    const content = fs.readFileSync(result.path, 'utf8')
    expect(content).toContain('name: token-goat')
  })

  it('body carries the pre-call gate, not the old advisory phrasing', () => {
    installSkill()
    const content = fs.readFileSync(skillPath(), 'utf8')
    // The gate, phrased as an interrupt.
    expect(content).toContain('answer one question first')
    expect(content).toContain('violation, not an oversight')
    expect(content).toContain('per file')
    // Names Claude Code's own read tools in the conflict-resolution clause.
    expect(content).toContain('Read, Grep, and Glob')
    expect(content).toContain('allowed-tools:')
    // Real harness tool identifiers, NOT token-goat subcommands: loaders validate
    // every entry against their tool registry and warn on each miss.
    expect(content).toContain('  - Bash')
    expect(content).toContain('  - Read')
    expect(content).not.toContain('  - section')
    expect(content).not.toContain('  - gdrive-sections')
    expect(content).toContain('Fallback clauses may name')
    expect(content).toContain('never tool identifiers')
    // The old advisory list phrasing is gone.
    expect(content).not.toContain('Prefer token-goat commands over reading whole files')
  })

  it('renders its body from the shared guidance builder, so it stays in sync with the other three surfaces', () => {
    installSkill()
    const content = fs.readFileSync(skillPath(), 'utf8')
    // The skill body is byte-identical to the shared gate body...
    expect(content).toContain(sharedBody)
    // ...which is exactly the body the CLAUDE.md/AGENTS.md/copilot blocks wrap in markers.
    const claudeBlock = buildGuidanceBlock({
      beginMarker: '<!-- token-goat-begin -->',
      endMarker: '<!-- token-goat-end -->',
      fallbackToolClause: CLAUDE_FALLBACK_CLAUSE,
    })
    expect(claudeBlock).toContain(sharedBody)
  })

  // Regression: the gate listed only code-shaped commands, and named `config-get file KEY` while naming no JSON/YAML command at all -- so the omission read as a deliberate boundary ("config has a command, structured data does not") rather than a gap, and a manifest lookup routed to a full file read. Asserted on the shared body so all four surfaces are covered at once.
  it('names the JSON/YAML query commands in both the failure shapes and the Commands line', () => {
    const failureShapes = sharedBody.split('\n').filter((l) => l.startsWith('- '))
    expect(failureShapes.length).toBeGreaterThan(0)
    const jsonShape = failureShapes.filter((l) => l.includes('json-query'))
    expect(jsonShape.length).toBe(1)
    expect(jsonShape[0]).toContain('JSON/YAML')
    expect(jsonShape[0]).toContain('yaml-query')

    const commandsLine = sharedBody.split('\n').find((l) => l.startsWith('Commands: '))
    expect(commandsLine).toBeDefined()
    for (const cmd of ['json-query', 'yaml-query', 'xml-query', 'json-outline', 'yaml-outline', 'xml-outline']) {
      expect(commandsLine).toContain(cmd)
    }
  })

  // Regression: image-meta/image-text (added in a2a76dc7) give an honest metadata/OCR read of an image, but the exemption list still blanket-exempted images as "binary or an image" -- so an agent could cite the exemption to open an image file directly instead of routing to image-meta. Narrowed to a genuinely opaque binary and added a failure-shape row so the fallback is one-step decidable.
  it('routes images to image-meta instead of blanket-exempting them', () => {
    const exemptionsLine = sharedBody.split('\n').find((l) => l.startsWith('Exemptions '))
    expect(exemptionsLine).toBeDefined()
    expect(exemptionsLine).not.toContain('binary or an image')
    expect(exemptionsLine).toContain('opaque binary')

    const failureShapes = sharedBody.split('\n').filter((l) => l.startsWith('- '))
    const imageShape = failureShapes.filter((l) => l.includes('image-meta'))
    expect(imageShape.length).toBe(1)
    expect(imageShape[0]).toContain('image')

    const commandsLine = sharedBody.split('\n').find((l) => l.startsWith('Commands: '))
    expect(commandsLine).toBeDefined()
    expect(commandsLine).toContain('image-meta')
    expect(commandsLine).toContain('image-text')
  })

  it('keeps well-formed frontmatter that is unaffected by the gate body', () => {
    installSkill()
    const content = fs.readFileSync(skillPath(), 'utf8')
    // Opens with a closed YAML frontmatter fence before any body content.
    expect(content.startsWith('---\n')).toBe(true)
    const fenceEnd = content.indexOf('\n---\n')
    expect(fenceEnd).toBeGreaterThan(0)
    const frontmatter = content.slice(0, fenceEnd)
    expect(frontmatter).toContain('name: token-goat')
    // The description stays the deliberately-advisory relevance trigger, NOT the gate wording.
    expect(frontmatter).toContain('description:')
    expect(frontmatter).not.toContain('violation, not an oversight')
    // The gate body lives strictly after the frontmatter fence.
    expect(content.indexOf('answer one question first')).toBeGreaterThan(fenceEnd)
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
    expect(content).toContain('answer one question first')
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
