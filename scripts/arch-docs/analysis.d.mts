export interface SideEffect {
  module: string
  /** Taxonomy labels in order; `[Pure Domain]` only when no other label applies. */
  labels: string[]
}

export interface LayerViolation {
  source: string
  source_layer: string
  target: string
  target_layer: string
}

export interface Architecture {
  sideEffects: SideEffect[]
  layerViolations: LayerViolation[]
  /** Each strongly connected component of two or more modules, or one module importing itself, with its paths sorted. */
  staticCycles: string[][]
}

/** Side effects, layer-order violations and static cycles of the documented modules; `texts` maps a module key to its source. */
export function analyzeArchitecture(rows: ReadonlyMap<string, { layer: string }>, texts: ReadonlyMap<string, string>): Architecture
