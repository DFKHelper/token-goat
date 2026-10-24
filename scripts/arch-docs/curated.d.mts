export interface DocumentedRow {
  module: string
  layer: string
  role: string
  exports: string
}

export interface RenameInput {
  /** The rows of the documented table, by module path. */
  documented: ReadonlyMap<string, DocumentedRow>
  /** The modules that exist now. */
  current: ReadonlySet<string>
  /** Renames from git, old path to new path. */
  records: readonly { from: string; to: string }[]
  /** True when a path is a module under the config's roots and excludes. */
  isComponent: (file: string) => boolean
  /** The role a module gets with no curated text. */
  autoRole: (key: string) => string
  /** The role a module had at HEAD under the given layer, or null when HEAD has none. */
  headAutoRole: (key: string, layer: string) => string | null
}

export interface RenameResolution {
  /** The role each new path takes, by new path. */
  overrides: Map<string, string>
  /** Notes for every rename, split and merge, in the order they were found. */
  notes: string[]
  /** The old paths that moved. */
  renamedAway: Set<string>
}

/** Re-keys curated roles from renamed-away paths: a split suffixes each child's role, a merge keeps the longest role. */
export function resolveRenames(data: RenameInput): RenameResolution
