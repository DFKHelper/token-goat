# Decision: do not adopt the function-hook surface yet

Status: decided, 2026-09-22. Closes item B5 of
`2026-09-21-compaction-measurement-and-local-decisions.md`.

## What was asked

That plan observed a second hook surface inside Claude Code, gated behind
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`, whose middleware point names include
`session.compact`, `tool.call`, `session.measure`, `session.usage`, `session.messages`
and `agent.spawn`. Such a surface would let token-goat remove content from a transcript
instead of advising a summarizer, intercept a tool call in process instead of through a
spawned shell hook, and read real token counts instead of estimating them. The item asked
for a spike and a written decision, not a migration.

## What the binary actually says

Measured against the installed Claude Code 2.1.276 (`bin/claude.exe`, git sha
`bc0a4292`, built 2026-09-18), by counting matching lines in the shipped binary:

| String | Matching lines |
| --- | --- |
| `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` | 5 |
| `functionHooks` | 141 |
| `session.compact` | 18 |
| `session.measure` | 13 |
| `session.usage` | 9 |
| `session.messages` | 30 |
| `agent.spawn` | 37 |
| `tool.call` | 342 |

Three findings change the picture the counts alone suggest.

**The 141 is one string, not 141 integration sites.** Every `functionHooks` match is the
same inlined build constant, `HOOKS_WORKER_URL: "…/src/plugins/functionHooks/hooks-worker/hooks-worker.js"`,
repeated wherever the build banner object was inlined. Filtering that constant out leaves
nothing. A count taken over a bundled binary measures how often a constant was inlined,
not how deeply a feature is wired, and this is the clearest example of that in the plan.

**The surface is a plugin field, not a settings entry.** `hooksModule` appears as a field
on a plugin record alongside `hooksConfig` and `mcpServers`, registered through the plugin
registry (`builtinPlugins`, `pluginStorageId`, `canLoadUserHooksModules`). token-goat
installs shell hooks by writing entries into `settings.json`. There is no path from that
installation shape to a middleware point: reaching `session.compact` would mean shipping
token-goat as a Claude Code plugin, which is a distribution change, not a hook change.

**It is off by default and revocable by policy.** The rollout flag
(`tengu_plugin_hooks_modules`) defaults to false; the env var is an override on top of a
remote rollout, and loading is refused outright under `disableAllHooks`,
`allowManagedHooksOnly`, or a managed policy. The shell surface the tool ships against
appears beside these points under its own prefix, `classic.PreToolUse` — present, named,
and distinct.

## Decision

Do not adopt. The shell-hook path stays the only integration, unchanged.

The three capabilities the surface would unlock are each worth less than they look right
now:

- **Removing content from a transcript** is the most invasive of the three and the one
  whose failure mode is silent: an entry removed in process leaves no marker for anyone to
  notice, unlike the manifest the compaction hook emits today.
- **Intercepting a tool call in process** buys latency on a path that already runs in a
  spawned process within its budget. The measured cost of the current path is in the hook
  latency figures, not in an unmeasured assumption about process spawn overhead.
- **Reading real token counts** is the one with genuine value, and B3 has just delivered
  most of it from the transcript corpus instead: `session-audit` now prints the estimator's
  measured error against `input_tokens + cache_creation_input_tokens`. That reads the same
  numbers off a file already on disk, with no flag and no plugin.

Against that, adoption costs a distribution change, a dependency on a flag that defaults
off and that an enterprise policy can revoke, and a second hook implementation to keep in
step with the first.

## What would reopen this

Any one of these, individually:

1. The surface is documented in Claude Code's own published documentation, which would
   make it something other than a spike.
2. The rollout flag defaults on, so an adopting install is the normal install rather than
   an opted-in one.
3. token-goat ships as a plugin for a reason of its own. The plugin registry is the
   prerequisite here, so if that distribution change happens for other reasons, the
   middleware points come within reach as a side effect and should be re-costed then.
4. The calibration B3 added shows the transcript-derived measurement is materially wrong
   in a way `session.usage` would fix. That is a measurement this repository can now make,
   which is why it belongs on the list rather than in a guess.

Re-check the three findings above before acting on any of them: all of them were read out
of one shipped binary at one version, and none of them is a contract.
