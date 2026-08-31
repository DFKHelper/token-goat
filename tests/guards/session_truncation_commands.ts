/**
 * The row-limited commands whose rows come from a session cache rather than a project index.
 *
 * Shared by the two halves of the truncation guard so neither can drift from the other:
 * truncation_invariant_holds_session.test.ts asserts it drives exactly this set, and
 * truncation_invariant_holds.test.ts treats it as covered rather than demanding an exemption.
 *
 * Kept in a plain module, not exported from either test file, because importing one test file from
 * another would execute its suite a second time.
 *
 * The point of sharing it is that deleting a case cannot go unnoticed: drop one from the session
 * guard and its own coverage assertion fails, while dropping it from here makes the sibling guard
 * demand a case or a reasoned exemption for it. There is no edit that quietly removes a command
 * from both.
 */
export const SESSION_TRUNCATION_COMMANDS: readonly string[] = [
  'bash-history',
  'web-history',
  'mcp-history',
  'history',
  'hot',
  'recall',
]
