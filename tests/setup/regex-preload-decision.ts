/** Whether a test file loads the adapters: yes unless it opted out by comment or sits on the list of files that never reach the parser. `relativePath` is null when the file is outside the repo, which always loads. */
export function loadsRegexAdapters(relativePath: string | null, outsideParser: readonly string[] | undefined, optedOut: boolean): boolean {
  if (optedOut) return false
  if (relativePath === null || outsideParser === undefined) return true
  return !outsideParser.includes(relativePath)
}
