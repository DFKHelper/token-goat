/** The trailing notices the structured-query commands (json-query, yaml-query, xml-query, html-query, csv-query, mcp-output --json-query) append to a fanned result. One definition so the count and its noun agree on every surface instead of each site interpolating a bare plural. */

import { countNoun } from './util.js'

/** `...(1 more item elided; use --head to see more)` -- the line a `--head` cut appends, with `noun` (singular) agreeing with the hidden count. */
export function headElidedNotice(hidden: number, noun: string): string {
  return `...(${countNoun(hidden, `more ${noun}`)} elided; use --head to see more)`
}
