/**
 * The containment boundary must fold case the way the filesystem does, or more conservatively --
 * never less.
 *
 * `toLowerCase()` folds by Unicode's rules. NTFS folds by its own `$UpCase` table. They disagree on
 * roughly a hundred characters, and every disagreement where JavaScript folds a pair that NTFS
 * keeps apart is a confinement bypass: the gate compares two strings, sees the root, and admits a
 * directory that is a genuinely separate place on disk. `U+212A` KELVIN SIGN is the cleanest of
 * them -- it lowercases to ASCII `k` in JavaScript, while `worK`(U+212A) and `work` are two
 * different directories on an NTFS volume.
 *
 * That was live. With `projectRoot` set to `<base>/work`, the MCP `read` tool returned the contents
 * of `<base>/wor`+U+212A+`/secret.txt`, and `grep` leaked the same file through its own walk. The
 * identity pin offered nothing: the gate pinned the file it went on to open, having concluded it
 * was in-root.
 *
 * The fold used for containment is now ASCII-only, which is strictly more conservative than either
 * table -- it can refuse a legitimate read whose root and target differ in the case of a non-ASCII
 * letter, and it cannot admit one that is outside. `foldCase` itself is deliberately untouched,
 * because `db.ts` mirrors that one into SQL as `TG_LOWER` and the two must stay byte-identical.
 *
 * PROVENANCE: CAPTURE. The directory pair is created on the real filesystem and the test refuses to
 * draw a conclusion unless that filesystem actually keeps the two apart, so the premise is read off
 * the volume under test rather than assumed from the Unicode tables.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { foldCase, foldCaseForContainment, isInsideRoot } from '../src/path_containment.js'

const { createMcpServer } = await import('../src/mcp_server.js')
const { invalidateConfigCache } = await import('../src/config.js')

/** Lowercases to ASCII `k` under Unicode; a distinct character to NTFS. */
const KELVIN = 'K'

function textOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((result as any).content as any[])[0].text as string
}

describe('the containment fold is ASCII-only', () => {
  it('folds ASCII, and leaves the characters the filesystem does not fold alone', () => {
    expect(foldCaseForContainment('WorK/File.TS')).toBe('work/file.ts')
    expect(foldCaseForContainment(`wor${KELVIN}`), 'the Kelvin sign folded to k, which is the bypass').toBe(`wor${KELVIN}`)
    // Calibration, and the reason this fold had to be a new function: the Unicode fold DOES collapse
    // it, so a containment check built on `foldCase` cannot tell the two directories apart.
    expect(foldCase(`wor${KELVIN}`), 'toLowerCase no longer folds the Kelvin sign, so this test no longer describes the defect').toBe('work')
    // And `foldCase` must stay exactly what it was: db.ts mirrors it into SQL as TG_LOWER, and a
    // change here silently stops every stored path key matching its own row.
    expect(foldCase('WorK/File.TS')).toBe('work/file.ts')
  })

  it('does not treat a Unicode-folding sibling directory as the root', () => {
    // Pure-string, so it runs everywhere: `isInsideRoot` resolves through the filesystem, but two
    // absent paths resolve to themselves.
    const base = path.join(os.tmpdir(), 'tg-fold-lexical')
    const sneaked = path.join(base, `wor${KELVIN}`, 'secret.txt')
    const root = path.join(base, 'work')
    if (process.platform === 'darwin') {
      // Not an exemption -- a different filesystem. U+212A is CANONICALLY equivalent to `K`
      // (`'K'.normalize('NFC')` is `'K'`, code point 4b), and APFS is normalization-
      // insensitive, so on macOS `worK` spelled with the Kelvin sign and `worK` spelled with a
      // plain K are not two directories that fold together -- they are one directory the OS will
      // not let you create twice. "Inside" is then the truth, and refusing would decline a real
      // path. The bypass this file is about needs two DISTINCT directories, which is what every
      // other platform gives you here.
      expect(isInsideRoot(sneaked, root), 'macOS stopped treating the Kelvin sign as the same file, so this branch is now wrong').toBe(true)
    } else {
      expect(isInsideRoot(sneaked, root)).toBe(false)
    }

    // The pair that is a live bypass on EVERY platform, macOS included, so the branch above is a
    // platform difference rather than a hole in the coverage. `I` (U+0130) and `i` followed by a
    // combining dot (U+0069 U+0307) lowercase to the identical string, yet they stay distinct under
    // NFD -- `49 307` against `69 307` -- so a normalization-insensitive filesystem still holds them
    // as two directories. The Unicode fold puts one inside the other; the ASCII fold does not.
    const dotted = 'İ'
    const decomposed = 'i̇'
    expect(foldCase(dotted), 'toLowerCase no longer collapses these, so this pair no longer describes the defect').toBe(foldCase(decomposed))
    expect(foldCaseForContainment(dotted), 'the containment fold collapsed a pair the filesystem keeps apart').not.toBe(foldCaseForContainment(decomposed))
    expect(isInsideRoot(path.join(base, dotted, 'secret.txt'), path.join(base, decomposed))).toBe(false)
    // The mirror: an ordinary ASCII case difference must still be accepted on a case-insensitive
    // volume, or this fix is just a refusal.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(isInsideRoot(path.join(base, 'Work', 'file.ts'), path.join(base, 'work'))).toBe(true)
    }
  })
})

