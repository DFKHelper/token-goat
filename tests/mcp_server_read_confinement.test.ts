import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { normalizePath } from '../src/paths.js'

// A `vi.spyOn(fs, 'openSync')` cannot work here -- Node's ESM namespace bindings for a builtin
// module are not configurable, so redefining the `openSync` property throws. `vi.mock` replaces
// the module at resolution time instead (before src/read_commands.ts's own `import * as fs from
// 'node:fs'` is loaded), which sidesteps that restriction. State lives in `vi.hoisted` so the
// mock factory (itself hoisted above this file's imports) and the tests below share one object;
// `triggerPath` is null for every test except the one that opts in below, so this is a no-op
// pass-through for the rest of the file.
const openSyncFailureState = vi.hoisted(() => ({ triggerPath: null as string | null, fired: false }))
// Same hoisting requirement as openSyncFailureState above, for a swap driven off runGrep's own
// plain `fs.realpathSync(searchPath)` call (src/read_commands.ts) rather than the confinement
// gate's `fs.realpathSync.native` call (src/mcp_server.ts) that the existing `.native`-spy tests
// below intercept -- those two calls happen at different points, and this state targets the
// later one specifically so the swap lands strictly between runGrep's first (fd-based)
// verifyPinnedIdentity check and its derivation of the search boundary, not before it.
const realpathSyncSwapState = vi.hoisted(() => ({
  triggerPath: null as string | null,
  fired: false,
  onTrigger: null as (() => void) | null,
}))
// Drives the negative-pin (validated-absent) race: an in-root target that does not exist at gate
// time has no dev:ino to pin, so the FIRST filesystem call that touches it after validation is the
// earliest point a between-check-and-use swap can land -- for `read`/`section` that is
// readFileText's unpinned `fs.readFileSync` fallback, for `grep` it is `fileExists`'s
// `fs.statSync`. `statSyncSkipRemaining` exists because `checkWithinProjectRoot` (the gate itself)
// ALWAYS stats this exact path once, for every confinement-gated call regardless of which tool is
// being exercised -- that touch must be ignored, or the swap lands INSIDE gate validation itself
// (caught there, for the wrong reason: "outside the project root" rather than the read-side
// negative-pin refusal this test targets) instead of strictly after it. `fs.readFileSync` is never
// touched by the gate, so it needs no such skip.
const absentPathSwapState = vi.hoisted(() => ({
  triggerPath: null as string | null,
  fired: false,
  onTrigger: null as (() => void) | null,
  statSyncSkipRemaining: 1,
}))
// Normalize+case-fold via the app's own normalizePath (mirrors read_commands.ts's `pinKey`,
// which is `normalizePath` plus a win32 lowercase): the argument reaching fs.openSync here is
// read_commands.ts's already-normalized `resolvedPath`, not an OS-native `path.resolve()` form --
// a literal-string comparison against the latter would never match, and a hand-rolled
// backslash-flip diverges from normalizePath on a runner whose %TEMP% is pinned to its 8.3
// short form (see tests/guards/windows_path_fixture_normalization.test.ts).
function foldPathForCompare(p: string): string {
  const normalized = normalizePath(p)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const realpathSyncMock = (...args: Parameters<typeof actual.realpathSync>) => {
    const p = args[0]
    if (
      realpathSyncSwapState.triggerPath !== null &&
      !realpathSyncSwapState.fired &&
      typeof p === 'string' &&
      foldPathForCompare(p) === realpathSyncSwapState.triggerPath
    ) {
      realpathSyncSwapState.fired = true
      realpathSyncSwapState.onTrigger?.()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (actual.realpathSync as any)(...args)
  }
  // `fs.realpathSync.native` is used independently (the confinement gate's own resolution, and
  // the `.native`-spy tests elsewhere in this file) -- carry it over onto the mock so replacing
  // the top-level function doesn't silently drop that sub-property for every other test in this
  // file that relies on it.
  realpathSyncMock.native = actual.realpathSync.native
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const p = args[0]
      if (
        openSyncFailureState.triggerPath !== null &&
        !openSyncFailureState.fired &&
        typeof p === 'string' &&
        foldPathForCompare(p) === openSyncFailureState.triggerPath
      ) {
        openSyncFailureState.fired = true
        const err = new Error('EACCES: permission denied, open') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.openSync as any)(...args)
    },
    realpathSync: realpathSyncMock,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const p = args[0]
      if (
        absentPathSwapState.triggerPath !== null &&
        !absentPathSwapState.fired &&
        typeof p === 'string' &&
        foldPathForCompare(p) === absentPathSwapState.triggerPath
      ) {
        if (absentPathSwapState.statSyncSkipRemaining > 0) {
          absentPathSwapState.statSyncSkipRemaining -= 1
        } else {
          absentPathSwapState.fired = true
          absentPathSwapState.onTrigger?.()
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.statSync as any)(...args)
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const p = args[0]
      if (
        absentPathSwapState.triggerPath !== null &&
        !absentPathSwapState.fired &&
        typeof p === 'string' &&
        foldPathForCompare(p) === absentPathSwapState.triggerPath
      ) {
        absentPathSwapState.fired = true
        absentPathSwapState.onTrigger?.()
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(...args)
    },
  }
})

