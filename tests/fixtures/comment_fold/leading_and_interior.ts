/**
 * A source file shaped for the comment-fold edge cases of the shell read door.
 * It opens with a comment run long enough to fold on its own, so a head read
 * that stops inside the run and one that returns the whole file can be told
 * apart by whether a fold notice appears.
 *
 * The repository folds its own multi-line comments onto one line, so a real
 * source file cannot be relied on to keep a run this long. This file sits
 * under tests/fixtures, which that fold leaves alone, and its shape is fixed
 * by hand rather than by whatever the source tree happens to look like.
 *
 * Every line in both runs is plain prose with no backtick, since a window
 * holding one would read as an open template literal to the fold planner.
 *
 * The truncated head case asks for eighteen lines, so this run has to go on
 * past line eighteen for that read to stop inside it rather than after it.
 * These closing lines exist only to carry the run past that point with room
 * to spare, so a small change to the fold minimum does not break the case.
 *
 * Nothing in this file is imported, executed, or compared against anything.
 * The functions below exist so the comment runs have code around them.
 * Line twenty three closes the leading run.
 */
export const first = 1
export const second = first + 1
export const third = second + 1
export const fourth = third + 1
export const fifth = fourth + 1

/**
 * The interior run sits strictly inside the file, with code above and below
 * it, so a sed window can hold it whole or stop partway through it.
 *
 * A window that holds it whole folds it and keeps its opening lines, while
 * a window that ends inside it leaves it alone, because the recall pointer
 * the fold would print names lines the window did not deliver.
 *
 * These lines carry no meaning beyond their count and their shape.
 * They are long enough to read as prose and short enough to stay on screen.
 * The planner only sees that each one opens with a comment marker.
 * The truncated sed case needs at least fifteen lines in this run.
 * This run has twenty, which leaves room on both sides of that minimum.
 * Line thirty opens it and line forty nine closes it.
 * The code below it is long enough for the eight lines the window needs.
 * Each of these filler lines is distinct so a fold cannot match the wrong one.
 * One more line keeps the count where the description above says it is.
 * The run is nearly done.
 * The closing marker comes next.
 */
export function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length
}
