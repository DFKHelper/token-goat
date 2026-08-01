import { expect } from 'vitest'
import type { HookOutput } from '../../src/types.js'

/** Assert a HookOutput's discriminant is `kind` and narrow the static type accordingly, so a following `result.<field>` access (e.g. `result.context`, `result.message`) typechecks instead of erroring on the wider union. Equivalent at runtime to `expect(result.hookType).toBe(kind)`. */
export function expectHookType<K extends HookOutput['hookType']>(
  result: HookOutput,
  kind: K,
): asserts result is Extract<HookOutput, { hookType: K }> {
  expect(result.hookType).toBe(kind)
}
