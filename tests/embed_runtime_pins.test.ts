/** The bundled WebAssembly runtime is three artifacts that must come from one onnxruntime-web release: the JavaScript esbuild inlines from the devDependency, the glue module the build copies beside the bundle, and the binary fetched on first use from the npm registry's tarball. Nothing at run time can tell a mismatched pair apart until inference misbehaves, so the pins in src/embed_runtime.ts are checked here against every place those artifacts come from: package.json, the lockfile, the installed package, and the built dist/. The rest drives the two pieces of the fetch that a real download cannot be asked to exercise: the tar reader, against archives built here in each of the header forms npm tarballs use, and ensureWasmBinary's refusals, with `fetch` substituted and the data directory isolated. The success path of a real download is exercised by `npm run model:warm`, which CI runs before the suite. */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { ORT_WEB_GLUE, ORT_WEB_TARBALL, ORT_WEB_VERSION, ORT_WEB_WASM, ensureWasmBinary, extractTarMember, wasmBinaryPresent, wasmDir } from '../src/embed_runtime.js'
import { downloadPinned, type PinnedFile } from '../src/pinned_file.js'
import { clearModuleCaches } from '../src/reset.js'

import { ROOT } from './helpers/bundle.js'

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const INSTALLED_DIST = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')

describe('the onnxruntime-web pins', () => {
  it('name the exact devDependency version, so the bundled JavaScript and the fetched binary are one release', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> }
    // Exact, not a range: a range lets `npm install` move the bundled JavaScript to a release the pinned binary was not built for.
    expect(pkg.devDependencies?.['onnxruntime-web']).toBe(ORT_WEB_VERSION)
    const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8')) as { version: string }
    expect(installed.version).toBe(ORT_WEB_VERSION)
  })

  it('pin the tarball the lockfile installs', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string; resolved?: string; integrity?: string }> }
    const entry = lock.packages['node_modules/onnxruntime-web']
    expect(entry?.resolved).toBe(`https://registry.npmjs.org/onnxruntime-web/-/${ORT_WEB_TARBALL.name}`)
    // CAPTURE: the registry's dist.integrity for onnxruntime-web 1.30.0, which the sha512 of the tarball whose sha256 and length ORT_WEB_TARBALL pins matched on 2026-09-28. Moving the lockfile to another tarball fails here before the binary pin can drift from it.
    expect(entry?.integrity).toBe('sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ==')
  })

  it.each([
    ['binary', ORT_WEB_WASM],
    ['glue', ORT_WEB_GLUE],
  ] as const)('match the %s npm installed from that tarball', (_what, file: PinnedFile) => {
    const bytes = fs.readFileSync(path.join(INSTALLED_DIST, file.name))
    expect(bytes.length).toBe(file.bytes)
    expect(sha256(bytes)).toBe(file.sha256)
  })

  it('match the glue the build copies beside the bundle', () => {
    // tests/setup/build-bundle.ts builds dist/ before any test file runs.
    const bytes = fs.readFileSync(path.join(ROOT, 'dist', ORT_WEB_GLUE.name))
    expect(bytes.length).toBe(ORT_WEB_GLUE.bytes)
    expect(sha256(bytes)).toBe(ORT_WEB_GLUE.sha256)
  })
})

// FORMAT-DERIVED: the ustar header layout (name 0/100, mode 100, uid 108, gid 116, size 124/12 octal, mtime 136, chksum 148/8 summed with itself as spaces, typeflag 156, magic 257 "ustar\0", version 263 "00", prefix 345/155), the pax extended header (typeflag 'x', records "<len> path=<value>\n" with <len> counting the whole record) and the end-of-archive marker of two zero blocks are from POSIX pax, https://pubs.opengroup.org/onlinepubs/9799919799/utilities/pax.html ("ustar Interchange Format" and "pax Extended Header"). The GNU long-name entry (typeflag 'L', name "././@LongLink", data the NUL-terminated name of the next entry) and GNU's "ustar  \0" magic are from the GNU tar manual, https://www.gnu.org/software/tar/manual/html_node/Standard.html.

interface HeaderSpec {
  readonly name: string
  readonly size: number
  readonly type?: string
  readonly prefix?: string
  readonly gnu?: boolean
  /** Written at offset 345, where POSIX keeps the prefix and GNU keeps other fields. */
  readonly at345?: string
}

