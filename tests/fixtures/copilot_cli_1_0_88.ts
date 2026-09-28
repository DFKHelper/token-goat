/** Provenance: CAPTURE. Each JSON file beside this module is the exact stdin one GitHub Copilot CLI 1.0.88 hook received, recorded on 2026-09-28 by a marker hook registered for every documented event in an isolated COPILOT_HOME (model gpt-5-mini, `copilot -p ... --allow-all-tools`). The source is `%TEMP%\tg-captures\<ID>\raw\<NNN>-<event>[-<tool>].json` for the file named `<ID>-<NNN>-<event>[-<tool>].json` here, byte for byte except two substitutions: the capture's absolute workspace directory became `{{PROJ}}` and its isolated home became `{{HOME}}`. Session ids, timestamps and traceparents are the recorded values. What each capture showed on the wire (the model request bodies logged by `--log-level all`) is summarized in `%TEMP%\tg-captures\REPORT.md`:
 * - C1a: a postToolUse `additionalContext` alone reaches the model once, appended to the tool output as `Tool "view" succeeded. Additional guidance from postToolUse hooks:\n<ctx>`.
 * - C1c: `modifiedResult` and `additionalContext` together each reach the model once: the output is replaced by the modifiedResult text and the context is appended to it.
 * - C4a/C4c: the `task` tool. subagentStart carries the parent sessionId and no agentId, and its additionalContext is prepended to the subagent's prompt. subagentStop carries agentId, agentType and the raw `response`, and its `modifiedResponse` replaces what the parent's postToolUse task toolResult and function_call_output hold.
 * - C5: the `skill` tool's argument key is `skill`.
 * - C6: the Windows shell tool is `powershell` with `{command, description}`.
 * - C7: a `/compact` on a resumed session fires preCompact (whose additionalContext is not honored) and then the next prompt's userPromptSubmitted in the same session. */
import * as fs from 'node:fs'
import * as path from 'node:path'

const DIR = path.join(__dirname, 'copilot_cli_1_0_88')

/** The captured payload `name` (the file name without `.json`), with `{{PROJ}}` and `{{HOME}}` replaced by `vars`. */
export function copilotCapture(name: string, vars: { proj: string; home?: string }): Record<string, unknown> {
  const escape = (value: string): string => JSON.stringify(value).slice(1, -1)
  const text = fs
    .readFileSync(path.join(DIR, `${name}.json`), 'utf8')
    .split('{{PROJ}}')
    .join(escape(vars.proj))
    .split('{{HOME}}')
    .join(escape(vars.home ?? vars.proj))
  return JSON.parse(text) as Record<string, unknown>
}
