// Key exports for the architecture map: the names a JS or TS module exports at its top level, in source order. Parsed with the TypeScript compiler, the parser the skill's reference engine (sync_arch_docs.py, section "jstokens.mts") reimplements by hand.
import ts from 'typescript'

const SCRIPT_KINDS = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
  ['.js', ts.ScriptKind.JS],
  ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS],
  ['.jsx', ts.ScriptKind.JSX],
])

/** File suffixes this engine reads exports and doc comments from. */
export const CODE_SUFFIXES = [...SCRIPT_KINDS.keys()]

const hasExport = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0

function bindingNames(name, add) {
  if (ts.isIdentifier(name)) {
    add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, add)
  }
}

/** Exported names of `text` (a module whose file name ends in `suffix`), unique, in source order. */
export function jsExports(text, suffix) {
  const kind = SCRIPT_KINDS.get(suffix) ?? ts.ScriptKind.TS
  const source = ts.createSourceFile(`module${suffix}`, text, ts.ScriptTarget.Latest, false, kind)
  const names = []
  const add = (name) => {
    if (!names.includes(name)) names.push(name)
  }
  const addIdentifier = (node) => {
    if (node !== undefined && ts.isIdentifier(node)) add(node.text)
  }
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (ts.isIdentifier(element.name) && element.name.text !== 'default') add(element.name.text)
        }
      } else if (clause !== undefined && ts.isNamespaceExport(clause)) {
        addIdentifier(clause.name)
      }
    } else if (ts.isExportAssignment(statement)) {
      addIdentifier(statement.expression)
    } else if (!hasExport(statement)) {
      continue
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, add)
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement)
    ) {
      addIdentifier(statement.name)
    }
  }
  return names
}
