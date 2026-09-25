/** scripts/verify-native-dist.mjs is the last gate before `npm publish`: it must refuse an unsigned Windows binary, a binary whose bytes differ from what its producing job recorded, a dynamically linked Linux binary (the glibc build the test run leaves in dist/native), and anything in dist/native that is not one of the four release binaries. Provenance, per fixture: the binary this run built (tests/helpers/native_bin.ts) is CAPTURE, a real unsigned executable from scripts/build-native.mjs; the synthetic PE and ELF files are FORMAT-DERIVED, laid out from the Microsoft PE/COFF specification (https://learn.microsoft.com/en-us/windows/win32/debug/pe-format, sections "Optional Header Data Directories" and "The Attribute Certificate Table") and the System V ABI ELF header and program header layout (elf(5), https://man7.org/linux/man-pages/man5/elf.5.html); every expected sha256 is HAND-DERIVED, computed here from the fixture bytes. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_TARGETS, elfProblem, parseManifest, peSignatureProblem, verifyNativeDist } from '../scripts/verify-native-dist.mjs'
import { buildNative } from './helpers/native_bin.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repoRoot, 'scripts', 'verify-native-dist.mjs')

const IMAGE_FILE_MACHINE_AMD64 = 0x8664
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64
const EM_X86_64 = 62
const EM_AARCH64 = 183

/** A WIN_CERTIFICATE (dwLength, wRevision 0x0200, wCertificateType 0x0002 PKCS_SIGNED_DATA, bCertificate) padded to the quadword boundary the spec requires. The content is a minimal DER SEQUENCE, not a real PKCS#7 signature: the script's check is structural. */
function winCertificate(): Buffer {
  const content = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01])
  const header = Buffer.alloc(8)
  header.writeUInt32LE(8 + content.length, 0)
  header.writeUInt16LE(0x0200, 4)
  header.writeUInt16LE(0x0002, 6)
  const cert = Buffer.concat([header, content])
  return Buffer.concat([cert, Buffer.alloc((8 - (cert.length % 8)) % 8)])
}

/** Where the Certificate Table directory entry (data directory 4) sits in `pe`: e_lfanew at 0x3C, then the 4-byte signature and 20-byte COFF header, then the optional header, whose directories start at 112 for PE32+ and 96 for PE32. */
function certificateDirectoryAt(pe: Buffer): number {
  const optional = pe.readUInt32LE(0x3c) + 24
  return optional + (pe.readUInt16LE(optional) === 0x20b ? 112 : 96) + 4 * 8
}

/** `pe` with a WIN_CERTIFICATE appended at an 8-byte-aligned offset and the Certificate Table pointed at it, the placement Authenticode signing tools use. */
function withCertificateTable(pe: Buffer): Buffer {
  const aligned = Buffer.concat([pe, Buffer.alloc((8 - (pe.length % 8)) % 8)])
  const cert = winCertificate()
  const out = Buffer.concat([aligned, cert])
  const at = certificateDirectoryAt(out)
  out.writeUInt32LE(aligned.length, at)
  out.writeUInt32LE(cert.length, at + 4)
  return out
}

/** The smallest PE the check reads: an MZ header pointing at 0x40, the PE signature, a COFF header naming `machine` with no sections, and an optional header (PE32+ by default) with all 16 data directories empty. */
function syntheticPe(machine: number, magic: 0x20b | 0x10b = 0x20b): Buffer {
  const optionalSize = magic === 0x20b ? 240 : 224
  const buf = Buffer.alloc(0x40 + 24 + optionalSize)
  buf.writeUInt16LE(0x5a4d, 0)
  buf.writeUInt32LE(0x40, 0x3c)
  buf.writeUInt32LE(0x00004550, 0x40)
  buf.writeUInt16LE(machine, 0x44)
  buf.writeUInt16LE(optionalSize, 0x40 + 20)
  buf.writeUInt16LE(0x22, 0x40 + 22)
  const optional = 0x40 + 24
  buf.writeUInt16LE(magic, optional)
  buf.writeUInt32LE(16, optional + (magic === 0x20b ? 108 : 92))
  return buf
}