// Confinement ships OFF by default (src/config_defaults.ts, mcp.confine_reads_to_project_root). Every assertion below is about what the gate does when it is ON, so this file turns it on explicitly; the shipped-off default is covered by tests/mcp_shipped_defaults.test.ts, which forces no env at all.
let originalConfineReads: string | undefined

beforeEach(() => {
  originalConfineReads = process.env['TOKEN_GOAT_MCP_CONFINE_READS']
  process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = '1'
  invalidateConfigCache()
})

afterEach(() => {
  if (originalConfineReads === undefined) delete process.env['TOKEN_GOAT_MCP_CONFINE_READS']
  else process.env['TOKEN_GOAT_MCP_CONFINE_READS'] = originalConfineReads
  invalidateConfigCache()
})

describe('the MCP tools refuse a directory only a Unicode fold puts inside the root', () => {
  let base: string
  let cleanup: (() => Promise<void>) | undefined

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fold-')))
    invalidateConfigCache()
  })

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup()
    cleanup = undefined
    fs.rmSync(base, { recursive: true, force: true })
    invalidateConfigCache()
  })

  it('refuses a read and a grep of a file in the fold-colliding sibling, and still serves the root itself', async () => {
    const root = path.join(base, 'work')
    const sibling = path.join(base, `wor${KELVIN}`)
    fs.mkdirSync(root, { recursive: true })
    let distinct: boolean
    try {
      fs.mkdirSync(sibling, { recursive: true })
      fs.writeFileSync(path.join(sibling, 'secret.txt'), 'CANARY_FOLD_SECRET\n')
      distinct = !fs.existsSync(path.join(root, 'secret.txt'))
    } catch {
      distinct = false
    }
    // Calibration. On a volume that really does fold the two names together -- or one that refuses
    // the character outright -- the sibling IS the root, there is nothing outside to reach, and a
    // refusal below would prove nothing about the fold.
    if (!distinct) {
      expect(true, 'this volume does not keep the two spellings apart, so the escape does not exist here').toBe(true)
      return
    }

    fs.writeFileSync(path.join(root, 'ordinary.txt'), 'IN_ROOT_CONTENT\n')

    const server = await createMcpServer()
    const client = new Client({ name: 'test-client', version: '0.0.1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    cleanup = async () => {
      await client.close()
      await server.close()
    }
    invalidateConfigCache()

    const read = await client.callTool({ name: 'read', arguments: { spec: path.join(sibling, 'secret.txt'), projectRoot: root } })
    expect(textOf(read), 'the contents of a file outside the root were returned').not.toContain('CANARY_FOLD_SECRET')
    expect(read.isError, 'the out-of-root read must be refused, not merely empty').toBe(true)
    expect(textOf(read)).toContain('is outside the project root')

    const grep = await client.callTool({ name: 'grep', arguments: { pattern: 'CANARY_FOLD_SECRET', path: [sibling], projectRoot: root } })
    expect(textOf(grep), 'grep walked into a directory outside the root').not.toContain('CANARY_FOLD_SECRET')
    expect(grep.isError).toBe(true)

    // The mirror case. Both assertions above are refusals, and a gate that refused everything would
    // satisfy them; this pins that an ordinary in-root read still works.
    const ok = await client.callTool({ name: 'read', arguments: { spec: path.join(root, 'ordinary.txt'), projectRoot: root } })
    expect(textOf(ok), 'an ordinary in-root read stopped working, so the fold is now refusing legitimate paths').toContain('IN_ROOT_CONTENT')
    expect(ok.isError).toBeFalsy()
  })
})