import { createMcpServer } from '../src/mcp_server.js'
import { invalidateConfigCache } from '../src/config.js'
import { ConfinementIdentityError, healStaleIndex, pinKey, runRead, withPinnedReads } from '../src/read_commands.js'

/** Directory-symlink counterpart to `canCreateSymlinks`: a `dir`-type symlink needs the same
 * elevated privilege on Windows without Developer Mode, but is a separate capability check from
 * a file symlink (the two link types are created and permission-checked independently). */
function canCreateDirSymlinks(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dirsymlink-probe-'))
  try {
    const target = path.join(probe, 'target-dir')
    fs.mkdirSync(target)
    fs.symlinkSync(target, path.join(probe, 'link-dir'), 'dir')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

/** Mirrors tests/mcp_server.test.ts: a real Client over the SDK's in-memory transport pair, so schema validation and request routing are exercised, not just the handler function. */
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer()
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** Capability probe, not a platform guess: symlink creation is unprivileged on POSIX, EPERM on Windows without Developer Mode, and permitted on a Windows host that has it enabled. */
function canCreateSymlinks(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-symlink-probe-'))
  try {
    fs.writeFileSync(path.join(probe, 'target'), 'x')
    fs.symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

/** Windows compares paths case-insensitively, and the gate lowercases drive letters while the test holds the OS spelling; comparing raw strings would silently never match. */
function samePath(a: string, b: string): boolean {
  const [ra, rb] = [path.resolve(a), path.resolve(b)]
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

describe('mcp read confinement', () => {
  let root: string
  let outside: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    delete process.env['TOKEN_GOAT_MCP_CONFINE_READS']
    invalidateConfigCache()
    for (const dir of [root, outside]) {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeDirs(): { inRoot: string; outsideFile: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
    const inRoot = path.join(root, 'inside.txt')
    fs.writeFileSync(inRoot, 'legitimate in-root content\n')
    const outsideFile = path.join(outside, 'secret.txt')
    fs.writeFileSync(outsideFile, 'SECRET-MARKER-DO-NOT-LEAK\n')
    return { inRoot, outsideFile }
  }

  it('still serves a legitimate in-root read', async () => {
    const { inRoot } = makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: inRoot, projectRoot: root } })
    expect(textOf(result)).toContain('legitimate in-root content')
  })

  it('refuses an absolute path outside the project root', async () => {
    const { outsideFile } = makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: outsideFile, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the project root')
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it('refuses a ../.. traversal that climbs out of the project root', async () => {
    const { outsideFile } = makeDirs()
    const traversal = path.join(root, '..', path.basename(outside), 'secret.txt')
    expect(fs.existsSync(traversal)).toBe(true)
    expect(path.resolve(traversal)).toBe(path.resolve(outsideFile))

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: traversal, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it('refuses an out-of-root member of a comma-separated multi-file spec', async () => {
    const { inRoot, outsideFile } = makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: `${inRoot},${outsideFile}`, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it('refuses out-of-root paths for section, skeleton, outline, and grep too', async () => {
    const { outsideFile } = makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    for (const call of [
      { name: 'section', arguments: { spec: `${outsideFile}::Heading`, projectRoot: root } },
      { name: 'skeleton', arguments: { file: outsideFile, projectRoot: root } },
      { name: 'outline', arguments: { file: outsideFile, projectRoot: root } },
      { name: 'grep', arguments: { pattern: 'SECRET', path: [outside] } },
    ]) {
      const result = await client.callTool(call)
      expect(textOf(result)).toContain('outside the project root')
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
    }
  })

  it('refuses an out-of-root absolute spec for brief', async () => {
    const { outsideFile } = makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'brief', arguments: { spec: `${outsideFile}::x`, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the project root')
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it('refuses brief when the second component of a comma-joined cross-file spec is out of root', async () => {
    const { inRoot, outsideFile } = makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'brief', arguments: { spec: `${inRoot}::a,${outsideFile}::b`, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the project root')
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it('refuses a grep path containing a literal comma that resolves outside the root', async () => {
    // The comma-stripped form of this directory's own name equals `root`'s basename exactly, so a
    // validator that strips commas before checking (but greps the un-stripped path) would wrongly
    // treat this outside directory as in-root -- the validate-one-string/use-another bug under test.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const commaName = root.replace(/tg-mcp-root-/, 'tg-mcp-r,oot-')
    fs.mkdirSync(commaName)
    outside = commaName
    const outsideFile = path.join(commaName, 'secret.txt')
    fs.writeFileSync(outsideFile, 'SECRET-MARKER-DO-NOT-LEAK\n')
    expect(commaName.replace(/,/g, '')).toBe(root)

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'SECRET', path: [outsideFile], projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the project root')
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it.runIf(process.platform === 'win32')('refuses a Windows extended-length device path outside the root', async () => {
    const { outsideFile } = makeDirs()
    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: `\\\\?\\${path.resolve(outsideFile)}`, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it.runIf(process.platform !== 'win32')('refuses a path that normalises inside the root but symlinks out of it', async () => {
    const { outsideFile } = makeDirs()
    const link = path.join(root, 'link.txt')
    fs.symlinkSync(outsideFile, link)

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: link, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  it('allows the out-of-root read when the opt-out config is set', async () => {
    const { outsideFile } = makeDirs()
    process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = '0'
    invalidateConfigCache()

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: outsideFile, projectRoot: root } })
    expect(textOf(result)).toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  // Regression for the trimmed-vs-untrimmed confinement bypass: the gate used to validate
  // `specFilePart(part).trim()` but the handler forwarded the untrimmed `part` (or the untrimmed
  // `spec`/`file` argument entirely) to its `run*` call, so a spec whose trailing whitespace made
  // an out-of-root symlink/junction *look* like a harmless nonexistent in-root path at validation
  // time still resolved through that symlink at read time. Platform-gated the same way and for the
  // same reason (symlink creation needs elevated privilege on Windows CI) as the existing
  // "normalises inside the root but symlinks out of it" test above.
  it.runIf(process.platform !== 'win32')(
    'refuses a file whose trailing-whitespace name resolves through a symlink to outside the root',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const secret = path.join(outside, 'secret.txt')
      fs.writeFileSync(secret, 'SECRET-MARKER-DO-NOT-LEAK\n')
      // The trailing space is part of the *link's own name*, not appended to the spec string, so
      // this is the exact scenario the ticket describes: a workspace containing both a clean name
      // and a distinct, whitespace-suffixed name that happens to symlink outside the root.
      const link = path.join(root, 'inside.txt ')
      fs.symlinkSync(secret, link, 'file')

      const { client, close } = await connectedClient()
      cleanup = close

      const result = await client.callTool({ name: 'read', arguments: { spec: link, projectRoot: root } })
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('outside the project root')
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
    },
  )

  // Deterministic, platform-independent companion to the symlink test above: proves the checked
  // value and the forwarded value are byte-identical without needing a real filesystem escape.
  // A spec with trailing whitespace appended is still outside the root whether or not it is
  // trimmed, so this can't tell apart "refused" from "refused" -- what it tells apart is WHICH
  // string got refused. Pre-fix, the gate trimmed before both validating and reporting, so the
  // refusal named the trimmed path; post-fix it reports (and, in the handlers, forwards) the exact
  // untrimmed spec, matching what `specFilePart`/`parseReadSpec` in the execution layer see.
  it('confinement refusal names the exact untrimmed spec forwarded to the read, not a trimmed variant', async () => {
    const { outsideFile } = makeDirs()
    const spec = `${outsideFile} `

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`"${spec}" is outside the project root`)
  })

  it('still resolves a legitimate file::symbol spec', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'lib.ts')
    fs.writeFileSync(file, 'export function greet(): string {\n  return "hi"\n}\n')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: `${file}::greet`, projectRoot: root } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('return "hi"')
  })

  it('still resolves a legitimate file@N-M range spec', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'lib.ts')
    fs.writeFileSync(file, 'line one\nline two\nline three\n')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: `${file}@1-2`, projectRoot: root } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('line one')
    expect(textOf(result)).toContain('line two')
    expect(textOf(result)).not.toContain('line three')
  })

  it('still resolves a legitimate comma-separated cross-file multi-spec', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const a = path.join(root, 'a.ts')
    const b = path.join(root, 'b.ts')
    fs.writeFileSync(a, 'export function alphaFn(): string {\n  return "alpha"\n}\n')
    fs.writeFileSync(b, 'export function betaFn(): string {\n  return "beta"\n}\n')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: `${a}::alphaFn,${b}::betaFn`, projectRoot: root } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('return "alpha"')
    expect(textOf(result)).toContain('return "beta"')
  })

  // TEST A -- the check-vs-use boundary itself, deterministic and platform-independent.
  //
  // Every confinement test above proves a path was VALIDATED correctly. None of them proves the
  // read opened the object that was validated, because they never separate the two moments: the
  // gate resolves a path and the handler opens that path some time later, and pre-fix nothing at
  // all connected the two. Here the identity captured at check time deliberately disagrees with
  // what is on disk, which is exactly what a between-check-and-open swap looks like from the read
  // side, and the read must refuse rather than serve the replacement.
  it('refuses a read whose file identity does not match what confinement validated', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'swapped.txt')
    fs.writeFileSync(file, 'SECRET-MARKER-DO-NOT-LEAK\n')

    // A pin no real file can satisfy: dev/ino are unsigned, so a negative device number cannot be the identity of anything actually openable.
    const pins = new Map<string, string>([[pinKey(file), '-1:-1']])

    expect(() => withPinnedReads(pins, () => runRead({ spec: file, projectRoot: root }))).toThrow(ConfinementIdentityError)
    expect(() => withPinnedReads(pins, () => runRead({ spec: file, projectRoot: root }))).toThrow(/changed identity between validation and read/)
  })

  // Companion to Test A: the refusal must reach the MCP client as a confinement decision, not
  // escape as an unhandled protocol error, and must not carry the file's contents with it.
  it('an identity mismatch surfaces as a confinement refusal, not an unhandled error', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'swapped.txt')
    fs.writeFileSync(file, 'SECRET-MARKER-DO-NOT-LEAK\n')
    const pins = new Map<string, string>([[pinKey(file), '-1:-1']])

    let thrown: unknown
    try {
      withPinnedReads(pins, () => runRead({ spec: file, projectRoot: root }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ConfinementIdentityError)
    expect((thrown as Error).message).toContain('the read was not performed')
    expect((thrown as Error).message).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  // A pinned read that DOES match must still return the file verbatim -- the non-firing guard for
  // the identity check, over a non-empty pin map, so a rule that refused everything would fail here.
  it('non-firing: a matching identity pin serves the in-root read unchanged', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'ok.txt')
    fs.writeFileSync(file, 'legitimate in-root content\n')
    const st = fs.statSync(file, { bigint: true })
    const pins = new Map<string, string>([[pinKey(file), `${st.dev}:${st.ino}`]])
    expect(pins.size).toBeGreaterThan(0)

    for (const [key] of pins) {
      expect(key).not.toBe('')
    }
    const result = withPinnedReads(pins, () => runRead({ spec: file, projectRoot: root }))
    expect(result.code).toBe(0)
    expect(result.text).toContain('legitimate in-root content')
  })

  // A pinned read must still serve an ordinary in-root symlink. This is the guard against
  // "hardening" the pinned open with O_NOFOLLOW: that flag makes this exact read fail ELOOP on
  // Linux and macOS, which readFileText reports as a plain "could not read" -- a silent denial of
  // a legitimate file, invisible on Windows where the flag does not exist. The identity check is
  // what closes the window; the open flags are not, and must not start refusing valid targets.
  it.runIf(canCreateSymlinks())('non-firing: a pinned read still follows a legitimate in-root symlink', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const target = path.join(root, 'target.txt')
    const link = path.join(root, 'link.txt')
    fs.writeFileSync(target, 'legitimate in-root content\n')
    fs.symlinkSync(target, link, 'file')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: link, projectRoot: root } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('legitimate in-root content')
  })

  // TEST B -- the real escape, end to end: an in-root path repointed at an out-of-root file after
  // the gate has resolved it. Gated on the ability to CREATE a symlink rather than on the platform
  // name, because that is the actual requirement (unprivileged Windows refuses with EPERM, but a
  // Windows host with Developer Mode on runs it fine) -- a platform gate would skip a test this
  // machine can prove, and a skipped test proves nothing.
  //
  // The swap is driven from a vitest spy on the gate's own path resolution, NOT a racing loop:
  // that places the replacement in precisely the window between check and open, deterministically,
  // with no flake surface. Pre-fix this exact seam returned the out-of-root file's contents.
  it.runIf(canCreateSymlinks())('refuses a read whose in-root path is repointed outside the root after validation', async () => {
    const { inRoot, outsideFile } = makeDirs()

    let swapped = false
    const realNative = fs.realpathSync.native.bind(fs.realpathSync)
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
      const result = realNative(p as string)
      if (!swapped && samePath(String(p), inRoot)) {
        swapped = true
        fs.rmSync(inRoot)
        fs.symlinkSync(outsideFile, inRoot, 'file')
      }
      return result
    }) as unknown as typeof fs.realpathSync.native)

    const { client, close } = await connectedClient()
    cleanup = async () => {
      spy.mockRestore()
      await close()
    }

    const result = await client.callTool({ name: 'read', arguments: { spec: inRoot, projectRoot: root } })
    expect(swapped).toBe(true)
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
    expect(result.isError).toBe(true)
  })

  // Section-read counterpart to TEST B above: `section`'s handler goes through the same
  // confinement gate as `read`, but src/section_reader.ts's `readTextForSections` used to call
  // `readFileSync` directly, never consulting `activePins` at all -- so this exact swap-timing
  // technique returned the out-of-root file's contents through `section` even though the
  // identical technique against `read` (TEST B above) was already refused. Fixed by threading the
  // pin-aware `readFileText` through `readSection`/`findContainingSection`/`listSections` (see
  // src/section_reader.ts and src/read_commands.ts's `runSection`).
  it.runIf(canCreateSymlinks())(
    'refuses a section read whose in-root path is repointed outside the root after validation',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const inRoot = path.join(root, 'inside.md')
      fs.writeFileSync(inRoot, '## Heading\nlegitimate in-root content\n')
      const outsideFile = path.join(outside, 'secret.md')
      fs.writeFileSync(outsideFile, '## Heading\nSECRET-MARKER-DO-NOT-LEAK\n')

      let swapped = false
      const realNative = fs.realpathSync.native.bind(fs.realpathSync)
      const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
        const result = realNative(p as string)
        if (!swapped && samePath(String(p), inRoot)) {
          swapped = true
          fs.rmSync(inRoot)
          fs.symlinkSync(outsideFile, inRoot, 'file')
        }
        return result
      }) as unknown as typeof fs.realpathSync.native)

      const { client, close } = await connectedClient()
      cleanup = async () => {
        spy.mockRestore()
        await close()
      }

      const result = await client.callTool({ name: 'section', arguments: { spec: `${inRoot}::Heading`, projectRoot: root } })
      expect(swapped).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )
})

