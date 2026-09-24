/** Whatever spelling of a target the confinement gate admits, the read layer's own lookup key for that target must be pinned. The gate stats the target and records a `pinKey -> dev:ino` entry so the read can prove it opened the object that passed the check. The read side looks that entry up with `activePins.get(pinKey(path.resolve(p)))` (read_commands.ts, `readFileText` / `readFileBytes` / `indexFileSyncPinned`), where `p` is the handler's resolution of the caller's RAW spec against the same `projectRoot` the gate was handed. A lookup that misses is not a refusal: it falls straight through to an unpinned `fs.readFileSync`, so the identity check and the ABSENT_PIN race guard are both switched off for the whole request while the gate still reports success. That is exactly what happened, and no confinement test could see it, because every one of them asks whether a path is admitted or refused -- which was correct throughout. `normalizePath` rewrites the WSL mount form `/mnt/c/x` to `c:/x` on every platform by design, and `c:/x` is RELATIVE on POSIX, so with a project root of `/mnt/c/workspace` the gate pinned the synthetic `/mnt/c/workspace/c:/workspace/a.txt` while the reader opened `/mnt/c/workspace/a.txt`. Every MCP read under a WSL-mounted root was unpinned. PROVENANCE: FORMAT-DERIVED. The key expression asserted below -- `pinKey(path.resolve(root, target))` -- is read off the read side's own call sites (`pinKey(path.resolve(p))` in read_commands.ts) composed with the root-relative resolution the handlers perform, not off the gate. Deriving it from the gate is what would make this test agree with the defect. */
import type * as nodeFs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { checkWithinProjectRoot } from '../src/mcp_server.js'
import { normalizePath } from '../src/paths.js'
import { pinKey } from '../src/read_commands.js'

const POSIX = process.platform !== 'win32'

/** `vi.spyOn(fs, 'statSync')` cannot work here: an ESM namespace object is not configurable, so redefining the property throws. `vi.mock` with a hoisted counter is the mechanism `tests/mcp_server_read_confinement.test.ts` already uses on this same module for the same reason. */
const statCounter = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>()
  return {
    ...actual,
    default: actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      statCounter.calls += 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.statSync as any)(...args)
    },
    // The gate takes the identity through an open handle (statThroughHandle) and falls back to a path stat only when the open fails for a reason other than absence, so a probe is either one of these or the pair; both count.
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      statCounter.calls += 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.openSync as any)(...args)
    },
  }
})

/** Roots and targets that do not exist on disk, deliberately. The gate resolves an absent path lexically (ENOENT keeps the caller's spelling, see `realPathForContainment`) and pins it as ABSENT, so the containment verdict and the pin set are both produced without touching the filesystem -- which is the only way the `/mnt/c` case can be exercised on a runner that has no `/mnt/c` and cannot create one. */
const CASES: readonly { readonly label: string; readonly root: string; readonly target: string; readonly posixOnly: boolean }[] = [
  { label: 'an absolute target under the root', root: '/srv/workspace', target: '/srv/workspace/a.txt', posixOnly: true },
  { label: 'a relative target', root: '/srv/workspace', target: 'src/a.txt', posixOnly: true },
  { label: 'a relative target with a redundant dot segment', root: '/srv/workspace', target: './src/./a.txt', posixOnly: true },
  // The regression. Both spellings are in-root, so this is an ORDINARY read that must work -- the defect was never a wrongful refusal, it was a silently unpinned success.
  { label: 'an absolute target under a WSL-mounted root', root: '/mnt/c/workspace', target: '/mnt/c/workspace/a.txt', posixOnly: true },
  { label: 'a nested absolute target under a WSL-mounted root', root: '/mnt/c/workspace', target: '/mnt/c/workspace/src/deep/a.txt', posixOnly: true },
  { label: 'a windows absolute target under the root', root: 'C:\\workspace', target: 'C:\\workspace\\a.txt', posixOnly: false },
  { label: 'a windows target spelled with forward slashes', root: 'C:\\workspace', target: 'C:/workspace/a.txt', posixOnly: false },
]

