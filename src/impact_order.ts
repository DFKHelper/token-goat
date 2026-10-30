/** Orders impact-hop entries: hop distance first, then cross-file callers ahead of same-file callers. */

import { compareHopEntries } from './graph_traversal.js'

export interface ImpactHopEntry {
  key: string
  name: string
  hop: number
  filePath: string
}

export interface CompareImpactHopsOptions {
  left: ImpactHopEntry
  right: ImpactHopEntry
  rootFilePaths: readonly string[]
}

export function compareImpactHops(options: CompareImpactHopsOptions): number {
  const { left, right, rootFilePaths } = options
  if (left.hop !== right.hop) return left.hop - right.hop
  const leftCross = !rootFilePaths.includes(left.filePath)
  const rightCross = !rootFilePaths.includes(right.filePath)
  if (leftCross !== rightCross) return leftCross ? -1 : 1
  return compareHopEntries([left.name, left.hop], [right.name, right.hop]) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
}
