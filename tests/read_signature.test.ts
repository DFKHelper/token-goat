import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { bundleTg, makeBundleProject, type BundleProject } from './helpers/bundle.js'
import type { TsNode, TsParserCtor } from '../src/parser_ts_types.js'
import { extractSignature, extractSignatureWithTypeContext } from '../src/read_signature.js'

const require = createRequire(import.meta.url)
const TreeSitterParser = require('tree-sitter') as TsParserCtor
const typescriptGrammar = (require('tree-sitter-typescript') as { typescript: unknown }).typescript

function parseTypeScript(source: string): TsNode {
  const parser = new TreeSitterParser()
  parser.setLanguage(typescriptGrammar)
  return parser.parse(source).rootNode
}

describe('extractSignature', () => {
  it('extracts TypeScript/JavaScript function signature', () => {
    const fn = `export function calculateTotal(items: Item[], tax: number): number {
      const sum = items.reduce((acc, x) => acc + x.price, 0)
      return sum * (1 + tax)
    }`
    expect(extractSignature(fn)).toBe('export function calculateTotal(items: Item[], tax: number): number')
  })

  it('handles multiline parameters and return types', () => {
    const fn = `export async function fetchData(
  url: string,
  options?: { timeout?: number; retries?: number }
): Promise<Response> {
  return fetch(url)
}`
    expect(extractSignature(fn)).toBe(`export async function fetchData(
  url: string,
  options?: { timeout?: number; retries?: number }
): Promise<Response>`)
  })

  it('extracts Python function signature', () => {
    const py = `def process_data(records: list[dict], threshold: float = 0.5) -> int:
    """Process incoming records."""
    count = 0
    for r in records:
        count += 1
    return count`
    expect(extractSignature(py)).toBe('def process_data(records: list[dict], threshold: float = 0.5) -> int:')
  })

  it('extracts COBOL labels and a level-01 declaration without fixed-format columns', () => {
    expect(extractSignature('000100 MAIN-SECTION SECTION.\n000200 NEXT-PARA.', 'section')).toBe('MAIN-SECTION SECTION.')
    expect(extractSignature('000100 RUN-PARA.\n000200 DISPLAY "BODY".', 'paragraph')).toBe('RUN-PARA.')
    expect(extractSignature([
      '000100 01 CUSTOMER-REC',
      '000200     PIC X(10) VALUE "A.B".',
      '000300 05 CUSTOMER-ID PIC X(8).',
    ].join('\n'), 'variable')).toBe('01 CUSTOMER-REC PIC X(10) VALUE "A.B".')
  })

  it('handles decorators gracefully', () => {
    const fn = `@logged\n@timed(100)\nexport function performAction(): void {\n  console.log("action")\n}`
    expect(extractSignature(fn)).toBe('export function performAction(): void')
  })

  it('works end-to-end via runRead with sig: true', async () => {
    const { runRead } = await import('../src/read_commands.js')
    const res = runRead({ spec: 'src/read_signature.ts::extractSignature', sig: true })
    expect(res.code).toBe(0)
    expect(res.text).toContain('export function extractSignature(body: string')
    expect(res.text).not.toContain('let parenDepth = 0')
  })

  it('works end-to-end via runSymbol with sig: true', async () => {
    const { runSymbol } = await import('../src/read_symbol.js')
    const res = runSymbol({ name: 'extractSignature', sig: true, limit: 1 })
    expect(res.code).toBe(0)
    expect(res.text).toContain('export function extractSignature(body: string')
    expect(res.text).not.toContain('let parenDepth = 0')
  })
})

