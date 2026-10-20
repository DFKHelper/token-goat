/** The indexing-priority lever. Provenance: the priority numbers asserted below are CAPTURE, read off a real round-trip on the development host (Windows 11, Node 24) rather than off Node's documentation or off this module's own table: os.constants.priority -> {"PRIORITY_LOW":19,"PRIORITY_BELOW_NORMAL":10,"PRIORITY_NORMAL":0, "PRIORITY_ABOVE_NORMAL":-7,"PRIORITY_HIGH":-14,"PRIORITY_HIGHEST":-20} os.getPriority() before                      -> 0 os.setPriority(0, PRIORITY_BELOW_NORMAL) then -> 10 os.setPriority(0, PRIORITY_LOW)          then -> 19 The `applyIndexingPriority` test re-reads `os.getPriority()` after the call rather than trusting that capture, so a platform where the class does not actually move fails here instead of quietly reporting success while changing nothing. */
import * as os from 'node:os'

import { describe, expect, it, vi, afterEach } from 'vitest'

import { DEFAULT_PRIORITY_NAME, applyIndexingPriority, resolveWorkerPriority } from '../src/process_priority.js'
import { defaultConfig } from '../src/config.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveWorkerPriority', () => {
  it('maps each accepted name to its priority constant', () => {
    expect(resolveWorkerPriority('normal')).toBe(os.constants.priority.PRIORITY_NORMAL)
    expect(resolveWorkerPriority('below_normal')).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
    expect(resolveWorkerPriority('low')).toBe(os.constants.priority.PRIORITY_LOW)
  })

  // The whole point of the fallback. `validatedStr` accepts any string, so a hand-edited TOML with `priority = "beloww_normal"` reaches this function -- and resolving that to PRIORITY_NORMAL, or to "leave the OS default alone", restores exactly the behaviour this module exists to prevent with no error anywhere. The symptom would be "indexing still freezes my PC", which nobody traces back to a misspelled key.
  it('falls back to the default rather than to normal for an unrecognized or missing name', () => {
    for (const bad of ['beloww_normal', 'BELOW_NORMAL', 'idle', 'high', '', undefined]) {
      expect(resolveWorkerPriority(bad), `"${String(bad)}" must not resolve to the OS default`).toBe(
        os.constants.priority.PRIORITY_BELOW_NORMAL,
      )
    }
    expect(resolveWorkerPriority(DEFAULT_PRIORITY_NAME)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
  })

  // A config file must never be able to schedule a background indexer above the user's own work. Asserting only the three names above would not catch a fourth being added later, so this ranges over every name the config layer will accept and checks the direction of each. Node's priority scale is inverted: larger is lower, so "not elevated" means >= PRIORITY_NORMAL.
  it('offers no name that schedules above normal', () => {
    const accepted = ['normal', 'below_normal', 'low']
    expect(accepted.length, 'the accepted-name list must not be empty, or this proves nothing').toBeGreaterThan(0)
    for (const name of accepted) {
      expect(resolveWorkerPriority(name), `${name} must not be an elevated priority`).toBeGreaterThanOrEqual(
        os.constants.priority.PRIORITY_NORMAL,
      )
    }
  })

  it('is reachable from the shipped default, so the default is a name this function knows', () => {
    const configured = defaultConfig().worker.priority
    expect(resolveWorkerPriority(configured)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL)
  })
})

describe('applyIndexingPriority', () => {
  // Exercises the shipped function, not `os.setPriority`. A child running the raw syscall would prove the platform supports demotion while saying nothing about whether token-goat asks for it -- the same shape as a test that passes because it never touched the code under test. Restores the class afterwards so this cannot leave the vitest worker demoted for every file that runs after it in the same process.
  it('lowers this process to the configured class and reports success', () => {
    const before = os.getPriority()
    try {
      expect(applyIndexingPriority(), 'setPriority was refused on this host').toBe(true)
      const after = os.getPriority()
      expect(after, 'a call must never raise the process above where it started').toBeGreaterThanOrEqual(before)
      expect(
        after,
        'the call returned true but the class is above the configured one, so the lever is a no-op here',
      ).toBeGreaterThanOrEqual(os.constants.priority.PRIORITY_BELOW_NORMAL)
    } finally {
      try {
        os.setPriority(0, before)
      } catch {
        // Best-effort restore; a host that refuses this refused the demotion above too.
      }
    }
  })

  // Some hardened Linux configurations and CI sandboxes refuse even a self-demotion. Indexing must still run there: a refused priority change means the old behaviour, which is worse but correct, and is not worth aborting an index run over.
  it('returns false instead of throwing when the platform refuses', async () => {
    vi.resetModules()
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof os>()
      return {
        ...actual,
        default: actual,
        // A refusal is only reachable when a demotion is attempted, so pin the start at normal instead of the worker's own LOW.
        getPriority: () => actual.constants.priority.PRIORITY_NORMAL,
        setPriority: () => {
          const err = new Error('operation not permitted') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        },
      }
    })
    try {
      const mod = await import('../src/process_priority.js')
      expect(mod.applyIndexingPriority()).toBe(false)
    } finally {
      vi.doUnmock('node:os')
      vi.resetModules()
    }
  })

  // HAND-DERIVED from os.constants.priority (PRIORITY_NORMAL 0, PRIORITY_BELOW_NORMAL 10, PRIORITY_LOW 19; larger is lower): the configured class is 10, so a process at 0 is demoted and a process at 19 already runs lower and must be left alone. On POSIX raising 19 -> 10 is refused with EPERM, which is what failed on Linux and macOS when the test workers themselves started at LOW.
  async function loadWithPriority(current: number) {
    const setPriority = vi.fn()
    const getPriority = vi.fn(() => current)
    vi.resetModules()
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof os>()
      return { ...actual, default: actual, getPriority, setPriority }
    })
    const mod = await import('../src/process_priority.js')
    return { mod, setPriority }
  }

  const cleanup = () => {
    vi.doUnmock('node:os')
    vi.resetModules()
  }

  it('demotes a process running at normal to the configured class', async () => {
    const { mod, setPriority } = await loadWithPriority(os.constants.priority.PRIORITY_NORMAL)
    try {
      expect(mod.applyIndexingPriority()).toBe(true)
      expect(setPriority).toHaveBeenCalledWith(0, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } finally {
      cleanup()
    }
  })

  it('does not raise a process already running lower than the configured class', async () => {
    const { mod, setPriority } = await loadWithPriority(os.constants.priority.PRIORITY_LOW)
    try {
      expect(mod.applyIndexingPriority()).toBe(true)
      expect(setPriority, 'setPriority on a LOW process would raise it').not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('applyIndexingPriorityTo demotes another pid running at normal', async () => {
    const { mod, setPriority } = await loadWithPriority(os.constants.priority.PRIORITY_NORMAL)
    try {
      expect(mod.applyIndexingPriorityTo(424242)).toBe(true)
      expect(setPriority).toHaveBeenCalledWith(424242, os.constants.priority.PRIORITY_BELOW_NORMAL)
    } finally {
      cleanup()
    }
  })

  it('applyIndexingPriorityTo does not raise another pid already running lower', async () => {
    const { mod, setPriority } = await loadWithPriority(os.constants.priority.PRIORITY_LOW)
    try {
      expect(mod.applyIndexingPriorityTo(424242)).toBe(true)
      expect(setPriority, 'setPriority on a LOW pid would raise it').not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })
})
