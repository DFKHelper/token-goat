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
 * True when `groups` already has a hook entry matching `predicate` under the exact `matcher`
 * value (`undefined` matches a no-matcher lifecycle group). Shared by codex_install.ts and
 * gemini_install.ts, whose matcher-group formats are structurally identical; qwen_install.ts's
 * own `groupHasTokenGoat` is deliberately NOT unified here -- Qwen's settings.json has no
 * per-matcher grouping at all, so its version has no `matcher` parameter or comparison, a real
 * shape difference rather than incidental duplication.
 */
export function groupHasTokenGoat(
  groups: HookMatcherGroup[] | undefined,
  matcher: string | undefined,
  predicate: (command: string) => boolean,
): boolean {
  if (groups === undefined) return false
  for (const group of groups) {
    if (group.matcher !== matcher) continue
    for (const h of group.hooks ?? []) {
      if (predicate(h.command)) return true
    }
  }
  return false
}
