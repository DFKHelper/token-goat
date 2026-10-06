/** The relevance decision every surface that answers from the dense index makes the same way: the configured `semantic.max_distance` floor, and the `semantic.weak_distance` label on what survives it. `semantic` and `search`'s semantic channel both read it here, so a floor a user sets narrows both and a page of noise is labelled weak in both. */
import { loadConfig } from './config.js'

/** Splits dense hits on the relevance floor, returning what survives and the closest distance that did not. The rejected minimum is what lets the caller say why the half came back empty: a floor is a threshold on a continuum, so "nothing matched" and "the best thing was 0.91 against a floor of 0.9" are different facts and only the second one is actionable. Compares raw `distance` rather than the rerank's `adjustedDistance`, since the floor was measured against raw distances and the rerank's boosts and path penalties are a ranking device with no calibrated scale. */
export function applyRelevanceFloor<H extends { readonly distance: number }>(
  hits: readonly H[],
  floor: number,
): { kept: H[]; nearestRejected: number | null } {
  const kept: H[] = []
  let nearestRejected: number | null = null
  for (const h of hits) {
    if (h.distance <= floor) {
      kept.push(h)
    } else if (nearestRejected === null || h.distance < nearestRejected) {
      nearestRejected = h.distance
    }
  }
  return { kept, nearestRejected }
}

/** What the floor and the weak label made of one dense result list. */
export interface DenseRelevance<H> {
  /** The hits at or under the floor, in their original order. */
  readonly kept: H[]
  /** The configured `semantic.max_distance`. */
  readonly floor: number
  /** The closest distance the floor dropped, or null when it dropped nothing. */
  readonly nearestRejected: number | null
  /** The best distance among the kept hits, or null when none were kept. */
  readonly closestDistance: number | null
  /** The configured `semantic.weak_distance`. */
  readonly weakDistance: number
  /** `closestDistance` when it is above `weakDistance`, so the whole list is a weak match; null otherwise. */
  readonly weakClosestDistance: number | null
}

/** Applies the configured floor to `hits` and measures the survivors against the configured weak distance. Nearest-neighbour search always returns something, so this is the only thing that tells a page of noise from a page of answers. */
export function assessDenseRelevance<H extends { readonly distance: number }>(hits: readonly H[]): DenseRelevance<H> {
  const { max_distance: floor, weak_distance: weakDistance } = loadConfig().semantic
  const { kept, nearestRejected } = applyRelevanceFloor(hits, floor)
  const closestDistance = kept.reduce<number | null>((best, h) => (best === null || h.distance < best ? h.distance : best), null)
  const weakClosestDistance = closestDistance !== null && closestDistance > weakDistance ? closestDistance : null
  return { kept, floor, nearestRejected, closestDistance, weakDistance, weakClosestDistance }
}

/** `nothing within <floor> (closest was <d>)` when the floor emptied the list outright, else null. Trimming a weak tail off a list that still has its best hit is the floor working as intended, and saying so on every ordinary search would be noise. */
export function floorEmptiedPhrase(r: DenseRelevance<unknown>): string | null {
  if (r.kept.length > 0 || r.nearestRejected === null) return null
  return `nothing within ${r.floor} (closest was ${r.nearestRejected.toFixed(3)})`
}

/** `closest was <d>, weak above <w>` when every kept hit is a weak match, else null. */
export function weakMatchPhrase(r: DenseRelevance<unknown>): string | null {
  if (r.weakClosestDistance === null) return null
  return `closest was ${r.weakClosestDistance.toFixed(3)}, weak above ${r.weakDistance}`
}
