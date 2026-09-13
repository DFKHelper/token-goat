/**
 * The containment walk must not reach a file server on its way to deciding a path is out of bounds.
 *
 * `preToolPathDeclined` refuses a UNC path outright, because a pre-tool hook runs before the user
 * approves the call and a stat of `\\host\share` opens an SMB connection to an address the model
 * named -- measured at 21.0 s of connect timeout against 21 ms for a local control. That check is
 * lexical, and an adversarial review found the way around it: a symlink. Plant `C:\work\link`
 * pointing at `\\10.255.255.1\share` inside the workspace and ask to read `C:\work\link\x.txt`. The
 * spelling is entirely local, so the lexical check passes; then `isInsideRoot` walks the path
 * segment by segment to see whether a link leads out of the workspace, follows `link`, and stats
 * `//10.255.255.1/share/x.txt` -- reaching the host itself, inside the very function whose job was
 * to prevent that, while the user was still being asked.
 *
 * The verdict was never wrong. `isInsideRoot` would have answered "outside" a moment later. The
 * defect is entirely in what it touched to get there, so a test that only asks the verdict cannot
 * see it, and the previous UNC test did exactly that. This one asserts on the ACCESS: every path
 * handed to `node:fs` is recorded, and a UNC one is the failure whatever the answer.
 *
 * `readlinkSync` is deliberately not treated as an access -- it reads the link's own bytes out of
 * the local directory and never contacts the target -- which is what makes the refusal possible
 * before anything dials.
 *
 * PROVENANCE: HAND-DERIVED. The link topology is constructed here; the recorder wraps the real
 * `node:fs` and reports the arguments the code under test actually passed, not arguments read off
 * its source.
 */
import * as path from 'node:path'

import type * as Fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WORKSPACE = process.platform === 'win32' ? 'C:\\work' : '/work'
const LINK = path.join(WORKSPACE, 'link')
const SHARE = process.platform === 'win32' ? '\\\\10.255.255.1\\share' : '//10.255.255.1/share'
const DEVICE_LINK = path.join(WORKSPACE, 'device')
const DEVICE = '\\\\.\\pipe\\name'

/** A project whose own root is a share, with a link out of it onto a DIFFERENT share. */
const SHARE_ROOT = '//10.255.255.2/proj'
const SHARE_LINK = `${SHARE_ROOT}/link`

