import { describe, expect, it } from 'vitest'

import { allCommandNames } from '../registry.js'
import {
  NOT_READ_ONLY_COMMANDS,
  READ_ONLY_COMMANDS,
  unclassifiedCommands,
} from '../../src/cli_diagnostics.js'

describe('every registered command has a read-only decision for permissions suggest', () => {
  const registered = allCommandNames()

  it('classifies every registered command, so a new command cannot slip into the allow list unreviewed', () => {
    expect(
      unclassifiedCommands(registered),
      'each name below is registered but in neither table of src/permission_suggest.ts; classify it there',
    ).toEqual([])
  })

  it('names no read-only entry the CLI does not register, so no stale allow rule survives a rename', () => {
    const known = new Set(registered)
    const stale = READ_ONLY_COMMANDS.filter((name) => !known.has(name))
    expect(stale, 'read-only entries with no registered command').toEqual([])
  })

  it('names no not-read-only entry that the CLI does not register', () => {
    const known = new Set(registered)
    const stale = NOT_READ_ONLY_COMMANDS.filter((name) => !known.has(name))
    expect(stale, 'not-read-only entries with no registered command').toEqual([])
  })
})
