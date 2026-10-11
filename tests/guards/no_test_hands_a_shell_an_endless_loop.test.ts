// A shell loop with no exit condition, handed to a child shell by a test, outlives the test when a timeout kills only the outer shell: the shell oracle's timeout test did exactly that, and every full suite run on Windows left one subshell spinning a core until nineteen of them starved the machine. A test that needs a long-running shell bounds it by SECONDS or a deadline instead. This is a tripwire for the literal forms, not a proof of termination; the shell oracle's own cleanup test is what shows a killed run leaves nothing behind. Provenance: HAND-DERIVED, the forms are bash's never-false loop conditions (the colon builtin, true, a constant 1 test or arithmetic as a while condition, false as an until condition, a C-style for with no condition), coreutils' sleep given infinity as its duration, and PowerShell's while on the automatic variable for true.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENDLESS = [/\bwhile\s+(?::|true|\[\s*1\s*\]|\(\(\s*1\s*\)\))\s*(?:[;#]|$)/, /\buntil\s+false\s*(?:[;#]|$)/, /\bsleep\s+infinity\b/, /\bfor\s*\(\(\s*;\s*;\s*\)\)/, /\bwhile\s*\(\s*\$true\s*\)/i]

function scriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    // Another test's scratch directory under tests/ can vanish mid-walk, so dot-prefixed entries are skipped like every other tests/ walker.
    if (e.name.startsWith('.')) return []
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : scriptFiles(full)
    return e.isFile() && /\.(ts|mts|cts|js|mjs|cjs|sh|bash|ps1|psm1|bat|cmd)$/i.test(e.name) ? [full] : []
  })
}

function endlessLoopLines(text: string): number[] {
  return text.split('\n').flatMap((line, i) => (ENDLESS.some((re) => re.test(line)) ? [i + 1] : []))
}

describe('test and script sources', () => {
  it('hand no shell a loop that never ends on its own', () => {
    const files = pinnedPopulation({
      what: 'test and script sources scanned for endless shell loops',
      items: [...scriptFiles(path.join(ROOT, 'tests')), ...scriptFiles(path.join(ROOT, 'scripts'))],
      floor: 1200,
      mustInclude: ['shell_argv_helper.test.ts', 'shell_argv.ts'],
    })
    const hits = files.flatMap((file) => endlessLoopLines(fs.readFileSync(file, 'utf8')).map((n) => `${path.relative(ROOT, file)}:${n}`))
    expect(hits, 'bound the loop by SECONDS or a deadline so a killed parent cannot leave it spinning').toEqual([])
  })

  it('recognises each endless form and leaves loops with an exit condition alone', () => {
    // Each form is assembled from words, so this file does not trip its own scan.
    const w = (...words: string[]): string => words.join(' ')
    const endless = [w('while', ':;', 'do', ':;', 'done'), w('while', 'true;', 'do', 'x;', 'done'), w('while', 'true'), w('while', 'true', '# spin'), w('until', 'false;', 'do', 'x;', 'done'), w('until', 'false'), w('while', '[ 1 ];', 'do', 'x;', 'done'), w('while', '((1));', 'do', 'x;', 'done'), w('sleep', 'infinity'), w('for', '((;;));', 'do', 'x;', 'done'), w('while', '($true)', '{ x }'), w('While', '( $True )', '{ x }'), w('while', 'true;', 'do', ':;', 'done\r')]
    for (const line of endless) expect(endlessLoopLines(line), JSON.stringify(line)).toEqual([1])
    const exits = ['while [ "$SECONDS" -lt 9 ]; do :; done', 'while (true) { break }', 'until [ -f done ]; do sleep 1; done', 'sleep 5', 'for ((i=0;i<3;i++)); do :; done', 'tail -f log', 'while true positives stay rare', 'until false positives stay rare', 'while [ 10 -gt "$n" ]; do n=$((n + 1)); done', 'while ($true -and $more) { x }', 'for (;;) { break }']
    for (const line of exits) expect(endlessLoopLines(line), line).toEqual([])
  })
})
