/** Minimal structural typings for the node-tree-sitter API surface we touch. The packages ship no first-class .d.ts under this resolution, so we model only the members used here rather than pulling `any` through the module. */

export interface TsPoint {
  readonly row: number
  readonly column: number
}

export interface TsNode {
  readonly type: string
  readonly text: string
  readonly startPosition: TsPoint
  readonly endPosition: TsPoint
  readonly namedChildren: TsNode[]
  readonly parent: TsNode | null
  readonly previousNamedSibling: TsNode | null
  childForFieldName(field: string): TsNode | null
}

export type TsTypeDefinitionKind = 'interface' | 'type' | 'class' | 'enum'

export interface TsTypeDefinition {
  readonly name: string
  readonly kind: TsTypeDefinitionKind
  readonly filePath: string
  readonly source: string
  readonly references: readonly string[]
  readonly exported: boolean
  readonly defaultExport: boolean
  readonly typeParameters: string
  readonly typeParameterNames: readonly string[]
}

export interface TsTypeImportBinding {
  readonly filePath: string
  readonly moduleSpecifier: string
  readonly localName: string
  readonly importedName: string
  readonly namespace: boolean
}

export interface TsSignatureInfo {
  readonly name: string
  readonly qualifiedName: string
  readonly kind: 'function' | 'method'
  readonly declaration: string
  readonly signature: string
  readonly references: readonly string[]
}

export interface TsTree {
  readonly rootNode: TsNode
}

export interface TsParser {
  setLanguage(lang: unknown): void
  parse(input: string): TsTree
}

export interface TsParserCtor {
  new (): TsParser
}

/** Grammar object handed to `parser.setLanguage`. Opaque to us. */
export type Grammar = unknown
