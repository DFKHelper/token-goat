import { describe, expect, it } from 'vitest'

import { detectLanguage, unsupportedLanguageName } from '../src/parser_types.js'

describe('detectLanguage', () => {
  it('returns typescript for .ts files', () => {
    expect(detectLanguage('src/foo.ts')).toBe('typescript')
    expect(detectLanguage('C:/proj/app.tsx')).toBe('typescript')
  })

  it('returns python for .py files', () => {
    expect(detectLanguage('module.py')).toBe('python')
    expect(detectLanguage('/abs/path/stub.pyi')).toBe('python')
  })

  it('returns javascript for .js / .mjs / .cjs', () => {
    expect(detectLanguage('a.js')).toBe('javascript')
    expect(detectLanguage('b.mjs')).toBe('javascript')
    expect(detectLanguage('c.cjs')).toBe('javascript')
  })

  it('returns unknown for an unrecognised extension', () => {
    expect(detectLanguage('data.xyz')).toBe('unknown')
    expect(detectLanguage('noextension')).toBe('unknown')
  })

  it('returns markdown for .md / .markdown / .mdx, but unknown for .rst', () => {
    // Regression: .mdx had no EXTENSION_LANGUAGE entry, so detectLanguage returned 'unknown' for
    // it and the indexer (cmdIndex) skipped .mdx files entirely -- no headings ever got into the
    // symbol index. MDX heading syntax is plain ATX and works with the existing markdown
    // extractor, unlike .rst, which genuinely needs an underline-style heading parser that isn't
    // implemented, so 'unknown' remains correct there.
    expect(detectLanguage('README.md')).toBe('markdown')
    expect(detectLanguage('README.markdown')).toBe('markdown')
    expect(detectLanguage('docs/Guide.mdx')).toBe('markdown')
    expect(detectLanguage('docs/notes.rst')).toBe('unknown')
  })

  it('classifies named files (Dockerfile, pyproject.toml) by basename', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile')
    expect(detectLanguage('repo/pyproject.toml')).toBe('toml')
    expect(detectLanguage('package.json')).toBe('json')
  })

  it('classifies .mk Makefile fragments as makefile', () => {
    // Regression: `.mk` had no EXTENSION_LANGUAGE entry, so an included Makefile fragment
    // (config.mk, rules.mk, common.mk) resolved to 'unknown' and was indexed with zero symbols,
    // even though a bare `Makefile` (basename) and extractMakefile both handled the same content.
    expect(detectLanguage('config.mk')).toBe('makefile')
    expect(detectLanguage('build/rules.mk')).toBe('makefile')
    expect(detectLanguage('COMMON.MK')).toBe('makefile')
  })

  it('is case-insensitive on the extension', () => {
    expect(detectLanguage('FOO.PY')).toBe('python')
    expect(detectLanguage('Bar.TS')).toBe('typescript')
  })

  it('classifies any ".env.<suffix>" variant as env_file, not just an enumerated list', () => {
    // FILENAME_LANGUAGE used to enumerate a fixed list of dotenv variants (.env.local,
    // .env.example, .env.sample, .env.test, .env.production) -- any suffix a project actually
    // uses that wasn't on that list (.env.development, .env.staging, .env.ci, .env.docker, ...)
    // silently fell through to 'unknown'.
    expect(detectLanguage('.env')).toBe('env_file')
    expect(detectLanguage('.env.local')).toBe('env_file')
    expect(detectLanguage('.env.development')).toBe('env_file')
    expect(detectLanguage('.env.staging')).toBe('env_file')
    expect(detectLanguage('.env.ci')).toBe('env_file')
    expect(detectLanguage('backend/.env.docker')).toBe('env_file')
    // .envrc (direnv) has no dot after "env" and must stay distinct from the .env.<suffix> family.
    expect(detectLanguage('.envrc')).toBe('env_file')
  })

  it('classifies Salesforce Apex and source-format metadata', () => {
    expect(detectLanguage('force-app/main/default/classes/ExampleController.cls')).toBe('apex')
    expect(detectLanguage('force-app/main/default/triggers/ExampleTrigger.trigger')).toBe('apex')
    expect(detectLanguage('force-app/main/default/classes/ExampleController.cls-meta.xml')).toBe(
      'salesforce_metadata',
    )
    expect(detectLanguage('force-app/main/default/objects/Example__c/Example__c.object-meta.xml')).toBe(
      'salesforce_metadata',
    )
    expect(detectLanguage('force-app/main/default/flows/Example_Flow.flow-meta.xml')).toBe(
      'salesforce_metadata',
    )
    expect(detectLanguage('force-app\\main\\default\\permissionsetgroups\\Sales.PERMISSIONS ETGROUP-META.XML')).toBe(
      'salesforce_metadata',
    )
    expect(detectLanguage('force-app/main/default/unknown/Future.futureType-meta.xml')).toBe(
      'salesforce_metadata',
    )
  })

  it('classifies Aura and Visualforce markup', () => {
    for (const extension of [
      'cmp',
      'app',
      'evt',
      'intf',
      'design',
      'auradoc',
      'tokens',
      'page',
      'component',
      'email',
    ]) {
      expect(detectLanguage(`force-app\\main\\default\\ui\\Example.${extension.toUpperCase()}`)).toBe(
        'salesforce_markup',
      )
    }
  })
})

// unsupportedLanguageName had zero direct coverage: only 2 of its (then 9) mapped extensions
// (.swift, .dart) were exercised indirectly through read_commands.test.ts's skeleton/outline
// diagnostics, and that exercised the whole read_commands pipeline, not this function's own
// boundary (case-insensitivity, the remaining extensions, and the two `undefined` branches).
// .swift was removed from the map once src/languages/swift.ts shipped a real extractor -- see
// the 'returns undefined for a language token-goat already has an extractor for' case below.
describe('unsupportedLanguageName', () => {
  it('returns undefined for all recognized languages that now have extractors', () => {
    // Scala, Lua, Elixir, Dart, Zig, and R all now have symbol extractors
    // (previously were in UNSUPPORTED_LANGUAGE_EXTENSIONS, now removed).
    expect(unsupportedLanguageName('App.scala')).toBeUndefined()
    expect(unsupportedLanguageName('Script.sc')).toBeUndefined()
    expect(unsupportedLanguageName('init.lua')).toBeUndefined()
    expect(unsupportedLanguageName('lib/module.ex')).toBeUndefined()
    expect(unsupportedLanguageName('test/module_test.exs')).toBeUndefined()
    expect(unsupportedLanguageName('lib/main.dart')).toBeUndefined()
    expect(unsupportedLanguageName('src/main.zig')).toBeUndefined()
    expect(unsupportedLanguageName('analysis.r')).toBeUndefined()
  })

  it('is case-insensitive on the extension', () => {
    // Case-insensitive check for .R extension (now supported)
    expect(unsupportedLanguageName('Analysis.R')).toBeUndefined()
  })

  it('returns undefined for a language token-goat already has an extractor for', () => {
    expect(unsupportedLanguageName('src/app.ts')).toBeUndefined()
    expect(unsupportedLanguageName('module.py')).toBeUndefined()
    expect(unsupportedLanguageName('Main.swift')).toBeUndefined()
  })

  it('returns undefined for a genuinely unrecognized extension', () => {
    expect(unsupportedLanguageName('data.xyz')).toBeUndefined()
    expect(unsupportedLanguageName('noextension')).toBeUndefined()
  })
})