/** A 64-bit little-endian ELF header for `machine` followed by one 56-byte program header per entry of `types` (PT_LOAD is 1, PT_INTERP is 3). */
function syntheticElf(machine: number, types: readonly number[]): Buffer {
  const buf = Buffer.alloc(64 + 56 * types.length)
  buf.writeUInt32BE(0x7f454c46, 0)
  buf[4] = 2
  buf[5] = 1
  buf[6] = 1
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(machine, 18)
  buf.writeBigUInt64LE(64n, 32)
  buf.writeUInt16LE(64, 52)
  buf.writeUInt16LE(56, 54)
  buf.writeUInt16LE(types.length, 56)
  types.forEach((t, i) => buf.writeUInt32LE(t, 64 + 56 * i))
  return buf
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

/** A complete, valid release layout: signed synthetic PEs for Windows and static synthetic ELFs for Linux. */
function validRelease(): Map<string, Buffer> {
  return new Map([
    ['win32-x64/tg-hook.exe', withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64))],
    ['win32-arm64/tg-hook.exe', withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_ARM64))],
    ['linux-x64/tg-hook', syntheticElf(EM_X86_64, [1, 1])],
    ['linux-arm64/tg-hook', syntheticElf(EM_AARCH64, [1, 1])],
  ])
}

let dir: string

function writeRelease(files: Map<string, Buffer>): { windows: string; linux: string } {
  for (const [rel, buf] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), buf)
  }
  const line = (rel: string): string => `${sha256(files.get(rel)!)}  ${rel}\n`
  return { windows: line('win32-x64/tg-hook.exe') + line('win32-arm64/tg-hook.exe'), linux: line('linux-x64/tg-hook') + line('linux-arm64/tg-hook') }
}

function runCli(...manifests: string[]): { status: number | null; stdout: string; stderr: string } {
  const paths = manifests.map((text, i) => {
    const file = path.join(os.tmpdir(), `${path.basename(dir)}-manifest-${i}.txt`)
    fs.writeFileSync(file, text)
    return file
  })
  const r = spawnSync(process.execPath, [script, dir, ...paths], { encoding: 'utf8' })
  for (const p of paths) fs.rmSync(p, { force: true })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-verify-native-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the binary this run built (CAPTURE)', () => {
  const hostMachine = process.arch === 'arm64' ? { pe: IMAGE_FILE_MACHINE_ARM64, elf: EM_AARCH64 } : { pe: IMAGE_FILE_MACHINE_AMD64, elf: EM_X86_64 }

  it.runIf(process.platform === 'win32')('refuses the unsigned PE scripts/build-native.mjs produces', () => {
    const pe = fs.readFileSync(buildNative())
    expect(peSignatureProblem(pe, hostMachine.pe)).toBe('carries no Authenticode signature (its certificate table is empty)')
  })

  it.runIf(process.platform === 'win32')('passes the same PE once its certificate table holds a PKCS#7 WIN_CERTIFICATE', () => {
    const pe = withCertificateTable(fs.readFileSync(buildNative()))
    expect(peSignatureProblem(pe, hostMachine.pe)).toBeUndefined()
    expect(peSignatureProblem(pe, hostMachine.pe === IMAGE_FILE_MACHINE_AMD64 ? IMAGE_FILE_MACHINE_ARM64 : IMAGE_FILE_MACHINE_AMD64)).toMatch(/^declares machine 0x/)
  })

  it.runIf(process.platform === 'win32')('refuses a release whose Windows binary is the unsigned build, through the command the publish job runs', () => {
    const files = validRelease()
    const target = process.arch === 'arm64' ? 'win32-arm64/tg-hook.exe' : 'win32-x64/tg-hook.exe'
    files.set(target, fs.readFileSync(buildNative()))
    const m = writeRelease(files)
    const r = runCli(m.windows, m.linux)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`${target}: carries no Authenticode signature (its certificate table is empty)`)
    expect(r.stderr).toContain('refusing to publish')
  })

  it.runIf(process.platform === 'linux')('refuses the glibc binary the test run leaves in dist/native as dynamically linked', () => {
    const elf = fs.readFileSync(buildNative())
    expect(elfProblem(elf, hostMachine.elf)).toBe('is dynamically linked (it names an ELF interpreter); the release ships musl-static binaries only')
  })

  it.runIf(process.platform === 'darwin')('refuses a Mach-O binary as neither format the release ships', () => {
    const macho = fs.readFileSync(buildNative())
    expect(elfProblem(macho, EM_AARCH64)).toBe('is not an ELF file')
    expect(peSignatureProblem(macho, IMAGE_FILE_MACHINE_ARM64)).toBe('is not a PE file (no MZ header)')
  })
})