const touched = vi.hoisted(() => [] as string[])

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof Fs>()
  const record = (p: unknown): void => {
    if (typeof p === 'string') touched.push(p)
  }
  const workspaceEntry = { isSymbolicLink: () => false } as unknown as Fs.Stats
  const linkEntry = { isSymbolicLink: () => true } as unknown as Fs.Stats
  // Case- and separator-insensitively: the walk builds its candidates with forward slashes and a
  // lowercased drive letter, so a `===` against the spelling this file wrote never matches on
  // Windows and the mock silently falls through to the real filesystem.
  const same = (p: string, q: string): boolean =>
    path.resolve(p).replaceAll('\\', '/').toLowerCase() === path.resolve(q).replaceAll('\\', '/').toLowerCase()
  return {
    ...real,
    default: real,
    lstatSync: (p: unknown, ...rest: unknown[]) => {
      record(p)
      if (typeof p === 'string' && (same(p, LINK) || same(p, DEVICE_LINK) || same(p, SHARE_LINK))) return linkEntry
      if (typeof p === 'string' && same(p, WORKSPACE)) return workspaceEntry
      // Everything under either fake host answers as an ordinary directory. Falling through to the
      // real filesystem for these would have the test itself dial an unroutable address: it did,
      // and cost 2.7 s per run locally and a failure on the CI runners that resolve `//host/...`
      // as an ordinary POSIX path.
      if (typeof p === 'string' && /^[\\/]{2}10\.255\.255\./.test(p.replaceAll('\\', '/'))) return workspaceEntry
      return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
    readlinkSync: (p: unknown) => {
      // NOT recorded: reading a link's own bytes is a local operation on the directory entry.
      if (typeof p === 'string' && same(p, LINK)) return SHARE
      if (typeof p === 'string' && same(p, DEVICE_LINK)) return DEVICE
      if (typeof p === 'string' && same(p, SHARE_LINK)) return SHARE
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
    },
    statSync: (p: unknown, ...rest: unknown[]) => {
      record(p)
      return (real.statSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
    // The walk uses `lstatSync` and `readlinkSync` today, and an adversarial review pointed out
    // that recording only what it uses makes the claim above ("nothing is handed to the
    // filesystem") narrower than it reads: a later refactor onto any other entry point would dial
    // the share and still pass. Every call that takes a path and touches it is wrapped, so the
    // recorder outlives the current implementation rather than describing it.
    ...(Object.fromEntries(
      (['accessSync', 'openSync', 'readdirSync', 'opendirSync', 'readFileSync', 'existsSync'] as const).map((name) => [
        name,
        (p: unknown, ...rest: unknown[]) => {
          record(p)
          return (real[name] as (...a: unknown[]) => unknown)(p, ...rest)
        },
      ]),
    ) as Partial<typeof Fs>),
    promises: Object.fromEntries(
      Object.entries(real.promises).map(([name, fn]) => [
        name,
        typeof fn === 'function'
          ? (p: unknown, ...rest: unknown[]) => {
              record(p)
              return (fn as (...a: unknown[]) => unknown)(p, ...rest)
            }
          : fn,
      ]),
    ),
    realpathSync: Object.assign(
      (p: unknown, ...rest: unknown[]) => {
        record(p)
        return (real.realpathSync as (...a: unknown[]) => unknown)(p, ...rest)
      },
      { native: real.realpathSync.native },
    ),
  }
})

const { escapesOntoNetworkThroughLinks, isInsideRoot } = await import('../src/path_containment.js')
const { preToolPathDeclined } = await import('../src/vscode_path_gate.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')

/** Whatever separator it is spelled with, a path that starts with two of them is a share or a device. */
function isNetworkSpelling(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

beforeEach(() => {
  touched.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a symlink whose target is a share', () => {
  it('is refused, and nothing under the share is ever handed to the filesystem', () => {
    const target = path.join(LINK, 'x.txt')
    expect(isInsideRoot(target, WORKSPACE), 'a path resolving onto a share was reported as inside the workspace').toBe(false)
    const dialed = touched.filter(isNetworkSpelling)
    expect(dialed, `the containment walk reached the share before refusing it: ${dialed.join(', ')}`).toEqual([])
  })

  it('the recorder really does see the walk, so an empty record is not a silent no-op', () => {
    // Without this, a mock that broke and made isInsideRoot return false immediately would pass
    // the test above by touching nothing at all -- the exact shape of a guard that stopped guarding.
    isInsideRoot(path.join(WORKSPACE, 'ordinary', 'file.txt'), WORKSPACE)
    expect(touched.length, 'the walk touched no paths at all, so the assertion above proved nothing').toBeGreaterThan(0)
  })

  it('still allows an ordinary path inside the workspace', () => {
    expect(isInsideRoot(path.join(WORKSPACE, 'src', 'index.ts'), WORKSPACE)).toBe(true)
  })

  it('refuses a link into the device namespace instead of reading it as a relative path', () => {
    // `\\.\pipe\name` was normalized the same way a `\\?\` junction target is, which left the
    // relative `pipe/name` -- joined onto whatever the walk was standing on, so the refusal that
    // exists for device paths never saw a device and the answer was an ordinary local directory.
    expect(isInsideRoot(path.join(DEVICE_LINK, 'x'), WORKSPACE), 'a link into the device namespace resolved to a local path').toBe(false)
    expect(touched.filter(isNetworkSpelling), 'the walk touched the device namespace').toEqual([])
  })

  // Windows only, and not for want of trying: `path.resolve` collapses a POSIX `//host/x` to
  // `/host/x`, so a walk standing on a share is a state that cannot be constructed off Windows at
  // all. Asserting a boolean here on every platform is what broke the CI runners the first time.
  it.runIf(process.platform === 'win32')('leaves a walk that is already on a share free to follow a link onto another one', () => {
    // A project opened over SMB is a legitimate setup, so the refusal is conditioned on the walk
    // not already standing on a share. The verdict cannot show that -- a link out of the project
    // is "outside" either way -- so what is asserted is that the walk CONTINUED: it stat'd the
    // path under the second share, which is exactly what the refusal would have prevented.
    //
    // This also pins the fix for reading the caller's spelling instead of the resolved root. The
    // question is asked of the root the walk is standing on, so it does not matter that the second
    // share has a different host from the first.
    expect(isInsideRoot(`${SHARE_LINK}/x.txt`, SHARE_ROOT), 'a link out of the project read as inside it').toBe(false)
    const dialed = touched.filter(isNetworkSpelling).map((p) => p.replaceAll('\\', '/'))
    expect(
      dialed.some((p) => p.startsWith('//10.255.255.1/')),
      `a walk that started on a share was refused its link onto another one: ${dialed.join(', ')}`,
    ).toBe(true)
  })
})

/**
 * The same refusal, asked as the question a pre-tool gate actually asks.
 *
 * `isInsideRoot` needs a root, and the gate has one only on VS Code -- so on every other harness
 * `preToolPathDeclined` stopped after the lexical UNC test and let a link-reached share through.
 * Nothing about who gets dialled, or about the user not having approved the call yet, depends on
 * which editor is running, so the walk is asked of all of them.
 */
describe('the pre-tool gate refuses a link onto a share on a harness that supplies no workspace', () => {
  function plainEvent(target: string) {
    const toolInput = { file_path: target }
    return makeHookEvent({ eventName: 'pre_tool_use', toolName: 'Read', toolInput, sessionId: 'share-gate', raw: { tool_name: 'Read', tool_input: toolInput, cwd: WORKSPACE } })
  }

  it('declines a path whose local-looking spelling reaches a share through a link', () => {
    expect(escapesOntoNetworkThroughLinks(path.join(LINK, 'x.txt')), 'a link onto a share read as staying off the network').toBe(true)
    expect(preToolPathDeclined(plainEvent(path.join(LINK, 'x.txt')), path.join(LINK, 'x.txt')), 'the gate allowed a path that reaches a share through a link').toBe(true)
    const dialed = touched.filter(isNetworkSpelling)
    expect(dialed, `deciding to refuse reached the share: ${dialed.join(', ')}`).toEqual([])
  })

  it('calibration: an ordinary path inside the workspace is still allowed, and the walk really ran', () => {
    expect(preToolPathDeclined(plainEvent(path.join(WORKSPACE, 'src', 'index.ts')), path.join(WORKSPACE, 'src', 'index.ts'))).toBe(false)
    expect(touched.length, 'the gate answered without walking anything, so the refusal above proved nothing').toBeGreaterThan(0)
  })

  it('declines a link into the device namespace too, on the same harness', () => {
    expect(preToolPathDeclined(plainEvent(path.join(DEVICE_LINK, 'x')), path.join(DEVICE_LINK, 'x'))).toBe(true)
    expect(touched.filter(isNetworkSpelling), 'the gate touched the device namespace').toEqual([])
  })
})
