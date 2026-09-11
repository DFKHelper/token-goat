/**
 * Shared shape for a `[[hooks.<Event>]]`-style matcher group: an optional `matcher` string plus
 * a list of hook entries, each carrying at least a `command` string. Codex's config.toml and
 * Gemini's settings.json each define their own nominal `*MatcherGroup`/`*HookEntry` interfaces
 * (structurally identical to this one) so their own modules keep format-specific fields
 * type-checked separately; this shared shape only needs the fields {@link groupHasTokenGoat}
 * actually reads.
 */
export interface HookMatcherGroup {
  matcher?: string
  hooks?: Array<{ command: string }>
}

/**
 * Locates the actual `{ groupIndex, hookIndex }` of the first hook entry matching `predicate` under the exact `matcher` value (`undefined` matches a no-matcher lifecycle group), or `undefined` if none match. `groupIndex`/`hookIndex` are the entry's real position in `groups`, not an assumed position from some external ordering (e.g. a matcher constant list) -- a caller that derives a `[hooks.state]` trusted-hash key from anything other than this real position will silently look up the wrong key the moment another group sits ahead of ours in the array.
 */
export function findTokenGoatEntryPosition(
  groups: HookMatcherGroup[] | undefined,
  matcher: string | undefined,
  predicate: (command: string) => boolean,
): { groupIndex: number; hookIndex: number } | undefined {
  if (groups === undefined) return undefined
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex]!
    if (group.matcher !== matcher) continue
    const hookList = group.hooks ?? []
    for (let hookIndex = 0; hookIndex < hookList.length; hookIndex++) {
      if (predicate(hookList[hookIndex]!.command)) return { groupIndex, hookIndex }
    }
  }
  return undefined
}

/**
 * True when `groups` already has a hook entry matching `predicate` under the exact `matcher`
 * value (`undefined` matches a no-matcher lifecycle group). Shared by codex_install.ts, gemini_install.ts, and qwen_install.ts, whose matcher-group formats are structurally identical; qwen_install.ts always installs under the catch-all `''` matcher, but its settings.json format does support per-matcher groups (it mirrors Claude Code's own scheme), so a locally duplicated matcher-blind version would have silently matched a stale command under the wrong matcher the moment qwen ever grew per-tool matcher install.
 */
export function groupHasTokenGoat(
  groups: HookMatcherGroup[] | undefined,
  matcher: string | undefined,
  predicate: (command: string) => boolean,
): boolean {
  return findTokenGoatEntryPosition(groups, matcher, predicate) !== undefined
}
