import { describe, expect, it } from 'vitest'

import { buildProgram } from '../../src/cli.js'
import { generateCompactHelp } from '../../src/cli_help.js'

/**
 * The compact help is a hand-written list of command names, and it is the CLI's main discovery surface. Nothing compared it to the commands that actually exist.
 *
 * It had drifted in both directions at once. Four names it advertised were not registered at all -- `snapshot-snapshot`, `opencode-*`, `start` and `stop` -- so the one surface that tells a caller which commands exist was naming four that do not, and running one answers `unknown command`. Two names were printed twice in one group, and three commands that do exist -- `audit`, `history` and `locate` -- appeared nowhere, so the only way to find one was to already know it was there.
 *
 * Both sides here come from the producers themselves, `generateCompactHelp()` and `buildProgram()`. Transcribing either list into this file would make the test agree with whichever copy it was written from, which is the shape that let the drift sit unnoticed in the first place.
 */

/** Command names the compact help advertises, in order, including any repeats. */
function advertisedNames(): string[] {
  const text = generateCompactHelp()
  const names: string[] = []
  let inGroup = false
  for (const line of text.split('\n')) {
    // A group starts at a `Label:` in column 0. `Usage:`, `Options:` and `Tip:` are prose, not lists of command names.
    const header = /^([A-Z][\w &]+):\s*(.*)$/.exec(line)
    if (header !== null) {
      const label = header[1]!
      inGroup = label !== 'Usage' && label !== 'Options' && label !== 'Tip'
      if (inGroup) names.push(...splitNames(header[2]!))
      continue
    }
    // Continuation lines of the group above are indented; a blank line ends it.
    if (inGroup && line.startsWith('  ')) names.push(...splitNames(line))
    else if (line.trim() === '') inGroup = false
  }
  return names
}

function splitNames(segment: string): string[] {
  return segment
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** Every command the program actually registers, top level only -- the compact help lists no nested subcommand. */
function registeredNames(): Set<string> {
  return new Set(buildProgram().commands.map((c) => c.name()))
}

describe('compact help matches the command registry', () => {
  it('advertises nothing that is not a registered command', () => {
    const advertised = advertisedNames()
    // Non-vacuous: a parser that stopped finding group lines would yield an empty list and pass against any amount of drift.
    expect(advertised.length, 'no command names parsed out of the compact help -- the group format has changed').toBeGreaterThan(100)

    const registered = registeredNames()
    const phantom = advertised.filter((n) => !registered.has(n))
    expect(
      [...new Set(phantom)],
      'the compact help names commands that do not exist; the list a caller consults to find out what exists is the thing telling them wrong',
    ).toEqual([])
  })

  it('names each command once', () => {
    const advertised = advertisedNames()
    const seen = new Set<string>()
    const repeated = advertised.filter((n) => (seen.has(n) ? true : (seen.add(n), false)))
    expect([...new Set(repeated)], 'the compact help prints these names more than once').toEqual([])
  })

  it('advertises every registered command', () => {
    const advertised = new Set(advertisedNames())
    const missing = [...registeredNames()].filter((n) => !advertised.has(n)).sort()
    expect(
      missing,
      'these commands are registered but appear nowhere in the compact help, so the only way to find one is to already know it exists',
    ).toEqual([])
  })
})
