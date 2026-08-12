import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { createMcpServer } from '../src/mcp_server.js'
import { invalidateConfigCache } from '../src/config.js'
import { ConfinementIdentityError, pinKey, runRead, withPinnedReads } from '../src/read_commands.js'

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
