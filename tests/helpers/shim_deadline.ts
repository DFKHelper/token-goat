/** FORMAT-DERIVED from COPILOT_CLI_HOOK_SCRIPT in src/bridges/copilot_cli.ts: the shim measures its 3 s budget from process birth, so on a slow machine the budget can be spent before a line of the shim runs. A test that must reach the code after a slow node boot runs a copy that starts the same budget when the shim begins. The budget itself is not touched: the native startup owner refuses any deadline more than 3 s out. */
const PROCESS_BIRTH = "Math.floor(require('node:perf_hooks').performance.timeOrigin)"

export function startBudgetAtShimStart(source: string): string {
  if (!source.includes(PROCESS_BIRTH)) throw new Error('the shim no longer derives its start from process birth; update this helper')
  return source.replace(PROCESS_BIRTH, 'Date.now()')
}