describe('the confinement gate pins the spelling the read layer will look up', () => {
  const applicable = CASES.filter((c) => (c.posixOnly ? POSIX : !POSIX))

  it('has cases to run on this platform', () => {
    // Without this, a platform filter that stopped matching would leave every assertion below running zero times and the file reporting green.
    expect(applicable.length, `no case applies on ${process.platform}, so this guard is vacuous here`).toBeGreaterThan(0)
  })

  for (const c of applicable) {
    it(`pins the reader's key for ${c.label}`, () => {
      const check = checkWithinProjectRoot(c.target, c.root)
      expect(check.inside, `${c.target} under ${c.root} must be admitted -- this case is about pinning an ordinary read, not about refusing one`).toBe(true)

      // The key the read layer will actually use.
      const readerKey = pinKey(path.resolve(c.root, c.target))
      const pinned = new Map(check.pins.map(([k, v]) => [k, v]))
      expect(
        [...pinned.keys()],
        `the read layer resolves ${c.target} to a path whose pin key is ${readerKey}, which the gate did not pin -- its lookup will miss and degrade to an unpinned read`,
      ).toContain(readerKey)
      // A key mapped to undefined would satisfy `toContain` on the key list alone.
      expect(pinned.get(readerKey), 'the reader key is present but carries no identity').toBeTruthy()
    })
  }

  it.runIf(POSIX)('is exercising the divergence it claims to, for the WSL case', () => {
    // Calibration. If `normalizePath` ever stopped rewriting the mount form, the WSL rows above would collapse into the ordinary absolute case and pass for a reason that has nothing to do with the defect. This asserts the two spellings genuinely differ.
    const root = '/mnt/c/workspace'
    const target = '/mnt/c/workspace/a.txt'
    const normalized = path.resolve(root, normalizePath(target))
    const raw = path.resolve(root, target)
    expect(normalizePath(target), 'normalizePath no longer rewrites the WSL mount form, so the WSL cases above are no longer distinct').not.toBe(target)
    expect(pinKey(normalized), 'the normalized and raw spellings now share a pin key, so the WSL cases can no longer detect a missing raw pin').not.toBe(pinKey(raw))
  })

  it('stats the target exactly once, however many spellings it validates', () => {
    // The count is the security property, not an efficiency one. Each stat between the verdict and the read is another window for the validated-absent race in `tests/mcp_server_read_confinement.test.ts`; the first draft of the two-spelling fix stat'd each spelling separately and reopened it, leaking an out-of-root secret through three of those tests on Windows -- and only on Windows, because a POSIX root does not produce two spellings for an ordinary path. This asserts the invariant on every platform.
    const root = POSIX ? '/mnt/c/workspace' : 'C:\\workspace'
    const target = POSIX ? '/mnt/c/workspace/a.txt' : 'C:\\workspace\\a.txt'
    // Calibration: this case is only worth counting if it takes the two-spelling branch at all.
    expect(path.resolve(root, normalizePath(target)), 'this case no longer produces two spellings, so it cannot detect a second stat').not.toBe(path.resolve(root, target))

    statCounter.calls = 0
    const check = checkWithinProjectRoot(target, root)
    expect(check.inside).toBe(true)
    // Calibration: a mock that stopped intercepting would report 0 and satisfy any "not more than one" phrasing, so the assertion is on the exact count.
    expect(statCounter.calls, "the gate probed the target's identity a number of times other than once -- more reopens the validated-absent race window between the check and the read, none means this counter is no longer wired to the module the gate uses").toBe(1)
  })

  it('still refuses a target that escapes the root, so wider pinning did not widen admission', () => {
    // The fix adds pins. A fix that also admitted more would pass every assertion above.
    const root = POSIX ? '/srv/workspace' : 'C:\\workspace'
    const escape = POSIX ? '/etc/passwd' : 'C:\\Windows\\win.ini'
    const check = checkWithinProjectRoot(escape, root)
    expect(check.inside, `${escape} must still be refused`).toBe(false)
    expect(check.reason).toBe('outside')
    expect(check.pins, 'a refused target must pin nothing').toEqual([])
  })
})
