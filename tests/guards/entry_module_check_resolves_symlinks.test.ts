/** A script that decides it is the entry module by reading process.argv[1] beside import.meta.url or __filename must go through isMainModule in scripts/is-main-module.mjs, which resolves both sides to real paths and cannot throw. Node resolves the entry module's symlinks for import.meta.url but leaves argv[1] as written, so a bare comparison (or one through path.resolve, which does not follow links) is false whenever the script is started through a symlinked directory, and the CLI then exits 0 having done nothing: macOS temp directories are such symlinks (/var and /tmp point into /private), which turned the pre-push focus tests red on the macOS job only. A realpathSync with no fallback is the other failure, a crash at import when argv[1] does not exist. This guard reads the whole file with comments stripped, so a multi-line comparison, fileURLToPath(import.meta.url), __filename and a .ts script are all seen, and it catches the pattern on a platform with no symlinked temp directory; tests/scripts_main_through_symlink.test.ts proves the behaviour through a link. verify-native-dist.mjs is the one exception: it ships in the npm package and is copied alone by its tests, so it keeps a private copy of the same resolve-both-sides check, which this guard also pins. Provenance is FORMAT-DERIVED: the Node ESM documentation ("import.meta.url", "--preserve-symlinks-main") and macOS hier(7); the matcher fixtures are HAND-DERIVED from that rule. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const SCRIPTS = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'scripts')

/** Scripts that keep their own resolve-both-sides check instead of the shared helper, with why. */
const STANDALONE: Readonly<Record<string, string>> = {
  'verify-native-dist.mjs': 'ships in the npm package (package.json files) and is copied alone by its tests, so it cannot import a sibling helper',
}

/** The file's code with every comment removed and its layout normalised, so a comparison split over lines reads as one. */
function code(text: string, file: string): string {
  return transformSync(text, { loader: file.endsWith('.ts') ? 'ts' : 'js', format: 'esm', legalComments: 'none' }).code
}

/** True when the code reads the entry path next to the module's own location. */
function readsEntryNextToModulePath(src: string): boolean {
  return /process\.argv\[1\]/.test(src) && /import\.meta\.(url|filename|dirname)|\b__filename\b/.test(src)
}

/** What is wrong with a script's entry check, or an empty list. */
function entryCheckProblems(text: string, file: string): string[] {
  const src = code(text, file)
  if (!readsEntryNextToModulePath(src)) return []
  if (file in STANDALONE) return /realOrResolved\(process\.argv\[1\]\) === realOrResolved\(fileURLToPath\(import\.meta\.url\)\)/.test(src) ? [] : [`${file} no longer compares both sides through its own realOrResolved`]
  return /\bisMainModule\(/.test(src) ? [] : [`${file} compares process.argv[1] with its own path without isMainModule`]
}

describe('the matcher sees every spelling of the bare check and spares the helper', () => {
  const bad = [
    'const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href',
    'if (process.argv[1] === fileURLToPath(import.meta.url)) main()',
    'if (process.argv[1] === __filename) main()',
    'if (path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main()',
    'const here = pathToFileURL(resolve(process.argv[1])).href\nif (import.meta.url === here) main()',
    'if (\n  process.argv[1] !== undefined &&\n  import.meta.url === pathToFileURL(process.argv[1]).href\n) {\n  main()\n}',
    'if (import.meta.url === `file://${process.argv[1]}`) main()',
    'if (pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main()',
  ]
  for (const snippet of bad) {
    it(`flags ${JSON.stringify(snippet)}`, () => {
      expect(entryCheckProblems(snippet, 'x.mjs')).toHaveLength(1)
    })
  }
  it('flags a typescript script too', () => {
    expect(entryCheckProblems('const a: string = process.argv[1] ?? ""\nif (a === fileURLToPath(import.meta.url)) main()', 'x.ts')).toHaveLength(1)
  })
  const good = [
    "import { isMainModule } from './is-main-module.mjs'\nif (isMainModule(import.meta.url)) main()",
    'if (isMainModule(import.meta.url)) {\n  main()\n}',
    '// process.argv[1] === __filename is the bare check\nconst x = 1',
    '/* import.meta.url vs process.argv[1] */\nconst x = 1',
    'const here = import.meta.url',
    'const arg = process.argv[1]',
  ]
  for (const snippet of good) {
    it(`spares ${JSON.stringify(snippet)}`, () => {
      expect(entryCheckProblems(snippet, 'x.mjs')).toEqual([])
    })
  }
})

describe('scripts/', () => {
  const files = pinnedPopulation({ what: 'scripts/ .mjs, .js, .cjs and .ts files', items: readdirSync(SCRIPTS).filter((f) => /\.(mjs|js|cjs|ts)$/.test(f) && !f.endsWith('.d.mts')), floor: 25, mustInclude: ['prepush-failed.mjs', 'lock-commit-subject.mjs', 'eval-gate.ts', 'eval-hints.ts', 'verify-native-dist.mjs', 'is-main-module.mjs'] })
  for (const file of files.filter((f) => f !== 'is-main-module.mjs')) {
    it(`${file} resolves its entry path through isMainModule`, () => {
      expect(entryCheckProblems(readFileSync(path.join(SCRIPTS, file), 'utf8'), file)).toEqual([])
    })
  }
  for (const file of Object.keys(STANDALONE)) {
    it(`${file} is still the standalone exception that STANDALONE records`, () => {
      expect(files).toContain(file)
      expect(readsEntryNextToModulePath(code(readFileSync(path.join(SCRIPTS, file), 'utf8'), file))).toBe(true)
    })
  }
})