describe('peSignatureProblem (FORMAT-DERIVED)', () => {
  it('refuses a PE32+ whose certificate table is empty, and passes it with a WIN_CERTIFICATE', () => {
    const pe = syntheticPe(IMAGE_FILE_MACHINE_AMD64)
    expect(peSignatureProblem(pe, IMAGE_FILE_MACHINE_AMD64)).toBe('carries no Authenticode signature (its certificate table is empty)')
    expect(peSignatureProblem(withCertificateTable(pe), IMAGE_FILE_MACHINE_AMD64)).toBeUndefined()
  })

  it('reads the PE32 directory layout too', () => {
    const pe = syntheticPe(IMAGE_FILE_MACHINE_AMD64, 0x10b)
    expect(peSignatureProblem(pe, IMAGE_FILE_MACHINE_AMD64)).toBe('carries no Authenticode signature (its certificate table is empty)')
    expect(peSignatureProblem(withCertificateTable(pe), IMAGE_FILE_MACHINE_AMD64)).toBeUndefined()
  })

  it('refuses a certificate table that points past the end of the file', () => {
    const pe = withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_ARM64))
    const truncated = pe.subarray(0, pe.length - 8)
    expect(peSignatureProblem(Buffer.from(truncated), IMAGE_FILE_MACHINE_ARM64)).toMatch(/does not fit in the file$/)
  })

  it('refuses a WIN_CERTIFICATE that is not PKCS#7 signed data', () => {
    const pe = withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64))
    const at = pe.readUInt32LE(certificateDirectoryAt(pe))
    pe.writeUInt16LE(0x0001, at + 6)
    expect(peSignatureProblem(pe, IMAGE_FILE_MACHINE_AMD64)).toBe('has a WIN_CERTIFICATE that is not PKCS#7 signed data')
  })

  it('refuses a PE built for the other architecture', () => {
    expect(peSignatureProblem(withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64)), IMAGE_FILE_MACHINE_ARM64)).toBe('declares machine 0x8664, expected 0xaa64')
  })

  it('refuses a file that is not a PE at all', () => {
    expect(peSignatureProblem(syntheticElf(EM_X86_64, [1]), IMAGE_FILE_MACHINE_AMD64)).toBe('is not a PE file (no MZ header)')
  })
})

describe('elfProblem (FORMAT-DERIVED)', () => {
  it('passes a static executable and refuses one that names an interpreter', () => {
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1]), EM_X86_64)).toBeUndefined()
    expect(elfProblem(syntheticElf(EM_X86_64, [6, 3, 1]), EM_X86_64)).toBe('is dynamically linked (it names an ELF interpreter); the release ships musl-static binaries only')
  })

  it('refuses the other architecture and a non-ELF file', () => {
    expect(elfProblem(syntheticElf(EM_AARCH64, [1]), EM_X86_64)).toBe('declares machine 183, expected 62')
    expect(elfProblem(syntheticPe(IMAGE_FILE_MACHINE_AMD64), EM_X86_64)).toBe('is not an ELF file')
  })
})

describe('parseManifest (HAND-DERIVED)', () => {
  it('reads text-mode, binary-mode and CRLF sha256sum lines, and flags anything else', () => {
    const a = 'a'.repeat(64)
    const b = 'B'.repeat(64)
    const { entries, problems } = parseManifest(`${a}  linux-x64/tg-hook\r\n${b} *win32-x64/tg-hook.exe\r\nnot a line\n`, 'm')
    expect([...entries]).toEqual([
      ['linux-x64/tg-hook', a],
      ['win32-x64/tg-hook.exe', 'b'.repeat(64)],
    ])
    expect(problems).toEqual(['m: not a sha256sum line: "not a line"'])
  })
})

