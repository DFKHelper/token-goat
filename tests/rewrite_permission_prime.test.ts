import { describe, expect, it, vi } from 'vitest'

const prime = vi.fn(async (_env: NodeJS.ProcessEnv, _helpers: unknown) => {})
const source = vi.fn((_cwd: string, _project: string | undefined, _env: NodeJS.ProcessEnv, _helpers: unknown, _query: unknown) => null)
vi.mock('../src/claude_hidden_rules.js', () => ({ hiddenRules: (helpers: unknown) => ({ hidden: (cwd: string) => source(cwd, undefined, process.env, helpers, {}) !== null, lineRules: () => false, prime: (env: NodeJS.ProcessEnv) => prime(env, helpers) }) }))

const { loadingHiddenRuleCheck, primeHiddenRulesAhead } = await import('../src/rewrite_permission.js')

// HAND-DERIVED: the permission_mode values are the ones decideRewrite branches on; the event shape is the `raw` payload every PreToolUse handler receives.
describe('primeHiddenRulesAhead', () => {
  it('a one-shot hook never reads the claude process ahead; once the hook server asks, every call in a mode that can approve is primed first, auto excepted', async () => {
    const order: string[] = []
    prime.mockImplementation(async () => {
      order.push('prime')
    })
    const handler = loadingHiddenRuleCheck((event: { readonly raw: Record<string, unknown> }) => {
      order.push(String(event.raw['permission_mode']))
      return event.raw['permission_mode']
    })
    expect(await handler({ raw: { permission_mode: 'bypassPermissions' } })).toBe('bypassPermissions')
    expect(await handler({ raw: { permission_mode: 'bypassPermissions' } })).toBe('bypassPermissions')
    expect(prime).not.toHaveBeenCalled()
    primeHiddenRulesAhead()
    await handler({ raw: { permission_mode: 'default' } })
    expect(prime).toHaveBeenCalledTimes(1)
    await handler({ raw: { permission_mode: 'bypassPermissions' } })
    expect(prime).toHaveBeenCalledTimes(2)
    expect(prime).toHaveBeenCalledWith(process.env, expect.anything())
    await handler({ raw: { permission_mode: 'auto' } })
    expect(prime).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['bypassPermissions', 'bypassPermissions', 'prime', 'default', 'prime', 'bypassPermissions', 'auto'])
  })
})
