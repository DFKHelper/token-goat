/**
 * The parser fingerprint is per-language, not one global digest.
 *
 * A single global digest meant a fix to one language's adapter invalidated every indexed file in every project: measured on this machine, 26 of the last 90 days' 79 fingerprint regenerations touched only one or two adapters, and the languages those 26 touched account for 161 of 17,855 indexed files -- 0.9%. Each of those releases reparsed all 17,855 to correct at most a few dozen.
 *
 * The direction of safety is asymmetric and it is what these tests are really pinning. Over-invalidating costs a reparse; under-invalidating leaves wrong symbols in the index indefinitely with nothing to signal it, which is the exact failure `files.parser_sha` was added to close. So the shared-change direction -- every language's stamp moves -- matters more than the narrowing, and is tested first.
 *
 * Fixture provenance, CAPTURE: every digest here is produced by running the real scripts/parser-fingerprint.mjs over a real copy of this repository's own extraction sources. Nothing is a restatement of the expected value. The "an adapter changed" condition is produced by actually appending a line to the adapter inside that copy, never by asserting a digest the test itself made up.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { getDb } from '../src/db.js'
import { LANGUAGE_PARSER_FINGERPRINTS, PARSER_FINGERPRINT } from '../src/parser_fingerprint.js'
import { indexFileSync } from '../src/parser.js'
import { parserFingerprintForLanguage } from '../src/parser_types.js'
import { reconcileProject } from '../src/reconcile.js'
import { normalizePath } from '../src/util.js'
import { ADAPTER_EXTRACTORS } from '../src/languages/registry.js'
import * as generator from '../scripts/parser-fingerprint.mjs'

const ROOT = path.join(__dirname, '..')

/** The generator resolves every path it reads from its own location, so a copy of it beside a copy of the sources digests the copy. That is what lets a test edit an adapter without touching the working tree -- vitest runs test files in parallel forks, and an in-place edit would be visible to every other file mid-run. */
interface SourceCopy {
  readonly dir: string
  readonly gen: typeof generator
}

async function copySources(): Promise<SourceCopy> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pfp-copy-'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.cpSync(path.join(ROOT, 'src', 'languages'), path.join(dir, 'src', 'languages'), { recursive: true })
  for (const file of generator.extractionSources()) {
    const rel = path.relative(path.join(ROOT, 'src'), file)
    if (!rel.startsWith('languages')) fs.copyFileSync(file, path.join(dir, 'src', rel))
  }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'parser-fingerprint.mjs'), path.join(dir, 'scripts', 'parser-fingerprint.mjs'))
  return { dir, gen: (await import(pathToFileURL(path.join(dir, 'scripts', 'parser-fingerprint.mjs')).href)) as typeof generator }
}