describe('mcp numeric param bounds', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
  })

  it('rejects over-limit numeric params at the schema layer', async () => {
    const { client, close } = await connectedClient()
    cleanup = close

    for (const call of [
      { name: 'symbol', arguments: { name: 'x', limit: 1_000_000 } },
      { name: 'semantic', arguments: { query: 'x', limit: 1_000_000 } },
      { name: 'refs', arguments: { spec: 'x', limit: 1_000_000 } },
      { name: 'refs', arguments: { spec: 'x', top: 1_000_000 } },
      { name: 'brief', arguments: { spec: 'a.ts::x', limit: 1_000_000 } },
      { name: 'brief', arguments: { spec: 'a.ts::x', context: 100_000 } },
      { name: 'grep', arguments: { pattern: 'x', maxLines: 1_000_000 } },
      { name: 'grep', arguments: { pattern: 'x', context: 100_000 } },
    ]) {
      const result = await client.callTool(call)
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('too_big')
    }
  })
})

// Regression for the mid-request-reindex bypass: `read`/`skeleton`/`outline`'s `--force-refresh`
// path (and the same-shaped self-heal path healStaleIndex takes on a stale index) used to call
// `indexFileSync` directly on the resolved path -- a second, independent `fs.readFileSync` that
// never consulted the confinement gate's identity pin. A path swapped between gate validation and
// that reindex was never caught, unlike every other read surface in this file. `indexFileSyncPinned`
// (src/read_commands.ts) closes this by verifying the pin BEFORE any bytes are read and handing
// the already-verified bytes straight into `indexFileSync`, so the reindex can no longer reopen a
// swapped path on its own.
describe('mcp read confinement -- force-refresh / self-heal reindex path', () => {
  let root: string
  let outside: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    for (const dir of [root, outside]) {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Deterministic companion, same shape as "Test A" above: a pin no real file can satisfy,
  // routed through the force-refresh reindex path instead of the plain read path. Pre-fix, this
  // never throws at all -- indexFileSync reopens the path directly and the pin is never consulted.
  it('a mismatched identity pin refuses a force-refresh reindex, not just a plain read', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'lib.ts')
    fs.writeFileSync(file, 'export function greet(): string {\n  return "hi"\n}\n')
    const pins = new Map<string, string>([[pinKey(file), '-1:-1']])

    expect(() =>
      withPinnedReads(pins, () => runRead({ spec: `${file}::greet`, projectRoot: root, forceRefresh: true })),
    ).toThrow(ConfinementIdentityError)
    expect(() =>
      withPinnedReads(pins, () => runRead({ spec: `${file}::greet`, projectRoot: root, forceRefresh: true })),
    ).toThrow(/changed identity between validation and read/)
  })

  // Real end-to-end escape: an in-root path repointed at an out-of-root file, timed via a spy on
  // the gate's own realpath resolution (same technique as "Test B" above), but this time the read
  // it drives is `read --force-refresh`, which reaches indexFileSyncPinned instead of readFileText.
  it.runIf(canCreateSymlinks())(
    'refuses a force-refresh reindex whose in-root path is repointed outside the root after validation',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const inRoot = path.join(root, 'inside.ts')
      fs.writeFileSync(inRoot, 'export function greet(): string {\n  return "safe"\n}\n')
      const outsideFile = path.join(outside, 'secret.ts')
      fs.writeFileSync(outsideFile, 'export function greet(): string {\n  return "SECRET-MARKER-DO-NOT-LEAK"\n}\n')

      let swapped = false
      const realNative = fs.realpathSync.native.bind(fs.realpathSync)
      const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
        const result = realNative(p as string)
        if (!swapped && samePath(String(p), inRoot)) {
          swapped = true
          fs.rmSync(inRoot)
          fs.symlinkSync(outsideFile, inRoot, 'file')
        }
        return result
      }) as unknown as typeof fs.realpathSync.native)

      const { client, close } = await connectedClient()
      cleanup = async () => {
        spy.mockRestore()
        await close()
      }

      const result = await client.callTool({
        name: 'read',
        arguments: { spec: `${inRoot}::greet`, projectRoot: root, forceRefresh: true },
      })
      expect(swapped).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )
})

