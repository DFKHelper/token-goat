/**
 * Guard against the "a whole-file read puts V8's string cap between a tool and the sessions it
 * exists for" class.
 *
 * A session transcript and a Copilot event log are both JSONL: read a line, parse it, discard it.
 * Both parsers nevertheless began by materializing the entire file as one string and splitting it,
 * which imposes a ceiling that has nothing to do with how much memory the machine has -- V8 refuses
 * any string past about 512 MB, and `readFileSync` throws there rather than returning a short read.
 * `token-goat waste` against this repo's own 570 MB session transcript died on it outright with
 * `Cannot create a string longer than 0x1fffffe8 characters`, and the sessions large enough to hit
 * that are exactly the ones an audit is most worth running against.
 *
 * No test can afford the fixture that reproduces it: the failing input is a half-gigabyte file, so
 * every fixture in the suite is orders of magnitude below the threshold and the defect is invisible
 * to all of them. That is what makes this a guard rather than a unit test -- the check is on the
 * shape of the read, which is cheap, rather than on the size that breaks it, which is not.
 * `readFileLines` in src/waste.ts is the streaming reader both parsers now use; the line-splitting
 * and multi-byte-boundary behaviour it has to get right is covered in tests/waste.test.ts.
 *
 * The population is derived from the source rather than listed by hand, so a third transcript
 * parser added later is covered by existing in this set rather than by someone remembering to add
 * it here.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', '..', 'src')

/** Source files that parse a JSONL transcript or event log line by line. */
function transcriptParsers(): string[] {
  return fs
    .readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => {
      const text = fs.readFileSync(path.join(SRC, name), 'utf8')
      return text.includes('readFileLines(')
    })
    .sort()
}

describe('a transcript is never read as one string', () => {
  it('reads every JSONL transcript and event log through the streaming reader', () => {
    const parsers = transcriptParsers()
    pinnedPopulation({
      what: 'src files that parse a JSONL transcript or event log',
      items: parsers,
      floor: 2,
      mustInclude: ['waste.ts', 'copilot_waste.ts'],
    })

    for (const name of parsers) {
      const text = fs.readFileSync(path.join(SRC, name), 'utf8')
      // Keyed on the path each file actually streams rather than on `readFileSync` appearing at
      // all: these same files legitimately read bounded sidecars whole (copilot_waste.ts reads a
      // workspace.yaml that way), so a blanket ban would fail on a correct file. What must never
      // happen is the unbounded path being handed to a whole-file read, whichever call does it.
      const streamed = [...text.matchAll(/readFileLines\((\w+)\)/g)].map((m) => m[1])
      expect(streamed.length, `${name} matched on readFileLines but no argument name could be read off it`).toBeGreaterThan(0)
      for (const arg of streamed) {
        expect(text, `${name} also hands ${arg} to a whole-file read, which throws above V8's string cap`).not.toContain(`readFileSync(${arg}`)
      }
    }
  })
})
