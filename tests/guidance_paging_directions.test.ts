import { describe, expect, it } from 'vitest'

import { buildGuidanceBody } from '../src/bridges/guidance_block.js'
import { CANONICAL_SKILL_MD } from '../src/canonical_skill.js'

describe('paging recovery guidance', () => {
  it('names the surgical command for each paging recovery case once', () => {
    const body = buildGuidanceBody("Claude Code's own Read, Grep, and Glob preference rules")
    const paging = body.split('\n').find((line) => line.includes('range denial'))

    expect(paging).toBeDefined()
    expect(paging).toContain('run its exact command')
    expect(paging).toContain('`read "file::symbol"`')
    expect(paging).toContain('`read "file@start-end"`')
    expect(paging).toContain('`skeleton file`')
    expect(paging).toContain('`grep "<pattern>" file -C 15 --symbol`')
    expect(paging).not.toContain('delegate')
  })

  it('keeps canonical skill paging advice concise and command-first', () => {
    expect(CANONICAL_SKILL_MD).toContain('Run the exact token-goat command named by the denial first.')
    expect(CANONICAL_SKILL_MD).toContain('token-goat read "file@start-end"')
    expect(CANONICAL_SKILL_MD).toContain('token-goat grep "<pattern>" <file> -C 15 --symbol')
    expect(CANONICAL_SKILL_MD).not.toContain('Falling into the paging trap')
    expect(CANONICAL_SKILL_MD).not.toContain('Do not retry a denied window')
  })
})
