/** The notices a listing command prints when a filter left nothing of what the store holds, so a filtered view never reads as a definitive "nothing here". Kept out of util.ts, a parser-fingerprint source, so rewording a notice costs users no reparse. */

import { displaySafeText } from './paths.js'

/** The subject of a sentence about every item of a counted set, agreeing with the count: "the only reference" for one, "all 3 references" otherwise. "all 1 reference was filtered out" agreed its noun and verb and still read as a slip in the tool rather than as a report about the store, and a single survivor is the most common way to reach the notices that use this. */
export function allOfCount(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? `the only ${singular}` : `all ${count} ${plural}`
}

/** {@link allOfCount} with the verb that agrees with it ("the only reference was", "all 3 references were") and the pronoun that refers back to it, since "all 1 type declaration was filtered out ... to see them" was half-corrected, agreeing the verb and then contradicting it one clause later. */
export function filteredSubject(count: number, singular: string, plural: string): { subject: string; pronoun: 'it' | 'them' } {
  const one = count === 1
  return { subject: `${allOfCount(count, singular, plural)} ${one ? 'was' : 'were'}`, pronoun: one ? 'it' : 'them' }
}

/** Shared `--grep`-filtered-to-empty notice for listing commands (`types`, `exports`, `imports`, `dead`, `deps`, `refs`, ...) that have no `--min-lines` counterpart. Distinguishes "the store genuinely has nothing" from "the store has N items but --grep matched none of them": without it both states render as the same bare empty message and a caller cannot tell whether to widen the filter or give up on the file or project, the "filtered store renders as populated" trap this repo has hit 9+ times. `nounSingular`/`nounPlural` name what was filtered (e.g. "type declaration" / "type declarations") so the message matches the command's own vocabulary. */
export function grepFilteredToEmptyNotice(preFilterCount: number, grep: string, nounSingular: string, nounPlural: string): string {
  const { subject, pronoun } = filteredSubject(preFilterCount, nounSingular, nounPlural)
  return `  (${subject} filtered out by --grep ${displaySafeText(grep)} -- widen or drop the filter to see ${pronoun})`
}

/** The multi-filter sibling of {@link grepFilteredToEmptyNotice}, for surfaces where more than one filter flag can be active at once (skeleton/outline's `--min-lines` + `--grep`, csv-query's repeatable `--where`). Names every active filter rather than blaming the first one, since with two set, blaming one sends the caller to widen the wrong knob, and takes an optional `reassurance` clause for callers that also need to say the underlying store is fine (e.g. "the file is indexed"). */
export function filtersFilteredToEmptyNotice(preFilterCount: number, activeFilters: string[], nounSingular: string, nounPlural: string, reassurance?: string): string {
  const { subject, pronoun } = filteredSubject(preFilterCount, nounSingular, nounPlural)
  const cause = activeFilters.length === 0 ? 'the active filter' : activeFilters.map(displaySafeText).join(' + ')
  const knob = activeFilters.length > 1 ? 'filters' : 'filter'
  const tail = reassurance === undefined ? '' : `; ${reassurance}`
  return `  (${subject} filtered out by ${cause}${tail} -- widen or drop the ${knob} to see ${pronoun})`
}
