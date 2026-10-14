/** Regression: `skill-body <name> --compact` printed the full body, without a word, for a skill with no usable compact slice. humanizer's marker cut 97.6% of its body, and marketing and token-goat have no marker, so they came back byte-identical; one session spent six calls loading one skill. Such a skill now gets the heading tree the Skill hook inlines in the same case, with how to load one section, and a stderr note. Runs the built bundle against isolated skill directories. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

// HAND-DERIVED: eight H2 sections of 1200 bytes clear the hook's map floors (at least six headings, a tree well under 40% of the body).
const SECTIONS = Array.from({ length: 8 }, (_, i) => `## Section ${i}\n\n${'p'.repeat(1200)}`).join('\n\n')
const NO_MARKER = `# Mapped Skill\n\n${SECTIONS}\n`
const LATE_MARKER = `# Mapped Skill\n\n${SECTIONS}\n<!-- COMPACT_END -->\ntrailing note\n`
const FLAT = `${'flat line of a skill with no headings\n'.repeat(200)}`

let scratch: string
let env: NodeJS.ProcessEnv

function install(name: string, body: string): void {
  fs.mkdirSync(path.join(scratch, '.claude', 'skills', name), { recursive: true })
  fs.writeFileSync(path.join(scratch, '.claude', 'skills', name, 'SKILL.md'), body, 'utf-8')
}

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8', env, timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-skillbody-noslice-'))
  env = {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(scratch, 'home'),
    LOCALAPPDATA: path.join(scratch, 'local'),
    XDG_DATA_HOME: path.join(scratch, 'local'),
    APPDATA: path.join(scratch, 'roaming'),
    USERPROFILE: scratch,
    HOME: scratch,
  }
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('skill-body --compact for a skill with no usable compact slice', () => {
  it.each([
    ['no marker', 'tgnomarker', NO_MARKER, 'no COMPACT_END marker'],
    ['a marker cutting more than half the body', 'tglatemarker', LATE_MARKER, 'no compact slice under half its body'],
  ])('prints the heading tree and how to load a section, not the body, for %s', (_label, name, body, why) => {
    install(name, body)
    const r = cli(['skill-body', name, '--compact'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('no compact slice')
    expect(r.stdout).toContain(why.replace('COMPACT_END', '<!-- COMPACT_END -->'))
    expect(r.stdout).toContain('## Section 0')
    expect(r.stdout).toContain('## Section 7')
    expect(r.stdout).toContain(`token-goat skill-section "${name}" "Section 0"`)
    expect(r.stdout).not.toContain('p'.repeat(1200))
    expect(r.stdout.length).toBeLessThan(Buffer.byteLength(body, 'utf-8') / 2)

    // The command it names loads that section, and the full body stays one flag away.
    const section = cli(['skill-section', name, 'Section 0'])
    expect(section.status, section.stderr).toBe(0)
    expect(section.stdout).toContain('p'.repeat(1200))
    expect(cli(['skill-body', name]).stdout).toContain('p'.repeat(1200))
  })

  it('says it printed the full body when the skill has too few headings to map', () => {
    install('tgflat', FLAT)
    const r = cli(['skill-body', 'tgflat', '--compact'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('no compact slice')
    expect(r.stderr).toContain('printed the full body')
    expect(r.stdout).toBe(FLAT)
  })
})
