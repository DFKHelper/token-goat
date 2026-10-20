/** Guard: an unknown command name that reflects a *conceptual* miss rather than a typo must get a pointer to the commands that actually serve the intent. Commander's built-in "(Did you mean X?)" is edit distance over the registered names. That works for `symbl` -> `symbol`, but a conceptual guess like `lookup` resolves to whichever registered name sits closest, which rarely does what the caller wanted. An agent that follows that suggestion burns a call and builds the wrong model of the CLI. The bundle-level cases below drive the real built binary, because the hint is emitted from run()'s commander error branch -- wiring no unit test on the pure functions can pin. */
import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, type CommandManifestEntry } from '../src/cli_commands.js'
import { attemptedCommandName, suggestForUnknownCommand } from '../src/command_intent.js'
import { runBundle } from './helpers/bundle.js'

describe('suggestForUnknownCommand', () => {
  it('points a search-shaped guess at the commands that actually search', () => {
    const hint = suggestForUnknownCommand('lookup')
    expect(hint).not.toBeNull()
    expect(hint).toContain('grep')
    expect(hint).toContain('semantic')
    expect(hint).toContain('symbol')
  })

  it('covers the other intent groups', () => {
    expect(suggestForUnknownCommand('cat')).toContain('read')
    expect(suggestForUnknownCommand('definition')).toContain('symbol')
    expect(suggestForUnknownCommand('usages')).toContain('refs')
    expect(suggestForUnknownCommand('tree')).toContain('map')
    expect(suggestForUnknownCommand('summarize')).toContain('brief')
  })

  it('matches case-insensitively — the same conceptual miss either way', () => {
    expect(suggestForUnknownCommand('Lookup')).toBe(suggestForUnknownCommand('lookup'))
  })

  // A hint for a name that isn't a recognised intent would be a guess, and a wrong hint is worse than commander's own. Silence is the correct answer outside the curated set.
  it('stays silent for a plain typo and for an empty name', () => {
    expect(suggestForUnknownCommand('symbl')).toBeNull()
    expect(suggestForUnknownCommand('zzzqqq')).toBeNull()
    expect(suggestForUnknownCommand('   ')).toBeNull()
  })

  // The module promises it never shadows a real command. `search` was an intent key until it became a registered command, and only the bundle case below noticed, by asserting commander rejected it. Scope: the hint keys on the first bare argv word (attemptedCommandName), so it can only ever name a top-level word. A name registered solely beneath a parent (`worker status`, `hook-server status`) is a different word and may carry a hint at the top level. Every top-level name and alias must stay hint-free.
  it('has no hint for any registered top-level command name or alias', () => {
    const names: string[] = []
    const collect = (entry: CommandManifestEntry): void => {
      names.push(entry.name, ...entry.aliases)
    }
    for (const entry of buildCommandManifest(buildProgram())) collect(entry)
    expect(names.length).toBeGreaterThan(30)
    expect(names.filter((name) => suggestForUnknownCommand(name) !== null)).toEqual([])
  })

  // HAND-DERIVED: `status` is registered only under `worker` and `hook-server` (src/cli.ts), so at the top level it is an unknown word and points at the health/stats/commands group; `health` and `check` share that group.
  it('points health, check and an unregistered top-level status at doctor, stats and commands', () => {
    for (const name of ['health', 'check', 'status', 'Status']) {
      const hint = suggestForUnknownCommand(name)
      expect(hint, name).toContain('`doctor`')
      expect(hint, name).toContain('`stats`')
      expect(hint, name).toContain('`commands`')
    }
  })

  it('keeps status a registered subcommand while it carries a top-level hint', () => {
    const top = buildCommandManifest(buildProgram())
    expect(top.map((entry) => entry.name)).not.toContain('status')
    const parents = top.filter((entry) => entry.subcommands.some((sub) => sub.name === 'status')).map((entry) => entry.name)
    expect(parents).toEqual(['worker', 'hook-server'])
  })
})

describe('attemptedCommandName', () => {
  it('returns the first bare token after the node binary and script', () => {
    expect(attemptedCommandName(['node', 'token-goat', 'lookup', 'foo'])).toBe('lookup')
  })

  it('skips leading flags so the hint keys on the token commander rejected', () => {
    expect(attemptedCommandName(['node', 'token-goat', '--json', 'lookup'])).toBe('lookup')
  })

  it('returns null when argv carries no command at all', () => {
    expect(attemptedCommandName(['node', 'token-goat'])).toBeNull()
    expect(attemptedCommandName(['node', 'token-goat', '--help'])).toBeNull()
  })
})

describe('unknown-command hint through the built bundle', () => {
  it('appends the intent hint without replacing commander’s own diagnostic', () => {
    const r = runBundle(['lookup', 'foo'])
    expect(r.status).toBe(1)
    // Commander's line must survive: this is additive, not a takeover of the error path.
    expect(r.stderr).toContain("unknown command 'lookup'")
    expect(r.stderr).toContain('Looking for that?')
    expect(r.stderr).toContain('semantic')
  })

  it('leaves a plain typo to commander alone', () => {
    const r = runBundle(['symbl', 'foo'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown command 'symbl'")
    expect(r.stderr).toContain('Did you mean symbol?')
    expect(r.stderr).not.toContain('Looking for that?')
  })

  it('hints an unknown top-level status through the real error path', () => {
    const r = runBundle(['status'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unknown command 'status'")
    expect(r.stderr).toContain('Looking for that?')
    expect(r.stderr).toContain('`doctor`')
  })

  // Guard: the hint must not leak onto commands that exist. A regression that emitted it for every failure -- or every invocation -- would still pass the two cases above.
  it('never fires for a registered command', () => {
    const r = runBundle(['commands', '--grep', 'semantic'])
    expect(r.status).toBe(0)
    expect(r.stdout + r.stderr).not.toContain('Looking for that?')
  })
})
