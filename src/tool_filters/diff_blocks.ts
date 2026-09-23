// Shared unified-diff block handling for the git filter and the plain-diff branch of the shell-file filter. Both grew the same budgeted collapse independently -- the plain-diff copy carried a comment naming git's as its source -- and the two differed only in which regexes decide what a file block and a hunk header are. Parameterising those two decisions leaves one implementation, so a fix to the budget arithmetic cannot land in one filter and miss the other.

/** A diff line adding content. `+++` is the new-file header, not an addition. */
export function isDiffAdd(line: string): boolean {
  return line.startsWith('+') && !line.startsWith('+++')
}

/** A diff line removing content. `---` is the old-file header, not a removal. */
export function isDiffRemove(line: string): boolean {
  return line.startsWith('-') && !line.startsWith('---')
}

/** How a caller recognises its own dialect: whether a block is one file's diff, and whether a line opens a hunk. */
export interface DiffBlockShape {
  isFileBlock: (block: string) => boolean
  isHunkHeader: (line: string) => boolean
}

/**
 * Collapse per-file diff blocks in order to fit `maxLines` when per-hunk compression still leaves the
 * whole body over the cap. A block that is not a file block (the prelude before the first file header,
 * e.g. a `git show` commit header) is always kept whole; a file block is kept whole if it fits within
 * the remaining budget once the collapsed cost of every later file block is reserved, otherwise it is
 * replaced by its header lines plus a one-line summary of how much was collapsed.
 *
 * Earlier files stay intact -- diff output is ordered by path -- so a reader scanning top-down sees full
 * hunks first and headers-only for the files that did not fit. Without it, base.ts step 8 hands the whole
 * body to truncateMiddleSmart, which picks survivors by error-keyword content rather than file identity
 * and drops whole file headers with no disclosure.
 */
export function collapseDiffBlocksToCap(outBlocks: string[], maxLines: number, shape: DiffBlockShape): string[] {
  const isFileBlock = outBlocks.map((block) => shape.isFileBlock(block))
  const collapsedFormOf = (block: string): { headerLines: string[]; summary: string; size: number } => {
    const lines = block.split('\n')
    const hunkIdx = lines.findIndex((ln) => shape.isHunkHeader(ln))
    const headerLines = hunkIdx === -1 ? lines : lines.slice(0, hunkIdx)
    const hunkCount = lines.filter((ln) => shape.isHunkHeader(ln)).length
    const added = lines.filter(isDiffAdd).length
    const removed = lines.filter(isDiffRemove).length
    const summary = `[token-goat: ${hunkCount} hunk(s), +${added} -${removed} lines collapsed to fit the line cap]`
    return { headerLines, summary, size: headerLines.length + 1 }
  }

  const collapsedSizes = outBlocks.map((block, i) => (isFileBlock[i] ? collapsedFormOf(block).size : 0))
  const reserve: number[] = new Array(outBlocks.length).fill(0)
  for (let i = outBlocks.length - 2; i >= 0; i--) reserve[i] = reserve[i + 1]! + collapsedSizes[i + 1]!

  let budget = maxLines
  const result: string[] = []
  for (let i = 0; i < outBlocks.length; i++) {
    const block = outBlocks[i]!
    if (!isFileBlock[i]) {
      result.push(block)
      budget -= block.split('\n').length
      continue
    }
    const lineCount = block.split('\n').length
    if (lineCount <= budget - reserve[i]!) {
      result.push(block)
      budget -= lineCount
    } else {
      const { headerLines, summary, size } = collapsedFormOf(block)
      result.push(headerLines.join('\n') + '\n' + summary)
      budget -= size
    }
  }
  return result
}