describe('extractSignatureWithTypeContext', () => {
  it('resolves transitive type definitions used by a function and omits unrelated types', () => {
    const filePath = 'src/service.ts'
    const root = parseTypeScript([
      'interface FetchOptions { result: User }',
      'interface User { address: Address }',
      'interface Address { city: string }',
      'interface T { shadowed: string }',
      'interface BodyOnly { ignored: boolean }',
      'interface Unused { secret: string }',
      'export function findUser<T extends FetchOptions>(options: T): Promise<User> { return Promise.resolve({} as BodyOnly) }',
    ].join('\n'))

    const context = extractSignatureWithTypeContext([{ filePath, root }], filePath, 'findUser')

    expect(context).toContain('export function findUser<T extends FetchOptions>(options: T): Promise<User>')
    expect(context).toContain('interface FetchOptions { result: User }')
    expect(context).toContain('interface User { address: Address }')
    expect(context).toContain('interface Address { city: string }')
    expect(context).not.toContain('interface T')
    expect(context).not.toContain('interface BodyOnly')
    expect(context).not.toContain('interface Unused')
  })

  it('resolves aliased imports across files and terminates on recursive types', () => {
    const servicePath = 'src/service.ts'
    const typesPath = 'src/types.ts'
    const context = extractSignatureWithTypeContext(
      [
        {
          filePath: servicePath,
          root: parseTypeScript([
            `import type { Payload as ApiPayload } from './types'`,
            'export function send<T extends string>(payload: ApiPayload<T>): ApiPayload<T> { return payload }',
          ].join('\n')),
        },
        {
          filePath: typesPath,
          root: parseTypeScript([
            'export interface Payload<T> { node?: Node<T> }',
            'export interface Node<T> { payload?: Payload<T> }',
            'export interface Unused { value: boolean }',
          ].join('\n')),
        },
      ],
      servicePath,
      'send',
    )

    expect(context).toContain('export function send<T extends string>(payload: ApiPayload<T>): ApiPayload<T>')
    expect(context).toContain('export interface Payload<T> { node?: Node<T> }')
    expect(context).toContain('export interface Node<T> { payload?: Payload<T> }')
    expect(context).toContain('type ApiPayload<T> = Payload<T>')
    expect(context).not.toContain('interface Unused')
  })

  it('resolves default-imported declarations', () => {
    const servicePath = 'src/service.ts'
    const typesPath = 'src/default-types.ts'
    const context = extractSignatureWithTypeContext(
      [
        {
          filePath: servicePath,
          root: parseTypeScript([
            `import type ApiPayload from './default-types'`,
            'export function send(payload: ApiPayload): ApiPayload { return payload }',
          ].join('\n')),
        },
        {
          filePath: typesPath,
          root: parseTypeScript('export default interface Payload { value: string }'),
        },
      ],
      servicePath,
      'send',
    )

    expect(context).toContain('export default interface Payload { value: string }')
    expect(context).toContain('type ApiPayload = Payload')
  })

  it('finds class methods by qualified name and collects all file signatures when no name is supplied', () => {
    const filePath = 'src/store.ts'
    const root = parseTypeScript([
      'interface Query { id: string }',
      'interface Result { value: number }',
      'class Store { find(query: Query): Result { return { value: 1 } } }',
      'export function health(): string { return "ok" }',
      'export const parse = (query: Query): Result => ({ value: 1 })',
    ].join('\n'))

    const methodContext = extractSignatureWithTypeContext([{ filePath, root }], filePath, 'Store.find')
    expect(methodContext).toContain('find(query: Query): Result')
    expect(methodContext).toContain('interface Query')
    expect(methodContext).toContain('interface Result')

    const fileContext = extractSignatureWithTypeContext([{ filePath, root }], filePath)
    expect(fileContext).toContain('find(query: Query): Result')
    expect(fileContext).toContain('export function health(): string')
    expect(fileContext).toContain('export const parse = (query: Query): Result =>')
    expect(fileContext).toContain('interface Query')
    expect(fileContext).toContain('interface Result')
  })
})

