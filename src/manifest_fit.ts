/** Fits an ordered list of manifest sections to a character budget by dropping whole rows, never by cutting text. Generic on purpose: it knows nothing about files, notes or fences, only headers, rows and a footer. */

/** One block of the manifest. `header` and `footer` are whole lines (a leading '' is the blank separator); `rows` are the droppable list items, each emitted whole or not at all. */
export interface FitSection {
  header: readonly string[]
  rows?: readonly string[]
  footer?: readonly string[]
  /** Fill order: 0 is filled first against the whole budget, then the `reserved` group, then ascending. Display order is the array order regardless. */
  priority: number
  /** Small must-survive sections, filled before the prioritized ones but bounded to a quarter of the budget so they cannot starve the rest. */
  reserved?: boolean
  /** Rows past this count are never shown, even with budget to spare. */
  maxRows?: number
}

export interface FitResult {
  text: string
  /** Rows emitted per section, index-aligned with the input; the first `shown[i]` rows of section i are the ones in `text`. */
  shown: number[]
  /** Headers of sections left out entirely, in display order. */
  omitted: string[]
}

const RESERVE_SHARE = 0.25

/** Characters `lines` add to a joined text: each line plus its separating newline. */
function cost(lines: readonly string[]): number {
  let n = 0
  for (const line of lines) n += line.length + 1
  return n
}

const moreLine = (n: number): string => `- ...and ${n} more`

/** The largest row count that fits `room`, 0 for a header-only section that fits, or null when the section cannot be shown at all. */
function rowsThatFit(s: FitSection, room: number): number | null {
  const rows = s.rows ?? []
  const fixed = cost(s.header) + cost(s.footer ?? [])
  if (rows.length === 0) return fixed <= room ? 0 : null
  const limit = Math.min(rows.length, s.maxRows ?? rows.length)
  const prefix = [0]
  for (let i = 0; i < limit; i++) prefix.push(prefix[i]! + rows[i]!.length + 1)
  for (let k = limit; k >= 1; k--) {
    const tail = k < rows.length ? moreLine(rows.length - k).length + 1 : 0
    if (fixed + prefix[k]! + tail <= room) return k
  }
  return null
}

function render(s: FitSection, k: number): string[] {
  const rows = s.rows ?? []
  const lines = [...s.header, ...rows.slice(0, k), ...(s.footer ?? [])]
  if (rows.length > 0 && k < rows.length) lines.push(moreLine(rows.length - k))
  return lines
}

/** Fills `budget` characters (the length of the joined text) with `sections`, whole rows only. A section whose header and first row cannot fit is omitted and listed in the result. */
export function fitSections(sections: readonly FitSection[], budget: number): FitResult {
  const shown: (number | null)[] = sections.map(() => null)
  // One extra: the text has one fewer newline than the per-line costs sum to.
  let room = budget + 1
  const place = (indices: readonly number[], limit: number): void => {
    let spent = 0
    for (const i of indices) {
      const k = rowsThatFit(sections[i]!, Math.min(limit, room) - spent)
      if (k === null) continue
      shown[i] = k
      spent += cost(render(sections[i]!, k))
    }
    room -= spent
  }
  const indices = sections.map((_, i) => i)
  place(indices.filter((i) => sections[i]!.priority === 0 && sections[i]!.reserved !== true), room)
  place(indices.filter((i) => sections[i]!.reserved === true), Math.floor(budget * RESERVE_SHARE))
  const rest = indices.filter((i) => sections[i]!.priority !== 0 && sections[i]!.reserved !== true)
  rest.sort((a, b) => sections[a]!.priority - sections[b]!.priority || a - b)
  place(rest, room)

  const lines: string[] = []
  const omitted: string[] = []
  sections.forEach((s, i) => {
    const k = shown[i]
    if (k === null || k === undefined) omitted.push(s.header.find((l) => l !== '') ?? '')
    else lines.push(...render(s, k))
  })
  return { text: lines.join('\n'), shown: shown.map((k) => k ?? 0), omitted }
}
