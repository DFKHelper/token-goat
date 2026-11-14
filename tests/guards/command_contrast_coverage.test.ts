/** Guard for the neighbor-contrast table in src/command_contrast.ts. Agents pick the wrong neighbor (symbol vs read, search vs semantic, outline vs skeleton), so each of those commands needs a row naming the neighbor to use instead; the rows render into the skill, the compact help and the read hints, and these checks keep the table and the renders in sync. Provenance: the required command list is HAND-DERIVED from the help text of each command; the negative-control rows are HAND-DERIVED synthetic input, not captured output. */
import { describe, expect, it } from 'vitest'

import { CANONICAL_SKILL_MD } from '../../src/canonical_skill.js'
import { COMMAND_CONTRAST_ROWS, type ContrastRow, generateCompactHelp, renderContrastLine } from '../../src/cli_help.js'
import { allCommandNames } from '../registry.js'

const REQUIRED_COMMANDS: readonly string[] = ['symbol', 'read', 'search', 'semantic', 'outline', 'skeleton']
const SKILL_BEGIN = '<!-- COMMAND_CONTRAST:BEGIN -->'
const SKILL_END = '<!-- COMMAND_CONTRAST:END -->'

function registeredBaseNames(): Set<string> {
  return new Set(allCommandNames().map((name) => name.split(' ')[0] ?? name))
}

/** Problems with a row set: a required command with no row, a row whose command or neighbor is unregistered, or a neighbor that is the command itself. */
function contrastProblems(rows: readonly ContrastRow[], required: readonly string[], registered: ReadonlySet<string>): string[] {
  const problems: string[] = []
  const commands = new Set(rows.map((row) => row.command))
  for (const name of required) if (!commands.has(name)) problems.push(`no row for ${name}`)
  for (const row of rows) {
    if (!registered.has(row.command)) problems.push(`row command ${row.command} is not a registered command`)
    if (!registered.has(row.neighbor)) problems.push(`${row.command}: neighbor ${row.neighbor} is not a registered command`)
    if (row.neighbor === row.command) problems.push(`${row.command}: neighbor is the command itself`)
  }
  return problems
}

/** Rendered row lines that do not appear verbatim in a surface's text. */
function missingRenders(text: string, rows: readonly ContrastRow[], prefix: string): string[] {
  return rows.map((row) => renderContrastLine(row)).filter((line) => !text.includes(`${prefix}${line}`))
}

/** The skill block between the markers, one list item per row. */
function skillBlock(text: string): string | null {
  const start = text.indexOf(SKILL_BEGIN)
  const end = text.indexOf(SKILL_END)
  if (start < 0 || end < start) return null
  return text.slice(start + SKILL_BEGIN.length, end).trim()
}

describe('command contrast table', () => {
  it('has a row for every neighbor-prone command, naming a registered neighbor that is not the command', () => {
    expect(contrastProblems(COMMAND_CONTRAST_ROWS, REQUIRED_COMMANDS, registeredBaseNames())).toEqual([])
  })

  it('renders every row into the skill between its markers, byte for byte', () => {
    const block = skillBlock(CANONICAL_SKILL_MD)
    expect(block, 'src/canonical_skill.md has no COMMAND_CONTRAST markers, or the END marker precedes BEGIN').not.toBeNull()
    const expected = COMMAND_CONTRAST_ROWS.map((row) => `- ${renderContrastLine(row)}`).join('\n')
    expect(block).toBe(expected)
  })

  it('renders every row into the compact help', () => {
    expect(missingRenders(generateCompactHelp(), COMMAND_CONTRAST_ROWS, '  ')).toEqual([])
  })

  // Negative controls: each class the lint must flag, built from HAND-DERIVED synthetic rows, so a lint that flags nothing cannot pass.
  it('flags a missing row, an unregistered neighbor, a self neighbor and a missing render', () => {
    const registered = registeredBaseNames()
    const withoutSkeleton = COMMAND_CONTRAST_ROWS.filter((row) => row.command !== 'skeleton')
    expect(contrastProblems(withoutSkeleton, REQUIRED_COMMANDS, registered)).toEqual(['no row for skeleton'])

    const unknownNeighbor: ContrastRow = { command: 'symbol', useFor: 'a', notFor: 'b', neighbor: 'no-such-command' }
    expect(contrastProblems([unknownNeighbor], [], registered)).toEqual(['symbol: neighbor no-such-command is not a registered command'])

    const selfNeighbor: ContrastRow = { command: 'read', useFor: 'a', notFor: 'b', neighbor: 'read' }
    expect(contrastProblems([selfNeighbor], [], registered)).toEqual(['read: neighbor is the command itself'])

    expect(missingRenders('', COMMAND_CONTRAST_ROWS, '  ')).toHaveLength(COMMAND_CONTRAST_ROWS.length)
  })
})