function tarHeader(spec: HeaderSpec): Buffer {
  const h = Buffer.alloc(512)
  const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`
  h.write(spec.name, 0, 100, 'utf8')
  h.write(octal(0o644, 8), 100, 'latin1')
  h.write(octal(0, 8), 108, 'latin1')
  h.write(octal(0, 8), 116, 'latin1')
  h.write(octal(spec.size, 12), 124, 'latin1')
  h.write(octal(0, 12), 136, 'latin1')
  h.write(spec.type ?? '0', 156, 'latin1')
  if (spec.gnu === true) h.write('ustar  \0', 257, 'latin1')
  else {
    h.write('ustar\0', 257, 'latin1')
    h.write('00', 263, 'latin1')
  }
  if (spec.prefix !== undefined) h.write(spec.prefix, 345, 155, 'utf8')
  if (spec.at345 !== undefined) h.write(spec.at345, 345, 'latin1')
  h.write('        ', 148, 'latin1')
  let sum = 0
  for (const b of h) sum += b
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return h
}

/** A header followed by its data, padded to the 512-byte block. */
function tarEntry(spec: Omit<HeaderSpec, 'size'>, data: Buffer): Buffer {
  const padding = (512 - (data.length % 512)) % 512
  return Buffer.concat([tarHeader({ ...spec, size: data.length }), data, Buffer.alloc(padding)])
}

/** One pax record, "<len> key=value\n", where <len> counts the whole record including its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body)
  while (`${length}${body}`.length !== length) length = Buffer.byteLength(`${length}${body}`)
  return `${length}${body}`
}

function gzipTar(...entries: Buffer[]): Buffer {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

const PAYLOAD = Buffer.from('the pinned payload, as any bytes would do\n'.repeat(40))
const PAYLOAD_PIN: PinnedFile = { name: 'payload.bin', sha256: sha256(PAYLOAD), bytes: PAYLOAD.length }
const DECOY = Buffer.from('a different member that happens to come first\n')
const LONG_DIR = `package/${'nested-directory-name/'.repeat(6)}dist`
const LONG_MEMBER = `${LONG_DIR}/payload.bin`

describe('extractTarMember', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tar-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function extract(archive: Buffer, member: string, pin: PinnedFile = PAYLOAD_PIN): Promise<string> {
    const file = path.join(tmp, 'archive.tgz')
    fs.writeFileSync(file, archive)
    const target = path.join(tmp, 'out.bin')
    await extractTarMember(file, member, pin, target)
    return target
  }

  it('finds a member with a short name behind another entry', async () => {
    const archive = gzipTar(tarEntry({ name: 'package/package.json' }, DECOY), tarEntry({ name: 'package/dist/payload.bin' }, PAYLOAD))
    expect(fs.readFileSync(await extract(archive, 'package/dist/payload.bin'))).toEqual(PAYLOAD)
  })

  it('joins a ustar prefix to the name', async () => {
    expect(LONG_MEMBER.length).toBeGreaterThan(100)
    const archive = gzipTar(tarEntry({ name: 'payload.bin', prefix: LONG_DIR }, PAYLOAD))
    expect(fs.readFileSync(await extract(archive, LONG_MEMBER))).toEqual(PAYLOAD)
  })

  it('takes the name from a pax extended header over the truncated one that follows it', async () => {
    const pax = Buffer.from(paxRecord('mtime', '1700000000') + paxRecord('path', LONG_MEMBER))
    const archive = gzipTar(tarEntry({ name: 'PaxHeader/payload.bin', type: 'x' }, pax), tarEntry({ name: LONG_MEMBER.slice(0, 100) }, PAYLOAD))
    expect(fs.readFileSync(await extract(archive, LONG_MEMBER))).toEqual(PAYLOAD)
  })

  it('takes the name from a GNU long-name entry, and does not read GNU fields at 345 as a prefix', async () => {
    const longName = Buffer.from(`${LONG_MEMBER}\0`)
    const archive = gzipTar(
      tarEntry({ name: '././@LongLink', type: 'L', gnu: true }, longName),
      tarEntry({ name: LONG_MEMBER.slice(0, 100), gnu: true, at345: '14540000000' }, PAYLOAD),
      tarEntry({ name: 'payload.bin', gnu: true, at345: 'package/dist' }, DECOY),
    )
    expect(fs.readFileSync(await extract(archive, LONG_MEMBER))).toEqual(PAYLOAD)
    // Read as a POSIX prefix, the third entry would be named package/dist/payload.bin; under GNU's magic it is plain payload.bin, so asking for the former finds nothing.
    await expect(extract(archive, 'package/dist/payload.bin')).rejects.toThrow(/has no package\/dist\/payload\.bin/)
  })

  it('refuses a member whose bytes do not hash to the pin, leaving nothing at the target', async () => {
    const archive = gzipTar(tarEntry({ name: 'payload.bin' }, PAYLOAD))
    const target = path.join(tmp, 'out.bin')
    await expect(extract(archive, 'payload.bin', { ...PAYLOAD_PIN, sha256: '0'.repeat(64) })).rejects.toThrow(/sha256/)
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readdirSync(tmp)).toEqual(['archive.tgz'])
  })

  it('refuses a member of the wrong length before reading it', async () => {
    const archive = gzipTar(tarEntry({ name: 'payload.bin' }, PAYLOAD))
    await expect(extract(archive, 'payload.bin', { ...PAYLOAD_PIN, bytes: PAYLOAD.length + 1 })).rejects.toThrow(/expected the pinned/)
  })

  it('refuses a header whose checksum does not add up', async () => {
    const entry = tarEntry({ name: 'payload.bin' }, PAYLOAD)
    entry[0] = entry[0]! ^ 0x01
    await expect(extract(gzipTar(entry), 'payload.bin')).rejects.toThrow(/bad checksum/)
  })

  it('says so when the member is not in the archive', async () => {
    await expect(extract(gzipTar(tarEntry({ name: 'other.bin' }, DECOY)), 'payload.bin')).rejects.toThrow(/has no payload\.bin/)
  })

  it('says so when the archive stops before its end marker', async () => {
    const truncated = zlib.gzipSync(tarEntry({ name: 'other.bin' }, DECOY))
    await expect(extract(truncated, 'payload.bin')).rejects.toThrow(/ended before its end-of-archive marker/)
  })
})

// The shared cache is cleared rather than inherited: whether the binary comes from disk or from the network is what these tests observe, and CI exports the variable. The one test about the shared cache sets it itself.
const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_OFFLINE', 'TOKEN_GOAT_MODEL_CACHE_DIR'] as const

describe('ensureWasmBinary', () => {
  let tmp: string
  let saved: Record<string, string | undefined>
  let urls: string[]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wasm-'))
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env['LOCALAPPDATA'] = tmp
    process.env['XDG_DATA_HOME'] = tmp
    delete process.env['TOKEN_GOAT_OFFLINE']
    delete process.env['TOKEN_GOAT_MODEL_CACHE_DIR']
    _resetDataDirCacheForTesting()
    clearModuleCaches()
    urls = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    _resetDataDirCacheForTesting()
    clearModuleCaches()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 })
  })

  function stubFetch(respond: () => Response): void {
    vi.stubGlobal('fetch', async (input: unknown) => {
      urls.push(String(input))
      return respond()
    })
  }

  it('makes no request in offline mode, and says which switch refused and where the file goes', async () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    stubFetch(() => new Response('unexpected', { status: 200 }))
    await expect(ensureWasmBinary()).rejects.toThrow(/network\.offline/)
    await expect(ensureWasmBinary()).rejects.toThrow(new RegExp(ORT_WEB_WASM.name.replaceAll('.', '\\.')))
    expect(urls).toEqual([])
    expect(wasmBinaryPresent()).toBe(false)
  })

  it('places a verified copy from the shared cache without the network, even offline', async () => {
    const shared = path.join(tmp, 'shared')
    fs.mkdirSync(path.join(shared, 'onnxruntime-web', ORT_WEB_VERSION), { recursive: true })
    fs.copyFileSync(path.join(INSTALLED_DIST, ORT_WEB_WASM.name), path.join(shared, 'onnxruntime-web', ORT_WEB_VERSION, ORT_WEB_WASM.name))
    process.env['TOKEN_GOAT_MODEL_CACHE_DIR'] = shared
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    stubFetch(() => new Response('unexpected', { status: 200 }))

    const bytes = await ensureWasmBinary()
    expect(bytes.byteLength).toBe(ORT_WEB_WASM.bytes)
    expect(sha256(fs.readFileSync(path.join(wasmDir(), ORT_WEB_WASM.name)))).toBe(ORT_WEB_WASM.sha256)
    expect(urls).toEqual([])
  })

  it('replaces a wrong local copy rather than trusting it, and leaves nothing behind when the fetch fails', async () => {
    fs.mkdirSync(wasmDir(), { recursive: true })
    fs.writeFileSync(path.join(wasmDir(), ORT_WEB_WASM.name), Buffer.alloc(ORT_WEB_WASM.bytes))
    stubFetch(() => new Response('gone', { status: 404, statusText: 'Not Found' }))

    await expect(ensureWasmBinary()).rejects.toThrow(/404/)
    expect(urls).toEqual([`https://registry.npmjs.org/onnxruntime-web/-/${ORT_WEB_TARBALL.name}`])
    // Neither the zeroed copy, nor the archive, nor a partial file survives: a later attempt starts clean.
    expect(fs.readdirSync(wasmDir())).toEqual([])
  })

  /** The real binary npm installed, which the pins above hold to the published one, with `edit` applied. HAND-DERIVED: a one-byte flip keeps the length and changes the digest; a one-byte cut changes the length. */
  function placeLocal(edit: (bytes: Buffer) => Buffer): void {
    fs.mkdirSync(wasmDir(), { recursive: true })
    fs.writeFileSync(path.join(wasmDir(), ORT_WEB_WASM.name), edit(fs.readFileSync(path.join(INSTALLED_DIST, ORT_WEB_WASM.name))))
  }

  it('uses a verified local copy without the network', async () => {
    placeLocal((b) => b)
    stubFetch(() => new Response('unexpected', { status: 200 }))
    const bytes = await ensureWasmBinary()
    expect(sha256(Buffer.from(bytes))).toBe(ORT_WEB_WASM.sha256)
    expect(urls).toEqual([])
  })

  it.each([
    ['tampered, at the pinned length', (b: Buffer): Buffer => {
      const out = Buffer.from(b)
      out[out.length >> 1] = out[out.length >> 1]! ^ 0xff
      return out
    }],
    ['truncated by one byte', (b: Buffer): Buffer => b.subarray(0, b.length - 1)],
  ] as const)('never hands the runtime a local copy that is %s, and goes back to the registry for a good one', async (_what, edit) => {
    placeLocal(edit)
    stubFetch(() => new Response('gone', { status: 404, statusText: 'Not Found' }))
    await expect(ensureWasmBinary()).rejects.toThrow(/404/)
    expect(urls).toEqual([`https://registry.npmjs.org/onnxruntime-web/-/${ORT_WEB_TARBALL.name}`])
    expect(fs.readdirSync(wasmDir())).toEqual([])
  })

  it('refuses a tampered copy in the shared cache and drops it there, so no later run is offered it', async () => {
    const shared = path.join(tmp, 'shared')
    const sharedFile = path.join(shared, 'onnxruntime-web', ORT_WEB_VERSION, ORT_WEB_WASM.name)
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true })
    const tampered = Buffer.from(fs.readFileSync(path.join(INSTALLED_DIST, ORT_WEB_WASM.name)))
    tampered[0] = tampered[0]! ^ 0xff
    fs.writeFileSync(sharedFile, tampered)
    process.env['TOKEN_GOAT_MODEL_CACHE_DIR'] = shared
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    stubFetch(() => new Response('unexpected', { status: 200 }))

    await expect(ensureWasmBinary()).rejects.toThrow(/network\.offline/)
    expect(fs.existsSync(sharedFile)).toBe(false)
    expect(fs.readdirSync(wasmDir())).toEqual([])
    expect(urls).toEqual([])
  })

  it('refuses a tarball that is not the pinned one, and leaves nothing behind', async () => {
    stubFetch(() => new Response(new Uint8Array(gzipTar(tarEntry({ name: `package/dist/${ORT_WEB_WASM.name}` }, PAYLOAD))), { status: 200 }))
    await expect(ensureWasmBinary()).rejects.toThrow(/pinned/)
    expect(fs.readdirSync(wasmDir())).toEqual([])
  })

  // The two callers each refuse offline before calling it; this pins the gate in the function every download passes, so a caller that forgets its own check still cannot leave the machine.
  it('refuses to download in offline mode even when a caller skips its own check', async () => {
    process.env['TOKEN_GOAT_OFFLINE'] = '1'
    stubFetch(() => new Response('unexpected', { status: 200 }))
    const target = path.join(tmp, 'file.bin')
    await expect(downloadPinned('https://registry.npmjs.org/x.tgz', { name: 'file.bin', sha256: sha256(Buffer.from('unexpected')), bytes: 10 }, target)).rejects.toThrow(/network\.offline/)
    expect(urls).toEqual([])
    expect(fs.existsSync(target)).toBe(false)
  })
})
