/** A script that decides it is the entry module by comparing import.meta.url with process.argv[1] must resolve argv[1] to its real path first (realpathSync) or match on the file name. Node resolves the entry module's symlinks for import.meta.url but leaves argv[1] as written, so the bare comparison is false whenever the script is started through a symlinked directory, and the CLI then exits 0 having done nothing. macOS temp directories are such symlinks (/var and /tmp point into /private), which turned the pre-push focus tests red on the macOS job only while Linux and Windows passed. This guard reads the text, so it catches the pattern on a platform with no symlinked temp directory; tests/scripts_main_through_symlink.test.ts proves the behaviour through a link. Provenance is FORMAT-DERIVED: the Node ESM documentation ("import.meta.url", "--preserve-symlinks-main") and macOS hier(7); the matcher fixtures are HAND-DERIVED from that rule. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const SCRIPTS = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'scripts')

/** Lines that compare import.meta.url with argv[1] and neither resolve the path nor fall back to the file name. */
function unresolvedEntryChecks(text: string): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /import\.meta\.url[^\n]*process\.argv\[1\]/.test(line) && !/realpathSync|\.endsWith\(/.test(line))
    .map(({ n, line }) => `line ${n}: ${line.trim()}`)
}

describe('the matcher sees the bare comparison and spares the resolved one', () => {
  const bad = [
    'const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href',
    "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
    'if (import.meta.url === `file://${process.argv[1]}`) {',
  ]
  for (const snippet of bad) {
    it(`flags ${JSON.stringify(snippet)}`, () => {
      expect(unresolvedEntryChecks(snippet)).toHaveLength(1)
    })
  }
  const good = [
    'const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href',
    'if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {',
    "if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('x.mjs')) {",
    'const here = import.meta.url',
    'const arg = process.argv[1]',
  ]
  for (const snippet of good) {
    it(`spares ${JSON.stringify(snippet)}`, () => {
      expect(unresolvedEntryChecks(snippet)).toEqual([])
    })
  }
})

describe('scripts/', () => {
  const files = pinnedPopulation({ what: 'scripts/*.mjs files', items: readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs')), floor: 10, mustInclude: ['prepush-failed.mjs', 'prepush-tree-readers.mjs', 'test-durations.mjs', 'lock-commit-subject.mjs'] })
  for (const file of files) {
    it(`${file} resolves argv[1] before comparing it with import.meta.url`, () => {
      expect(unresolvedEntryChecks(readFileSync(path.join(SCRIPTS, file), 'utf8'))).toEqual([])
    })
  }
})
