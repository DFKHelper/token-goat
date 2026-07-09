/**
 * Shared bridge types.
 *
 * A "bridge" translates between token-goat's internal hook protocol and the
 * wire format of one AI harness. Pure type leaf: no imports from other local
 * modules.
 */

/**
 * The AI harnesses token-goat knows how to detect, plus a generic fallback.
 *
 * `gemini`, `hermes`, and `openclaw` have no install-writer yet (see
 * `bridges/registry.ts`'s module docstring) but are still real, detectable
 * identities: harness detection matters independently of which harnesses
 * have install support, since it also drives hook-payload translation and
 * compaction budget heuristics.
 */
export type HarnessName =
  | 'claudecode'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'hermes'
  | 'openclaw'
  | 'pi'
  | 'copilot_cli'
  | 'grok'
  | 'generic'

/** Static description of how one harness's hooks are wired. */
export interface BridgeConfig {
  /** Which harness this config describes. */
  readonly harness: HarnessName
  /** Where the installed hook script lives on disk. */
  readonly hookScriptPath: string
  /**
   * Whether this harness expects a `hookEventName` const inside
   * `hookSpecificOutput`. Codex requires it (its schemas declare
   * `additionalProperties: false`); Claude Code tolerates its absence.
   */
  readonly hookSpecificOutput: boolean
}
