/**
 * Own-property lookup for plain-object maps whose keys arrive from outside this process.
 *
 * `key in map` and `map[key]` both walk the prototype chain, so a key named after an
 * `Object.prototype` member -- `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 * `__proto__` -- resolves to that member and hands back a function or `Object.prototype`
 * where the map's own value type promised a string. TypeScript cannot see it: the index
 * signature says the value is `T`, and the runtime disagrees.
 *
 * Both halves are captured on the shipping path, not speculative. A payload naming the tool
 * `constructor` left `tool_name` holding `Object` itself, and a VS Code input key named
 * `constructor` was rewritten to the literal text `function Object() { [native code] }`.
 * Tool names and input keys are chosen by the harness, and an MCP server names its own tools,
 * so `srv:valueOf` strips to `valueOf` and reaches the same lookup.
 *
 * Use this for any map indexed by a harness-, config-, or user-supplied string. A map indexed
 * by a literal this module controls needs nothing.
 */
export function ownGet<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  if (!map || !Object.hasOwn(map, key)) return undefined
  return map[key]
}
