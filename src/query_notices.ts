/** The trailing notices the structured-query commands (json-query, yaml-query, xml-query, html-query, csv-query, mcp-output --json-query) append to a fanned result. One definition so the count and its noun agree on every surface instead of each site interpolating a bare plural. */

import { countNoun } from './util.js'

/** `...(1 more item elided; use --head to see more)` -- the line a `--head` cut appends, with `noun` (singular) agreeing with the hidden count. */
export function headElidedNotice(hidden: number, noun: string): string {
  return `...(${countNoun(hidden, `more ${noun}`)} elided; use --head to see more)`
}

/** The line a fanned query appends when its traversal limit stopped the search; with nothing matched there are no matches to qualify, so it says the search found none before it stopped rather than leaving a caveat about "these" under an empty result. */
export function traversalLimitNotice(matched: number): string {
  if (matched === 0) return "...(no matches: the search stopped at this tool's traversal limit before finding any, so the part of the document it did not reach may still hold some. Narrow the path to search less of the document.)"
  return "...(the search stopped early at this tool's traversal limit; these are not necessarily all the matches. Narrow the path to search less of the document.)"
}