// Provenance: HAND-DERIVED. The file below is written by this test and the expected lines are read off it; the flag spellings are the ones docs/cli.md and README.md document. The in-process runRead/runSymbol rows above call the handler with `sig: true` directly and so never cross the Commander option parse, which is where `--sig, --signature` lands on the attribute `signature`.
describe('the --sig and --signature flags reach the handler through the built CLI', () => {
  const SRC_FILE = 'sample_sig.ts'
  let tmp: BundleProject | undefined

  beforeEach(() => {
    tmp = makeBundleProject('tg-sig-')
    writeFileSync(path.join(tmp.project, SRC_FILE), 'export function pickWinner(scores: number[]): number {\n  const SIG_BODY_MARKER = scores.length\n  return SIG_BODY_MARKER\n}\n', 'utf-8')
  })

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp.root, { recursive: true, force: true })
    tmp = undefined
  })

  for (const flag of ['--sig', '--signature']) {
    it(`read ${flag} prints the declaration line and omits the body`, () => {
      const res = bundleTg(tmp!.project, tmp!.env, ['read', `${SRC_FILE}::pickWinner`, flag])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('export function pickWinner(scores: number[]): number')
      expect(res.stdout).not.toContain('SIG_BODY_MARKER')
    })

    it(`symbol ${flag} prints the declaration line and omits the body`, () => {
      const res = bundleTg(tmp!.project, tmp!.env, ['symbol', 'pickWinner', flag, '--file', SRC_FILE])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('export function pickWinner(scores: number[]): number')
      expect(res.stdout).not.toContain('SIG_BODY_MARKER')
    })
  }

  it('read and symbol --sig return the complete COBOL level-01 declaration only', () => {
    const cobolFile = 'sample_cobol.cbl'
    writeFileSync(path.join(tmp!.project, cobolFile), [
      '000100 IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. SIGTEST.',
      '000300 DATA DIVISION.',
      '000400 WORKING-STORAGE SECTION.',
      '000500 01 CUSTOMER-REC',
      '000600     PIC X(10).',
      '000700 PROCEDURE DIVISION.',
      '000800 MAIN-PARA.',
      '000900     DISPLAY "COBOL_BODY_MARKER".',
      '001000     STOP RUN.',
    ].join('\n'), 'utf-8')

    const read = bundleTg(tmp!.project, tmp!.env, ['read', `${cobolFile}::CUSTOMER-REC`, '--signature'])
    expect(read.status).toBe(0)
    expect(read.stdout).toContain('01 CUSTOMER-REC PIC X(10).')
    expect(read.stdout).not.toContain('COBOL_BODY_MARKER')

    const symbol = bundleTg(tmp!.project, tmp!.env, ['symbol', 'CUSTOMER-REC', '--sig', '--file', cobolFile])
    expect(symbol.status).toBe(0)
    expect(symbol.stdout).toContain('01 CUSTOMER-REC PIC X(10).')
    expect(symbol.stdout).not.toContain('COBOL_BODY_MARKER')
  })

  it('outline and read resolve COBOL paragraphs and copybook data conditions', () => {
    const cobolFile = 'sample_cobol.cbl'
    const copybookFile = 'customer.cpy'
    writeFileSync(path.join(tmp!.project, cobolFile), [
      '000100 IDENTIFICATION DIVISION.',
      '000200 PROGRAM-ID. SIGTEST.',
      '000300 PROCEDURE DIVISION.',
      '000400 MAIN-PARA.',
      '000500     DISPLAY "COBOL_BODY_MARKER".',
      '000600     STOP RUN.',
    ].join('\n'), 'utf-8')
    writeFileSync(path.join(tmp!.project, copybookFile), [
      '*> Customer copybook',
      '01 CUSTOMER-REC.',
      '  05 CUSTOMER-STATUS PIC X.',
      '    88 CUSTOMER-ACTIVE VALUE "A".',
    ].join('\n'), 'utf-8')

    const cobolOutline = bundleTg(tmp!.project, tmp!.env, ['outline', cobolFile])
    expect(cobolOutline.status).toBe(0)
    expect(cobolOutline.stdout).toMatch(/paragraph\s+MAIN-PARA/)

    const paragraph = bundleTg(tmp!.project, tmp!.env, ['read', `${cobolFile}::MAIN-PARA`])
    expect(paragraph.status).toBe(0)
    expect(paragraph.stdout).toContain('COBOL_BODY_MARKER')

    const copybookOutline = bundleTg(tmp!.project, tmp!.env, ['outline', copybookFile])
    expect(copybookOutline.status).toBe(0)
    expect(copybookOutline.stdout).toMatch(/variable\s+CUSTOMER-STATUS/)
    expect(copybookOutline.stdout).toMatch(/condition\s+CUSTOMER-ACTIVE/)

    const condition = bundleTg(tmp!.project, tmp!.env, ['read', `${copybookFile}::CUSTOMER-ACTIVE`])
    expect(condition.status).toBe(0)
    expect(condition.stdout).toContain('88 CUSTOMER-ACTIVE VALUE "A".')
  })
})
