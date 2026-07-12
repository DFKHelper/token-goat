import { describe, expect, it } from 'vitest'

import { detectLanguage } from '../src/parser_types.js'

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

  it('is case-insensitive on the extension', () => {
    expect(detectLanguage('FOO.PY')).toBe('python')
    expect(detectLanguage('Bar.TS')).toBe('typescript')
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
