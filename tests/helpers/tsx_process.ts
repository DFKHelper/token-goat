/** Build Node args for a TypeScript child without invoking tsx's IPC-based CLI. */
export function tsxProcessArgs(entry: string, ...args: string[]): string[] {
  // --import is unavailable on early Node 18 releases still allowed by package.json.
  const loaderFlag = process.allowedNodeEnvironmentFlags.has('--import') ? '--import' : '--loader'
  return [loaderFlag, 'tsx', entry, ...args]
}
