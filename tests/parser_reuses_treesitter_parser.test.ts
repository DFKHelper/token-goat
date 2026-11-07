import { createRequire } from 'node:module'

import { afterEach, describe, expect, it } from 'vitest'

import { isTreeSitterAvailable, parseSourceSymbolsTreeSitterOnly, setTreeSitterCoreForTesting } from '../src/parser.js'
import type { TsParser, TsParserCtor } from '../src/parser.js'

let parserCreations = 0
let languageAssignments = 0

const actualParserCtor = (() => {
  try {
    return createRequire(import.meta.url)('tree-sitter') as TsParserCtor
  } catch {
    return null
  }
})()

const canParseTypeScript = actualParserCtor !== null && isTreeSitterAvailable('typescript')

class CountingParser implements TsParser {
  private readonly delegate: TsParser

  constructor() {
    if (actualParserCtor === null) throw new Error('tree-sitter is unavailable')
    parserCreations++
    this.delegate = new actualParserCtor()
  }

  setLanguage(language: unknown): void {
    languageAssignments++
    this.delegate.setLanguage(language)
  }

  parse(input: string) {
    return this.delegate.parse(input)
  }
}

describe('tree-sitter parser reuse', () => {
  afterEach(() => setTreeSitterCoreForTesting(undefined))

  it.skipIf(!canParseTypeScript)('reuses one parser per resolved grammar', () => {
    parserCreations = 0
    languageAssignments = 0
    setTreeSitterCoreForTesting(CountingParser)

    const first = parseSourceSymbolsTreeSitterOnly(
      'export function first(): number { return 1 }',
      'first.ts',
      'typescript',
    )
    const component = parseSourceSymbolsTreeSitterOnly(
      'export function Component() { return <div /> }',
      'component.tsx',
      'typescript',
    )
    const again = parseSourceSymbolsTreeSitterOnly(
      'export function again(): number { return 2 }',
      'again.ts',
      'typescript',
    )

    expect(first?.map((symbol) => symbol.name)).toContain('first')
    expect(component?.map((symbol) => symbol.name)).toContain('Component')
    expect(again?.map((symbol) => symbol.name)).toContain('again')
    expect(parserCreations).toBe(2)
    expect(languageAssignments).toBe(2)
  })
})