/** Every language's effective stamp in `copy`, including the languages that fall back to the shared digest, so a comparison covers the whole surface rather than the adapter-backed part of it. */
function stampsOf(copy: SourceCopy, languages: readonly string[]): Map<string, string> {
  const shared = copy.gen.computeFingerprint()
  const perLanguage = copy.gen.computeLanguageFingerprints()
  return new Map(languages.map((l) => [l, perLanguage.get(l) ?? shared]))
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('per-language parser fingerprint', () => {
  let copy: SourceCopy
  /** Every language the gates can look up: the adapter-backed ones plus a tree-sitter one, a structured-document one, and 'unknown', all of which fall back to the shared digest. */
  let languages: string[]

  beforeAll(async () => {
    copy = await copySources()
    languages = [...Object.keys(ADAPTER_EXTRACTORS), 'typescript', 'markdown', 'unknown']
  })

  afterAll(() => {
    if (copy !== undefined) fs.rmSync(copy.dir, { recursive: true, force: true })
  })

  it('moves every language stamp when a shared extraction source changes, which is the direction that must never regress', () => {
    const before = stampsOf(copy, languages)
    fs.appendFileSync(path.join(copy.dir, 'src', 'parser.ts'), '\n// probe\n')
    const after = stampsOf(copy, languages)

    const unmoved = languages.filter((l) => before.get(l) === after.get(l))
    expect(unmoved, 'src/parser.ts decides extraction for every language, so every stamp must move').toEqual([])
    expect(after.get('unknown'), "a file whose language is 'unknown' carries the shared digest and must move with it").not.toBe(before.get('unknown'))
  })

  it('leaves every other language byte-identical when one adapter changes', async () => {
    const pristine = await copySources()
    try {
      const before = stampsOf(pristine, languages)
      fs.appendFileSync(path.join(pristine.dir, 'src', 'languages', 'dart.ts'), '\n// probe\n')
      const after = stampsOf(pristine, languages)

      const moved = languages.filter((l) => before.get(l) !== after.get(l))
      expect(moved, 'only Dart is extracted by src/languages/dart.ts').toEqual(['dart'])
      expect(pristine.gen.computeFingerprint(), 'an adapter edit must not move the shared digest, or nothing has been narrowed').toBe(PARSER_FINGERPRINT)
    } finally {
      fs.rmSync(pristine.dir, { recursive: true, force: true })
    }
  })

  it('classifies a module more than one extractor reaches, or a decision source imports, as shared', () => {
    const owned = new Set([...generator.languageExtractionSources().values()].flat().map((f) => path.relative(ROOT, f).split(path.sep).join('/')))
    // sniff.ts is the load-bearing one: parser_types.ts's refineLanguageByContent calls it to decide whether a .cls is Apex, VB6 or ABL, so an edit there can change which adapter parses a file already stamped for another language. common.ts and shader.ts are the plain multi-consumer cases, registry.ts the dispatch table itself.
    for (const shared of ['src/languages/sniff.ts', 'src/languages/common.ts', 'src/languages/shader.ts', 'src/languages/registry.ts']) {
      expect(owned.has(shared), `${shared} must be shared, not owned by one language`).toBe(false)
    }
    expect(generator.languageExtractionSources().get('dart'), 'the calibration: an adapter no other extractor reaches IS attributed, so the assertions above are not passing on an empty classification').toEqual([path.join(ROOT, 'src', 'languages', 'dart.ts')])
  })

  it('attributes every language the compiled dispatch table actually holds', () => {
    // The oracle is the compiled object, not the generator's own text scan of it. A brace-split that dropped an entry would silently leave that adapter attributed to nobody, which the generated file cannot show.
    const parsed = new Set(generator.adapterDispatchEntries().map(([language]) => language))
    const missing = Object.keys(ADAPTER_EXTRACTORS).filter((l) => !parsed.has(l))
    expect(missing, 'every ADAPTER_EXTRACTORS key must be found by the generator that attributes adapters to languages').toEqual([])
    expect(parsed.size).toBe(Object.keys(ADAPTER_EXTRACTORS).length)
  })

  it('has checked-in constants that recompute from the extraction sources', () => {
    // Without this the constants ship green however they were edited: a hand-edit, a bad merge, or a forgotten regeneration. The width and non-emptiness anchors matter because a function that throws into a catch, or returns '', compares equal to a corrupted constant just as well as to a correct one.
    expect(PARSER_FINGERPRINT).toMatch(/^[0-9a-f]{16}$/)
    expect(generator.computeFingerprint()).toBe(PARSER_FINGERPRINT)

    const computed = generator.computeLanguageFingerprints()
    expect(computed.size, 'an empty map would compare equal to a generated file that lost its map entirely').toBeGreaterThan(40)
    for (const [language, digest] of computed) {
      expect(digest, `${language} must be a full-width digest`).toMatch(/^[0-9a-f]{16}$/)
      expect(LANGUAGE_PARSER_FINGERPRINTS.get(language), `LANGUAGE_PARSER_FINGERPRINTS.${language} is stale -- run \`npm run parser:fingerprint\``).toBe(digest)
    }
    expect([...LANGUAGE_PARSER_FINGERPRINTS.keys()].sort()).toEqual([...computed.keys()].sort())
  })

  it('stamps a real index per language, and reparses only the language whose adapter moved', async () => {
    const dir = tmpDir('tg-pfp-e2e-')
    const dbPath = path.join(dir, 'idx.db')
    const files = {
      dart: normalizePath(path.join(dir, 'widget.dart')),
      typescript: normalizePath(path.join(dir, 'widget.ts')),
      php: normalizePath(path.join(dir, 'widget.php')),
    }
    fs.writeFileSync(files.dart, 'class Widget {\n  int size() => 1;\n}\n')
    fs.writeFileSync(files.typescript, 'export function widget(): number {\n  return 1\n}\n')
    fs.writeFileSync(files.php, '<?php\nfunction widget() { return 1; }\n')
    // reconcileProject sweeps the files git reports as tracked and reports no drift at all for a directory git cannot enumerate, so the scratch project has to be a real repository or the assertion below passes on an empty population.
    for (const args of [['init'], ['add', '-A']]) {
      const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      expect(run.status, `git ${args.join(' ')} failed: ${run.stderr}`).toBe(0)
    }
    for (const file of Object.values(files)) indexFileSync(file, dbPath)

    const stamped = new Map(
      (getDb(dbPath).prepare('SELECT path, language, parser_sha FROM files').all() as { path: string; language: string; parser_sha: string }[]).map((r) => [
        r.language,
        r.parser_sha,
      ]),
    )
    expect([...stamped.keys()].sort(), 'the fixture must index all three languages, or the distinctness below proves nothing').toEqual(['dart', 'php', 'typescript'])
    expect(new Set(stamped.values()).size, 'three languages, three distinct stamps -- one global digest gave all three the same string').toBe(3)
    expect(stamped.get('typescript'), 'a language with no adapter of its own carries the shared digest').toBe(PARSER_FINGERPRINT)
    expect(stamped.get('dart')).toBe(parserFingerprintForLanguage('dart'))

    // Now the upgrade, from the other side: restamp every row as a build whose Dart adapter differed would have written it. This build is then the new one, and only Dart's digest moved between the two, so only widget.dart may come back stale. Under one global digest the appended line moved that single value, so all three rows would be restamped to something this build disagrees with and all three would be enqueued.
    const moved = await copySources()
    try {
      fs.appendFileSync(path.join(moved.dir, 'src', 'languages', 'dart.ts'), '\n// probe\n')
      const other = stampsOf(moved, Object.keys(files))
      const db = getDb(dbPath)
      for (const [language, file] of Object.entries(files)) {
        const run = db.prepare('UPDATE files SET parser_sha = ? WHERE path = ?').run(other.get(language), file)
        expect(run.changes, `restamping ${file} must hit its row, or the sweep below is reading stamps nothing moved`).toBe(1)
      }
      const result = reconcileProject({ cwd: dir, dbPath })
      expect(result.changed.map(normalizePath).sort(), 'only the Dart file may be enqueued for reparse').toEqual([files.dart])
      expect(result.parserStale, 'and it must be enqueued for the parser-stamp reason, not by a content diff').toBe(1)
    } finally {
      fs.rmSync(moved.dir, { recursive: true, force: true })
    }
  })
})