// Regression for grep's two independent confinement gaps: (1) `runGrep` read explicitly-requested
// files with a raw `fs.readFileSync` that never consulted the confinement gate's identity pin, and
// (2) its recursive directory walk used `fs.statSync` (which follows symlinks) with no boundary
// check at all, so an in-root directory symlink pointing outside the root was silently descended
// into and searched. These are fixed independently in src/read_commands.ts's runGrep: searchFile
// now goes through the pin-aware readFileText, and searchDir now lstat's every entry and only
// follows a symlink (file or directory) once its realpath is proven to still resolve inside the
// search root.
describe('mcp read confinement -- grep pin and symlink-directory checks', () => {
  let root: string
  let outside: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    for (const dir of [root, outside]) {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Gap (1): an explicitly-requested grep target repointed outside the root after the gate
  // validated it. Same swap-timing technique as "Test B" above.
  it.runIf(canCreateSymlinks())(
    'refuses a grep of an explicit path repointed outside the root after validation',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const inRoot = path.join(root, 'inside.txt')
      fs.writeFileSync(inRoot, 'FINDME legitimate in-root content\n')
      const outsideFile = path.join(outside, 'secret.txt')
      fs.writeFileSync(outsideFile, 'FINDME SECRET-MARKER-DO-NOT-LEAK\n')

      let swapped = false
      const realNative = fs.realpathSync.native.bind(fs.realpathSync)
      const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
        const result = realNative(p as string)
        if (!swapped && samePath(String(p), inRoot)) {
          swapped = true
          fs.rmSync(inRoot)
          fs.symlinkSync(outsideFile, inRoot, 'file')
        }
        return result
      }) as unknown as typeof fs.realpathSync.native)

      const { client, close } = await connectedClient()
      cleanup = async () => {
        spy.mockRestore()
        await close()
      }

      const result = await client.callTool({
        name: 'grep',
        arguments: { pattern: 'FINDME', path: [inRoot], projectRoot: root },
      })
      expect(swapped).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )

  // Gap (2): a real in-root directory symlink pointing at an out-of-root directory. A recursive
  // grep of the root must not descend into it, even though the top-level root itself validated
  // fine (the gate only checks the top-level target; nothing re-validated this nested entry).
  it.runIf(canCreateDirSymlinks())('a recursive grep does not follow an in-root directory symlink out of the root', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
    fs.writeFileSync(path.join(root, 'legit.txt'), 'FINDME legitimate in-root content\n')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'FINDME SECRET-MARKER-DO-NOT-LEAK\n')
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'FINDME', path: [root], projectRoot: root } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('legitimate in-root content')
    expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
  })

  // Non-firing companion: an ordinary in-root directory symlink (pointing at ANOTHER in-root
  // directory, not escaping anywhere) must still be followed and searched -- the boundary check
  // must not turn into a blanket refusal to follow any symlink at all.
  it.runIf(canCreateDirSymlinks())('non-firing: a recursive grep still follows a legitimate in-root directory symlink', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const real = path.join(root, 'real-subdir')
    fs.mkdirSync(real)
    fs.writeFileSync(path.join(real, 'target.txt'), 'FINDME reachable via in-root symlink\n')
    fs.symlinkSync(real, path.join(root, 'alias'), 'dir')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'FINDME', path: [root], projectRoot: root } })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('reachable via in-root symlink')
  })

  // Gap (3): the TOP-LEVEL search directory itself repointed outside the root after the gate
  // validated it (as opposed to a nested entry discovered by searchDir's own recursion, which
  // gap (2) above already covers). confineTargets pins the directory it just validated, but
  // runGrep's top-level loop used to ignore that pin entirely and derive `boundaryReal` from a
  // fresh, unverified fs.realpathSync of the (now swapped) path -- so a directory replaced in the
  // window between validation and this call had its search boundary silently become the
  // attacker-controlled directory, and the recursive walk returned its contents. Same swap-timing
  // technique as "Test B" above, but targeting the explicit grep `path` directory rather than a
  // file.
  it.runIf(canCreateDirSymlinks())(
    'refuses a grep whose top-level search directory is repointed outside the root after validation',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const inRootDir = path.join(root, 'subdir')
      fs.mkdirSync(inRootDir)
      fs.writeFileSync(path.join(inRootDir, 'legit.txt'), 'FINDME legitimate in-root content\n')
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'FINDME SECRET-MARKER-DO-NOT-LEAK\n')

      let swapped = false
      const realNative = fs.realpathSync.native.bind(fs.realpathSync)
      const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => {
        const result = realNative(p as string)
        if (!swapped && samePath(String(p), inRootDir)) {
          swapped = true
          fs.rmSync(inRootDir, { recursive: true, force: true })
          fs.symlinkSync(outside, inRootDir, 'dir')
        }
        return result
      }) as unknown as typeof fs.realpathSync.native)

      const { client, close } = await connectedClient()
      cleanup = async () => {
        spy.mockRestore()
        await close()
      }

      const result = await client.callTool({
        name: 'grep',
        arguments: { pattern: 'FINDME', path: [inRootDir], projectRoot: root },
      })
      expect(swapped).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )

  // Gap (4), narrower than gap (3) above: gap (3) swaps during the confinement gate's OWN
  // `fs.realpathSync.native` resolution, which lands before `verifyPinnedIdentity`'s fd-based
  // check ever runs -- that check alone already catches it, so gap (3) never actually exercised
  // the second window runGrep has. This test swaps during runGrep's own plain
  // `fs.realpathSync(searchPath)` call instead (the one that derives `boundaryReal`), which runs
  // strictly AFTER the first `verifyPinnedIdentity` check has already passed. Pre-fix, that first
  // check was the only one: `boundaryReal` was then derived from the now-swapped path with no
  // re-verification, so the walk used the attacker's directory as its own boundary and every
  // entry beneath it passed `withinRealpathBoundary` trivially. Post-fix, the second
  // `verifyPinnedIdentity` call added immediately after `boundaryReal` is derived (see
  // src/read_commands.ts's runGrep) catches the swap in this narrower window and refuses instead.
  it.runIf(canCreateDirSymlinks())(
    'refuses a grep whose top-level search directory is repointed after the pin check but during boundary resolution',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const inRootDir = path.join(root, 'subdir')
      fs.mkdirSync(inRootDir)
      fs.writeFileSync(path.join(inRootDir, 'legit.txt'), 'FINDME legitimate in-root content\n')
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'FINDME SECRET-MARKER-DO-NOT-LEAK\n')

      realpathSyncSwapState.triggerPath = foldPathForCompare(inRootDir)
      realpathSyncSwapState.fired = false
      realpathSyncSwapState.onTrigger = () => {
        fs.rmSync(inRootDir, { recursive: true, force: true })
        fs.symlinkSync(outside, inRootDir, 'dir')
      }

      const { client, close } = await connectedClient()
      cleanup = async () => {
        realpathSyncSwapState.triggerPath = null
        realpathSyncSwapState.fired = false
        realpathSyncSwapState.onTrigger = null
        await close()
      }

      const result = await client.callTool({
        name: 'grep',
        arguments: { pattern: 'FINDME', path: [inRootDir], projectRoot: root },
      })
      expect(realpathSyncSwapState.fired).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )
})

