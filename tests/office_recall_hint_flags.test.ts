import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'

// Provenance: FORMAT-DERIVED. The flag names are the ones _applyFiltersAndPrint writes into its elision marker and head/tail note (src/cli_cached_output.ts); the callers are every command that passes its options to that printer (grep `_applyFiltersAndPrint` in src).
const HINTED_FLAGS = ['--head', '--tail', '--grep', '--section', '--max-matches', '--lines', '--full']
const CALLERS = ['retrieve', 'bash-output', 'web-output', 'mcp-output', 'pdf-extract', 'docx-text']

describe('recall printer hints name only flags the calling command accepts', () => {
  for (const name of CALLERS) {
    it(`${name} registers every flag the printer can advertise`, () => {
      const cmd = buildProgram().commands.find((c) => c.name() === name)
      expect(cmd, name).toBeDefined()
      const registered = cmd!.options.map((o) => o.long)
      for (const flag of HINTED_FLAGS) expect(registered, `${name} ${flag}`).toContain(flag)
    })
  }
})