describe('verifyNativeDist (HAND-DERIVED hashes over FORMAT-DERIVED binaries)', () => {
  it('passes exactly the four release binaries, each signed or static and matching its recorded hash', () => {
    const m = writeRelease(validRelease())
    expect(verifyNativeDist(dir, { windows: m.windows, linux: m.linux })).toEqual([])
    // The population the gate checks is the one the release ships, so an empty target list cannot pass as a clean one.
    expect(NATIVE_TARGETS.map((t) => t.platformArch)).toEqual(['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'])
  })

  it('refuses an unsigned Windows binary even when its hash is recorded', () => {
    const files = validRelease()
    files.set('win32-arm64/tg-hook.exe', syntheticPe(IMAGE_FILE_MACHINE_ARM64))
    const m = writeRelease(files)
    expect(verifyNativeDist(dir, { windows: m.windows, linux: m.linux })).toEqual(['win32-arm64/tg-hook.exe: carries no Authenticode signature (its certificate table is empty)'])
  })

  it('refuses a binary whose bytes differ from the recorded hash', () => {
    const m = writeRelease(validRelease())
    fs.appendFileSync(path.join(dir, 'linux-arm64', 'tg-hook'), 'x')
    const problems = verifyNativeDist(dir, { windows: m.windows, linux: m.linux })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^linux-arm64\/tg-hook: sha256 [0-9a-f]{64} does not match the recorded [0-9a-f]{64}$/)
  })

  it('refuses a missing binary, a binary no manifest records, and a file that is not a release binary', () => {
    const files = validRelease()
    const m = writeRelease(files)
    fs.rmSync(path.join(dir, 'linux-x64', 'tg-hook'))
    fs.writeFileSync(path.join(dir, 'linux-x64', 'tg-hook.4242.tmp'), 'stray')
    fs.mkdirSync(path.join(dir, 'darwin-arm64'))
    fs.writeFileSync(path.join(dir, 'darwin-arm64', 'tg-hook'), 'stray')
    expect(verifyNativeDist(dir, { windows: m.windows })).toEqual([
      'darwin-arm64/tg-hook: is not a release binary; dist/native must hold the release artifacts and nothing else',
      'linux-x64/tg-hook.4242.tmp: is not a release binary; dist/native must hold the release artifacts and nothing else',
      'linux-x64/tg-hook: missing',
      'linux-arm64/tg-hook: no manifest records its sha256',
    ])
  })

  it('refuses a manifest naming a file the release does not ship, or two manifests claiming one file', () => {
    const m = writeRelease(validRelease())
    const extra = `${'0'.repeat(64)}  darwin-arm64/tg-hook\n`
    expect(verifyNativeDist(dir, { windows: m.windows + extra, linux: m.linux, again: m.linux.split('\n')[0]! })).toEqual([
      'windows: lists darwin-arm64/tg-hook, which is not a release binary',
      'linux-x64/tg-hook: listed by more than one manifest',
    ])
  })
})

describe('the command the publish job runs', () => {
  it('exits 0 on a valid release and names how many binaries it verified', () => {
    const m = writeRelease(validRelease())
    const r = runCli(m.windows, m.linux)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('verify-native-dist: 4 native binaries verified\n')
  })

  it('exits 1, one line per problem, when a Windows binary is unsigned', () => {
    const files = validRelease()
    files.set('win32-x64/tg-hook.exe', syntheticPe(IMAGE_FILE_MACHINE_AMD64))
    const m = writeRelease(files)
    const r = runCli(m.windows, m.linux)
    expect(r.status).toBe(1)
    expect(r.stderr).toBe('verify-native-dist: win32-x64/tg-hook.exe: carries no Authenticode signature (its certificate table is empty)\nverify-native-dist: refusing to publish\n')
  })

  it('exits 2 with usage when given no manifest', () => {
    const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage: node scripts/verify-native-dist.mjs')
  })
})