// Regression for two follow-on defects found in the pinned-reindex/self-heal machinery above:
// (B) indexFileSyncPinned fell back to an unpinned indexFileSync read when the initial pinned
// open failed for any reason other than ConfinementIdentityError, including a non-ENOENT open
// failure -- letting a caller who can make the first open fail (then swap the path) get an
// unverified raw read served anyway. (C) healStaleIndex's best-effort catch blocks swallowed
// ConfinementIdentityError along with ordinary parse/I/O errors, converting a detected
// between-check-and-use swap into silent best-effort behavior instead of a refusal.
describe('mcp read confinement -- pinned reindex failure handling', () => {
  let root: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true })
  })

  // Finding B: a genuinely matching pin, but the pinned open itself fails with a non-ENOENT
  // error (e.g. a transient permission failure). Pre-fix, indexFileSyncPinned treated this the
  // same as "file deleted since validation" and fell through to a raw, unpinned indexFileSync --
  // which reads whatever is at the path NOW, with no identity verification at all -- instead of
  // refusing. Post-fix, only ENOENT gets that clean fallback; any other open failure is a
  // confinement refusal.
  it('a non-ENOENT pinned-open failure during force-refresh refuses instead of falling back to an unpinned read', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'lib.ts')
    fs.writeFileSync(file, 'export function greet(): string {\n  return "hi"\n}\n')
    const st = fs.statSync(file, { bigint: true })
    const pins = new Map<string, string>([[pinKey(file), `${st.dev}:${st.ino}`]])

    openSyncFailureState.triggerPath = foldPathForCompare(path.resolve(file))
    openSyncFailureState.fired = false
    try {
      expect(() =>
        withPinnedReads(pins, () => runRead({ spec: `${file}::greet`, projectRoot: root, forceRefresh: true })),
      ).toThrow(ConfinementIdentityError)
      expect(openSyncFailureState.fired).toBe(true)
    } finally {
      openSyncFailureState.triggerPath = null
      openSyncFailureState.fired = false
    }
  })

  // Non-firing companion: a file genuinely deleted since validation (ENOENT) must still heal
  // cleanly rather than start refusing every legitimate "file disappeared" case.
  it('non-firing: an ENOENT pinned-open failure during force-refresh still returns cleanly', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'gone.ts')
    fs.writeFileSync(file, 'export function greet(): string {\n  return "hi"\n}\n')
    const st = fs.statSync(file, { bigint: true })
    const pins = new Map<string, string>([[pinKey(file), `${st.dev}:${st.ino}`]])
    fs.rmSync(file)

    expect(() =>
      withPinnedReads(pins, () => runRead({ spec: `${file}::greet`, projectRoot: root, forceRefresh: true })),
    ).not.toThrow(ConfinementIdentityError)
  })

  // Finding C: a genuine identity mismatch (not a fallback -- readPinnedBytes itself throws
  // ConfinementIdentityError from its fstat check) surfacing through healStaleIndex's self-heal
  // path, on a file made stale relative to its indexed sha. Pre-fix, healStaleIndex's `catch {}`
  // swallowed this along with ordinary parse/I/O errors and returned normally; the pinning
  // contract requires a detected replacement to be refused, so this must propagate instead.
  it('healStaleIndex rethrows a confinement identity mismatch instead of swallowing it', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const file = path.join(root, 'lib.ts')
    fs.writeFileSync(file, 'export function greet(): string {\n  return "hi"\n}\n')
    // Index it once for real (unpinned), so a `files` row with a sha exists to go stale against.
    withPinnedReads(null, () => runRead({ spec: file, projectRoot: root }))
    // Change the on-disk content without updating the indexed sha, so healStaleIndex sees it as
    // stale and attempts a pinned reindex.
    fs.writeFileSync(file, 'export function greet(): string {\n  return "changed"\n}\n')
    // A pin no real file can satisfy: dev/ino are unsigned, so a negative device number cannot be
    // the identity of anything actually openable.
    const pins = new Map<string, string>([[pinKey(file), '-1:-1']])

    expect(() => withPinnedReads(pins, () => healStaleIndex(file))).toThrow(ConfinementIdentityError)
    expect(() => withPinnedReads(pins, () => healStaleIndex(file))).toThrow(/changed identity between validation and read/)
  })
})

