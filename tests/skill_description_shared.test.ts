/** The SKILL.md `description:` frontmatter line is the relevance trigger a harness reads to decide whether to load the token-goat skill at all. The Kimi Code writer (src/bridges/kimi_install.ts) renders it from skillDescriptionLine(); the Claude Code skill (src/install.ts) is CANONICAL_SKILL_MD verbatim, whose shorter description fits the 240-character skill-collection limit and names `/token-goat audit`. These tests fail if either writer inlines its own copy, if install.ts claims to use skillDescriptionLine() again, or if the two descriptions stop opening with the same routing pitch. */
import { describe, expect, it } from 'vitest'

import { skillDescriptionLine } from '../src/bridges/guidance_block.js'
import { CANONICAL_SKILL_MD } from '../src/canonical_skill.js'

describe('skillDescriptionLine', () => {
  it('renders the frontmatter key and the routing pitch', () => {
    const line = skillDescriptionLine(false)
    expect(line.startsWith('description: ')).toBe(true)
    expect(line).toContain('Use before reading whole files or grepping wide')
    expect(line).toContain('return narrow slices of code and docs at a fraction of the token cost.')
  })

  it('is a single line, so it cannot break the YAML frontmatter it is spliced into', () => {
    expect(skillDescriptionLine(false)).not.toContain('\n')
    expect(skillDescriptionLine(true)).not.toContain('\n')
  })

  it('names gdrive-sections only when the Google Drive integration is enabled', () => {
    expect(skillDescriptionLine(true)).toContain('gdrive-sections')
    expect(skillDescriptionLine(false)).not.toContain('gdrive-sections')
  })

  it('differs between the two gdrive states by exactly the gdrive-sections clause', () => {
    expect(skillDescriptionLine(true).replace(', gdrive-sections', '')).toBe(skillDescriptionLine(false))
  })

  it('is the line the Kimi writer splices in, while the Claude Code writer takes its own from the canonical skill', async () => {
    const [installSrc, kimiSrc] = await Promise.all([
      import('node:fs').then((fs) => fs.readFileSync(new URL('../src/install.ts', import.meta.url), 'utf8')),
      import('node:fs').then((fs) => fs.readFileSync(new URL('../src/bridges/kimi_install.ts', import.meta.url), 'utf8')),
    ])
    // Neither writer may carry a hand-written copy of the description text.
    expect(installSrc, 'src/install.ts must not inline the description line').not.toContain('description: Use before reading whole files')
    expect(kimiSrc, 'src/bridges/kimi_install.ts must not inline the description line').not.toContain('description: Use before reading whole files')
    expect(kimiSrc).toContain('skillDescriptionLine(')
    // The Claude Code skill is CANONICAL_SKILL_MD verbatim, so a mention of skillDescriptionLine() there is a stale claim, not a use.
    expect(installSrc, 'src/install.ts must not claim the Claude Code skill uses skillDescriptionLine()').not.toContain('skillDescriptionLine(')
  })

  it('opens with the same routing pitch as the canonical Claude Code skill description', () => {
    const canonical = CANONICAL_SKILL_MD.split('\n').find((line) => line.startsWith('description: '))
    expect(canonical).toBeDefined()
    const pitch = 'Use before reading whole files or grepping wide.'
    expect(skillDescriptionLine(false).startsWith(`description: ${pitch}`)).toBe(true)
    expect(canonical!.replace(/^description: "?/, '').startsWith(pitch)).toBe(true)
  })
})
