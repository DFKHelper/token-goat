/**
 * `src/ts_refs.ts` (the type-resolved reference tier) and `src/dep_docs.ts` (the `.d.ts` outline)
 * are the only two places that reach for the TypeScript compiler API, and they reach for it off
 * the package's default export. That export is not a fixed surface: on TypeScript 7.0.2 --- the
 * native port --- `import ts from 'typescript'` yields exactly two symbols, `version` and
 * `versionMajorMinor`. Everything else moved behind `typescript/unstable/*`, a path upstream
 * labels unstable.
 *
 * Why didn't a test catch this: nothing asserted the API surface, so a compiler bump that removed
 * it did not fail on the missing symbol. It failed seventeen tests across four files instead ---
 * `ts_refs`, `read_commands`, `dep_docs`, and a bundle-matrix case --- each reporting a downstream
 * symptom (a reference not resolved, an outline row missing) with nothing naming the cause. This
 * asserts the cause directly, so the next such bump fails once, here, saying which symbol went.
 *
 * Extending either module with a new `ts.` call means adding it to the matching list below. That
 * is the point: the list is the contract with the compiler package, written down.
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Every `ts.*` member `src/ts_refs.ts` calls or reads. */
const TS_REFS_API = [
  'createProgram', 'createCompilerHost', 'findConfigFile', 'readConfigFile',
  'parseJsonConfigFileContent', 'forEachChild', 'isIdentifier', 'isClassDeclaration',
  'isEnumDeclaration', 'isFunctionDeclaration', 'isGetAccessorDeclaration',
  'isInterfaceDeclaration', 'isMethodDeclaration', 'isMethodSignature',
  'isPropertyDeclaration', 'isPropertySignature', 'isSetAccessorDeclaration',
  'isTypeAliasDeclaration', 'isVariableDeclaration',
] as const

/** Every `ts.*` member `src/dep_docs.ts` calls or reads. */
const DEP_DOCS_API = [
  'createSourceFile', 'canHaveModifiers', 'getModifiers', 'isExportAssignment',
  'isModuleDeclaration', 'isVariableStatement',
] as const

/** Enum/namespace members both modules read values off, rather than call. */
const TS_ENUMS = ['SymbolFlags', 'ScriptTarget', 'ScriptKind', 'SyntaxKind', 'ModuleKind', 'ModuleResolutionKind', 'JSDocParsingMode'] as const

describe('typescript compiler API availability', () => {
  it('exposes every function src/ts_refs.ts and src/dep_docs.ts call off the default export', () => {
    const missing = [...TS_REFS_API, ...DEP_DOCS_API].filter(
      (name) => typeof (ts as unknown as Record<string, unknown>)[name] !== 'function',
    )
    expect(
      missing,
      `typescript ${ts.version} no longer exports these as functions. On the 7.x native port the ` +
        'compiler API moved behind typescript/unstable/*; pin typescript to 6.x or port both modules.',
    ).toEqual([])
  })

  it('exposes every enum those modules read a member from', () => {
    const missing = TS_ENUMS.filter(
      (name) => typeof (ts as unknown as Record<string, unknown>)[name] !== 'object',
    )
    expect(missing, `typescript ${ts.version} no longer exports these enums`).toEqual([])
  })

  it('reads a real version, so an empty or stubbed module cannot pass the checks above', () => {
    expect(ts.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(Object.keys(ts).length).toBeGreaterThan(50)
  })

  it('pins the compiler to a major whose default export carries that API', () => {
    const major = Number(ts.version.split('.')[0])
    expect(
      major,
      'typescript 7 exports only version/versionMajorMinor from its main entry',
    ).toBeLessThan(7)
  })
})