// Regression for the missing NEGATIVE pin: an in-root target that does not exist YET at gate-
// validation time has no dev:ino for checkWithinProjectRoot to stat, so pre-fix `confineTargets`
// (src/mcp_server.ts) simply skipped recording anything for it -- "no pin for this path" then meant
// BOTH "confinement is off" and "confined but genuinely unpinnable", and every pin-aware read helper
// (readFileText, readFileBytes, indexFileSyncPinned, runGrep's own fileExists/directory checks)
// read a missing map entry as "not confined" and fell through to a raw, unverified read. An attacker
// who names an in-root path that does not exist yet, waits for the gate to validate it as
// absent-but-in-root, then creates an out-of-root symlink there before the actual read runs, got the
// swapped file's contents served straight through. Fixed by recording ABSENT_PIN (read_commands.ts)
// for every validated-absent target, so the read helpers can tell "unconfined" and "confined but
// unpinnable" apart and refuse a create-after-validate swap (verifyStillAbsent) instead of silently
// serving it. The swap is driven off `absentPathSwapState`, which fires on whichever syscall first
// touches the not-yet-existing path after the gate has validated it -- readFileText's own
// `fs.readFileSync` fallback for `read`/`section`, or `fileExists`'s `fs.statSync` for `grep` -- the
// same deterministic swap-timing technique the "Test B" cases above use, just landing on a target
// that was absent (not merely present-and-different) at validation time.
describe('mcp read confinement -- negative pin (validated-absent race)', () => {
  let root: string
  let outside: string
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    absentPathSwapState.triggerPath = null
    absentPathSwapState.fired = false
    absentPathSwapState.onTrigger = null
    absentPathSwapState.statSyncSkipRemaining = 1
    for (const dir of [root, outside]) {
      if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(canCreateSymlinks())(
    'refuses a read of an in-root path validated as absent, then swapped to an out-of-root symlink before the read',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const notYet = path.join(root, 'not-yet-created.txt')
      const outsideFile = path.join(outside, 'secret.txt')
      fs.writeFileSync(outsideFile, 'SECRET-MARKER-DO-NOT-LEAK\n')
      expect(fs.existsSync(notYet)).toBe(false)

      absentPathSwapState.triggerPath = foldPathForCompare(notYet)
      absentPathSwapState.fired = false
      absentPathSwapState.statSyncSkipRemaining = 1
      absentPathSwapState.onTrigger = () => {
        fs.symlinkSync(outsideFile, notYet, 'file')
      }

      const { client, close } = await connectedClient()
      cleanup = close

      const result = await client.callTool({ name: 'read', arguments: { spec: notYet, projectRoot: root } })
      expect(absentPathSwapState.fired).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )

  it.runIf(canCreateSymlinks())(
    'refuses a section read of an in-root path validated as absent, then swapped to an out-of-root symlink before the read',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const notYet = path.join(root, 'not-yet-created.md')
      const outsideFile = path.join(outside, 'secret.md')
      fs.writeFileSync(outsideFile, '## Heading\nSECRET-MARKER-DO-NOT-LEAK\n')
      expect(fs.existsSync(notYet)).toBe(false)

      absentPathSwapState.triggerPath = foldPathForCompare(notYet)
      absentPathSwapState.fired = false
      absentPathSwapState.statSyncSkipRemaining = 1
      absentPathSwapState.onTrigger = () => {
        fs.symlinkSync(outsideFile, notYet, 'file')
      }

      const { client, close } = await connectedClient()
      cleanup = close

      const result = await client.callTool({ name: 'section', arguments: { spec: `${notYet}::Heading`, projectRoot: root } })
      expect(absentPathSwapState.fired).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )

  it.runIf(canCreateSymlinks())(
    'refuses a grep of an explicit in-root path validated as absent, then swapped to an out-of-root symlink before the search',
    async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-outside-'))
      const notYet = path.join(root, 'not-yet-created.txt')
      const outsideFile = path.join(outside, 'secret.txt')
      fs.writeFileSync(outsideFile, 'FINDME SECRET-MARKER-DO-NOT-LEAK\n')
      expect(fs.existsSync(notYet)).toBe(false)

      absentPathSwapState.triggerPath = foldPathForCompare(notYet)
      absentPathSwapState.fired = false
      absentPathSwapState.statSyncSkipRemaining = 1
      absentPathSwapState.onTrigger = () => {
        fs.symlinkSync(outsideFile, notYet, 'file')
      }

      const { client, close } = await connectedClient()
      cleanup = close

      const result = await client.callTool({ name: 'grep', arguments: { pattern: 'FINDME', path: [notYet], projectRoot: root } })
      expect(absentPathSwapState.fired).toBe(true)
      expect(textOf(result)).not.toContain('SECRET-MARKER-DO-NOT-LEAK')
      expect(result.isError).toBe(true)
    },
  )

  // Non-firing companion, read + grep: a genuinely missing in-root path (nothing is ever created at
  // it) must still report the ordinary missing-file result, not a confinement refusal -- proves the
  // fix cannot pass by turning every absent file into a refusal, only a create-after-validate swap.
  it('non-firing: a genuinely missing in-root read still reports the ordinary missing-file result, not a refusal', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const notYet = path.join(root, 'still-missing.txt')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'read', arguments: { spec: notYet, projectRoot: root } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).not.toContain('outside the project root')
    expect(textOf(result)).not.toContain('validated as absent')
    expect(textOf(result)).not.toContain('changed identity')
  })

  it('non-firing: a genuinely missing grep target still reports "Path not found", not a refusal', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-root-'))
    const notYet = path.join(root, 'still-missing.txt')

    const { client, close } = await connectedClient()
    cleanup = close

    const result = await client.callTool({ name: 'grep', arguments: { pattern: 'x', path: [notYet], projectRoot: root } })
    expect(textOf(result)).toContain(`Path not found: ${notYet}`)
    expect(textOf(result)).not.toContain('outside the project root')
    expect(textOf(result)).not.toContain('validated as absent')
  })
})
