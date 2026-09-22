/**
 * Copilot CLI's built-in tool names, mapped to the canonical token-goat names every hook gates on.
 *
 * This lives in its own leaf module because two places need it and neither can import the other
 * cheaply: `src/hooks_cli.ts` normalizes an inbound payload with it, and `src/bridges/copilot_cli.ts`
 * resolves a folded variant with it while generating the shim. They held byte-identical copies, with
 * nothing forcing them to agree -- the same shape that has already shipped a stale matcher list, a
 * stale hook event-name map, and a stale tool-name map in this repo. Adding a Copilot tool to one
 * copy and not the other is silent: each file's own tests keep passing on its own copy.
 */
export const COPILOT_CLI_TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  powershell: 'Bash',
  read_bash: 'BashOutput',
  read_powershell: 'BashOutput',
  view: 'Read',
  create: 'Write',
  edit: 'Edit',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  grep: 'Grep',
  glob: 'Glob',
  skill: 'Skill',
  exit_plan_mode: 'ExitPlanMode',
}
