/**
 * The SKILL.md `description:` frontmatter line is the relevance trigger a harness reads to decide
 * whether to load the token-goat skill at all. It shipped as a byte-identical copy in the Claude
 * Code skill writer (src/install.ts) and the Kimi Code one (src/bridges/kimi_install.ts), so the
 * two could drift and quietly give one harness worse skill-loading recall than the other. Both now
 * render it from skillDescriptionLine(); these tests fail if either re-inlines its own copy.
 */
import { describe, expect, it } from 'vitest'

import { skillDescriptionLine } from '../src/bridges/guidance_block.js'

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

  it('is the exact line both skill writers splice in', async () => {
    const [installSrc, kimiSrc] = await Promise.all([
      import('node:fs').then((fs) => fs.readFileSync(new URL('../src/install.ts', import.meta.url), 'utf8')),
      import('node:fs').then((fs) => fs.readFileSync(new URL('../src/bridges/kimi_install.ts', import.meta.url), 'utf8')),
    ])
    // Neither writer may carry a hand-written copy of the description text.
    expect(installSrc, 'src/install.ts must not inline the description line').not.toContain('description: Use before reading whole files')
    expect(kimiSrc, 'src/bridges/kimi_install.ts must not inline the description line').not.toContain('description: Use before reading whole files')
    expect(installSrc).toContain('skillDescriptionLine(')
    expect(kimiSrc).toContain('skillDescriptionLine(')
  })
})
