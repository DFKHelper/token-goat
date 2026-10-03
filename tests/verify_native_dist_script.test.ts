/** scripts/verify-native-dist.mjs is the last gate before `npm publish`: it must refuse an unsigned Windows binary, a binary whose bytes differ from what its producing job recorded, a dynamically linked Linux binary (the glibc build the test run leaves in dist/native), and anything in dist/native that is not one of the four release binaries. Provenance, per fixture: the binary this run built (tests/helpers/native_bin.ts) is CAPTURE, a real unsigned executable from scripts/build-native.mjs; the synthetic PE and ELF files are FORMAT-DERIVED, laid out from the Microsoft PE/COFF specification (https://learn.microsoft.com/en-us/windows/win32/debug/pe-format, sections "Optional Header Data Directories" and "The Attribute Certificate Table") and the System V ABI ELF header, program header and dynamic section layout (elf(5), https://man7.org/linux/man-pages/man5/elf.5.html: e_type, PT_DYNAMIC, Elf64_Dyn, DT_NEEDED), with the certificate content encoded per RFC 5652 sections 3 and 5 (ContentInfo and SignedData, https://www.rfc-editor.org/rfc/rfc5652) in DER per ITU-T X.690, its SpcIndirectDataContent and image digest laid out from the Authenticode PE specification (Windows Authenticode Portable Executable Signature Format, https://download.microsoft.com/download/9/c/5/9c5b2167-8017-4bae-9fde-d599bac8184a/Authenticode_PE.docx, sections "Authenticode-Specific Structures" and "Calculating the PE Image Hash"); the signed node.exe running the suite is CAPTURE, a real Authenticode signature from a real signing tool; every expected sha256 is HAND-DERIVED, computed here from the fixture bytes. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NATIVE_TARGETS, elfProblem, parseManifest, peSignatureProblem, releaseTargets, verifyNativeDist, verifyPackDir } from '../scripts/verify-native-dist.mjs'
import { buildNative } from './helpers/native_bin.js'
// @ts-expect-error -- a maintainer script in plain JavaScript, deliberately outside the typed source tree.
import { npmCommand } from '../scripts/dependabot-body.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repoRoot, 'scripts', 'verify-native-dist.mjs')

const IMAGE_FILE_MACHINE_AMD64 = 0x8664
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64
const EM_X86_64 = 62
const EM_AARCH64 = 183

// DER (X.690) object identifiers: signedData 1.2.840.113549.1.7.2 (RFC 5652), SHA-256 2.16.840.1.101.3.4.2.1 and SHA-224 2.16.840.1.101.3.4.2.4 (RFC 5754), and SPC_INDIRECT_DATA_OBJID 1.3.6.1.4.1.311.2.1.4 and SPC_PE_IMAGE_DATAOBJ 1.3.6.1.4.1.311.2.1.15 (Authenticode). SIGNED_DATA is a SignedData cut down to its version field, the shape the check accepted before it bound the signature to the file.
const OID_SIGNED_DATA = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]
const OID_SHA256 = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01])
const OID_SHA224 = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x04])
const OID_SPC_INDIRECT_DATA = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04])
const OID_SPC_PE_IMAGE_DATA = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x0f])
const DER_NULL = Buffer.from([0x05, 0x00])
const SIGNED_DATA = [0x30, 0x03, 0x02, 0x01, 0x01]

/** One DER element: `tag`, its length (the long form once the body passes 127 bytes, or whenever `longForm` asks for it), then `body`. */
function tlv(tag: number, body: Buffer | readonly number[], longForm = false): Buffer {
  const content = Buffer.from(body)
  const octets: number[] = []
  for (let n = content.length; n > 0 || octets.length === 0; n >>= 8) octets.unshift(n & 0xff)
  const length = content.length < 0x80 && !longForm ? [content.length] : [0x80 | octets.length, ...octets]
  return Buffer.concat([Buffer.from([tag, ...length]), content])
}

type Envelope = { algorithm?: Buffer; contentType?: Buffer; digestTag?: number; signers?: Buffer; certificates?: boolean; longForm?: boolean }

/** An Authenticode ContentInfo signing `digest`: SignedData { version, digestAlgorithms, encapContentInfo { SPC_INDIRECT_DATA, [0] SpcIndirectDataContent { SpcAttributeTypeAndOptionalValue { SPC_PE_IMAGE_DATA, SpcPeImageData }, DigestInfo { algorithm, digest } } }, [0] certificates and [1] crls when asked, signerInfos }. The signer is a placeholder SEQUENCE, since the check stops at whether one exists. */
function authenticodeContentInfo(digest: Buffer, opts: Envelope = {}): Buffer {
  const long = opts.longForm === true
  const algorithm = tlv(0x30, Buffer.concat([opts.algorithm ?? OID_SHA256, DER_NULL]), long)
  const digestInfo = tlv(0x30, Buffer.concat([algorithm, tlv(opts.digestTag ?? 0x04, digest, long)]), long)
  const imageData = tlv(0x30, Buffer.concat([OID_SPC_PE_IMAGE_DATA, tlv(0x30, [0x03, 0x01, 0x00])]), long)
  const encap = tlv(0x30, Buffer.concat([opts.contentType ?? OID_SPC_INDIRECT_DATA, tlv(0xa0, tlv(0x30, Buffer.concat([imageData, digestInfo]), long), long)]), long)
  const extras = opts.certificates === true ? [tlv(0xa0, tlv(0x30, digestInfo)), tlv(0xa1, tlv(0x30, [0x02, 0x01, 0x00]))] : []
  const signedData = tlv(0x30, Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), tlv(0x31, algorithm), encap, ...extras, tlv(0x31, opts.signers ?? tlv(0x30, [0x02, 0x01, 0x01]))]), long)
  return tlv(0x30, Buffer.concat([Buffer.from(OID_SIGNED_DATA), tlv(0xa0, signedData, long)]), long)
}

/** A WIN_CERTIFICATE (dwLength, wRevision 0x0200, wCertificateType 0x0002 PKCS_SIGNED_DATA, bCertificate) holding `content`, padded to the quadword boundary the spec requires. */
function winCertificate(content: Buffer): Buffer {
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

/** `pe` with a WIN_CERTIFICATE appended at an 8-byte-aligned offset and the Certificate Table pointed at it, the placement Authenticode signing tools use. The certificate holds `content` verbatim when given bytes, and otherwise an Authenticode envelope over the SHA-256 image hash, which per "Calculating the PE Image Hash" covers the file up to the certificate table except the CheckSum field (optional header +64) and the Certificate Table entry itself. */
function withCertificateTable(pe: Buffer, content?: Buffer | Envelope): Buffer {
  const aligned = Buffer.concat([pe, Buffer.alloc((8 - (pe.length % 8)) % 8)])
  const entry = certificateDirectoryAt(aligned)
  const checksum = aligned.readUInt32LE(0x3c) + 24 + 64
  const digest = createHash('sha256').update(aligned.subarray(0, checksum)).update(aligned.subarray(checksum + 4, entry)).update(aligned.subarray(entry + 8)).digest()
  const cert = winCertificate(Buffer.isBuffer(content) ? content : authenticodeContentInfo(digest, content))
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

/** A 64-bit little-endian ELF header for `machine` followed by one 56-byte program header per entry of `types` (PT_LOAD is 1, PT_INTERP is 3). With `dynamic`, a PT_DYNAMIC (2) header is added whose p_offset (+8) and p_filesz (+32) cover those (d_tag, d_val) pairs, appended after the headers; `dynamicSize` overrides p_filesz. */
function syntheticElf(machine: number, types: readonly number[], opts: { type?: number; dynamic?: ReadonlyArray<readonly [bigint, bigint]>; dynamicSize?: number; loadFlags?: number; loadSize?: number } = {}): Buffer {
  const headers = opts.dynamic === undefined ? types : [...types, 2]
  const dynamicAt = 64 + 56 * headers.length
  const buf = Buffer.alloc(dynamicAt + 16 * (opts.dynamic?.length ?? 0))
  buf.writeUInt32BE(0x7f454c46, 0)
  buf[4] = 2
  buf[5] = 1
  buf[6] = 1
  buf.writeUInt16LE(opts.type ?? 3, 16)
  buf.writeUInt16LE(machine, 18)
  buf.writeBigUInt64LE(64n, 32)
  buf.writeUInt16LE(64, 52)
  buf.writeUInt16LE(56, 54)
  buf.writeUInt16LE(headers.length, 56)
  headers.forEach((t, i) => buf.writeUInt32LE(t, 64 + 56 * i))
  // Each PT_LOAD maps the file from offset 0 with p_flags (+4) PF_R|PF_X by default, so the binary carries code to run; p_filesz (+32) stays inside the file unless a test widens it.
  types.forEach((t, i) => {
    if (t !== 1) return
    buf.writeUInt32LE(opts.loadFlags ?? 5, 64 + 56 * i + 4)
    buf.writeBigUInt64LE(BigInt(opts.loadSize ?? 64), 64 + 56 * i + 32)
  })
  if (opts.dynamic !== undefined) {
    const header = 64 + 56 * types.length
    buf.writeBigUInt64LE(BigInt(dynamicAt), header + 8)
    buf.writeBigUInt64LE(BigInt(opts.dynamicSize ?? 16 * opts.dynamic.length), header + 32)
    opts.dynamic.forEach(([tag, value], i) => {
      buf.writeBigInt64LE(tag, dynamicAt + 16 * i)
      buf.writeBigUInt64LE(value, dynamicAt + 16 * i + 8)
    })
  }
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

function writeFiles(files: Map<string, Buffer>): void {
  for (const [rel, buf] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), buf)
  }
}

function writeRelease(files: Map<string, Buffer>): { windows: string; linux: string } {
  writeFiles(files)
  const line = (rel: string): string => `${sha256(files.get(rel)!)}  ${rel}\n`
  return { windows: line('win32-x64/tg-hook.exe') + line('win32-arm64/tg-hook.exe'), linux: line('linux-x64/tg-hook') + line('linux-arm64/tg-hook') }
}

/** The two Linux binaries alone, as a release with no Windows signing configuration assembles them, and their manifest. */
function writeLinuxRelease(): string {
  const files = new Map([...validRelease()].filter(([rel]) => rel.startsWith('linux-')))
  writeFiles(files)
  return [...files].map(([rel, buf]) => `${sha256(buf)}  ${rel}\n`).join('')
}

/** Replaces `rel` under the scratch dir with a link to a path that does not exist (a junction on Windows, which needs no privilege; a symlink elsewhere), so it lists as an entry but cannot be read. */
function danglingLink(rel: string): void {
  const link = path.join(dir, rel)
  fs.rmSync(link, { force: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  if (process.platform === 'win32') fs.symlinkSync(path.join(dir, 'missing-target'), link, 'junction')
  else fs.symlinkSync('missing-target', link)
}

type CliResult = { status: number | null; stdout: string; stderr: string }

function runScript(...args: string[]): CliResult {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function runCliWith(flags: string[], manifests: string[]): CliResult {
  const paths = manifests.map((text, i) => {
    const file = path.join(os.tmpdir(), `${path.basename(dir)}-manifest-${i}.txt`)
    fs.writeFileSync(file, text)
    return file
  })
  const r = runScript(...flags, dir, ...paths)
  for (const p of paths) fs.rmSync(p, { force: true })
  return r
}

const runCli = (...manifests: string[]): CliResult => runCliWith([], manifests)

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

  it.runIf(process.platform === 'win32')('refuses a working-tree publish whose dist/native holds the unsigned build, through the prepack command', () => {
    const target = process.arch === 'arm64' ? 'win32-arm64/tg-hook.exe' : 'win32-x64/tg-hook.exe'
    writeFiles(new Map([[target, fs.readFileSync(buildNative())]]))
    const r = runScript('--pack', dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`${target}: carries no Authenticode signature (its certificate table is empty); delete dist/native, or publish through the release workflow, which signs it`)
    expect(r.stderr).toContain('refusing to publish')
  })

  it.runIf(process.platform === 'linux')('refuses the glibc binary the test run leaves in dist/native as dynamically linked', () => {
    const elf = fs.readFileSync(buildNative())
    expect(elfProblem(elf, hostMachine.elf)).toBe('is dynamically linked (it names an ELF interpreter); the release ships musl-static binaries only')
    writeFiles(new Map([[process.arch === 'arm64' ? 'linux-arm64/tg-hook' : 'linux-x64/tg-hook', elf]]))
    expect(verifyPackDir(dir)).toHaveLength(1)
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

  it('refuses a WIN_CERTIFICATE that only looks like DER, such as an empty SEQUENCE', () => {
    const problem = (content: number[]): string | undefined => peSignatureProblem(withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64), Buffer.from(content)), IMAGE_FILE_MACHINE_AMD64)
    expect(problem([0x30, 0x00])).toBe('has a WIN_CERTIFICATE whose ContentInfo is not PKCS#7 signedData')
    expect(problem([0x02, 0x01, 0x01])).toBe('has a WIN_CERTIFICATE whose content is not a DER SEQUENCE that fits it')
    expect(problem([0x30, 0x7f, ...OID_SIGNED_DATA])).toBe('has a WIN_CERTIFICATE whose content is not a DER SEQUENCE that fits it')
    expect(problem([0x30, 0x80, ...OID_SIGNED_DATA, 0x00, 0x00])).toBe('has a WIN_CERTIFICATE whose content is not a DER SEQUENCE that fits it')
    // pkcs7-data (1.2.840.113549.1.7.1) in place of signedData.
    expect(problem([0x30, 0x12, ...OID_SIGNED_DATA.slice(0, -1), 0x01, 0xa0, 0x05, ...SIGNED_DATA])).toBe('has a WIN_CERTIFICATE whose ContentInfo is not PKCS#7 signedData')
    expect(problem([0x30, 0x0b, ...OID_SIGNED_DATA])).toBe('has a WIN_CERTIFICATE whose signedData content is missing or truncated')
    expect(problem([0x30, 0x10, ...OID_SIGNED_DATA, 0xa0, 0x03, 0x02, 0x01, 0x01])).toBe('has a WIN_CERTIFICATE whose signedData content is missing or truncated')
    expect(problem([0x30, 0x12, ...OID_SIGNED_DATA, 0xa0, 0x09, ...SIGNED_DATA])).toBe('has a WIN_CERTIFICATE whose signedData content is missing or truncated')
  })

  it('reads the long-form lengths a real signature uses', () => {
    expect(peSignatureProblem(withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64), { longForm: true }), IMAGE_FILE_MACHINE_AMD64)).toBeUndefined()
  })

  it('refuses a well-formed signedData envelope that signs nothing, the shape the check once accepted', () => {
    const bare = Buffer.from([0x30, 0x12, ...OID_SIGNED_DATA, 0xa0, 0x05, ...SIGNED_DATA])
    expect(peSignatureProblem(withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64), bare), IMAGE_FILE_MACHINE_AMD64)).toBe('has a WIN_CERTIFICATE whose signedData is not version, digest algorithms and content')
  })

  it('refuses a signature whose image digest belongs to other bytes, while ignoring the checksum field the digest skips', () => {
    const pe = withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64))
    const tampered = Buffer.from(pe)
    tampered[0x10] ^= 1
    expect(peSignatureProblem(tampered, IMAGE_FILE_MACHINE_AMD64)).toBe('has an Authenticode signature whose image digest does not match the file, so the signature belongs to other bytes')
    const rechecksummed = Buffer.from(pe)
    rechecksummed.writeUInt32LE(0xdeadbeef, rechecksummed.readUInt32LE(0x3c) + 24 + 64)
    expect(peSignatureProblem(rechecksummed, IMAGE_FILE_MACHINE_AMD64)).toBeUndefined()
  })

  it('refuses bytes appended after the certificate table, which no signature covers', () => {
    const pe = withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64))
    expect(peSignatureProblem(Buffer.concat([pe, Buffer.alloc(8)]), IMAGE_FILE_MACHINE_AMD64)).toBe('has data after its certificate table, which the signature does not cover')
  })

  it('refuses an envelope with no signer, an unknown digest algorithm, a non-Authenticode content type, or no digest', () => {
    const problem = (opts: Envelope): string | undefined => peSignatureProblem(withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_AMD64), opts), IMAGE_FILE_MACHINE_AMD64)
    expect(problem({ signers: Buffer.alloc(0) })).toBe('has a WIN_CERTIFICATE whose signedData has no signer')
    expect(problem({ algorithm: OID_SHA224 })).toBe('has a WIN_CERTIFICATE whose signedData uses an image digest algorithm this check does not know')
    // pkcs7-data (1.2.840.113549.1.7.1) as the encapsulated content type.
    expect(problem({ contentType: Buffer.from([...OID_SIGNED_DATA.slice(0, -1), 0x01]) })).toBe('has a WIN_CERTIFICATE whose signedData does not sign Authenticode indirect data')
    expect(problem({ digestTag: 0x03 })).toBe('has a WIN_CERTIFICATE whose signedData carries no image digest')
    expect(problem({ certificates: true })).toBeUndefined()
  })

  // CAPTURE: the node.exe running this suite is Authenticode-signed by the Node.js project, so it is a real signature produced by a real signing tool rather than one laid out from the spec.
  it.runIf(process.platform === 'win32')('accepts the signed node.exe running this suite, and refuses it once a byte changes or bytes are appended', () => {
    const node = fs.readFileSync(process.execPath)
    const machine = node.readUInt16LE(node.readUInt32LE(0x3c) + 4)
    expect(peSignatureProblem(node, machine)).toBeUndefined()
    const flipped = Buffer.from(node)
    flipped[0x2000] ^= 1
    expect(peSignatureProblem(flipped, machine)).toBe('has an Authenticode signature whose image digest does not match the file, so the signature belongs to other bytes')
    expect(peSignatureProblem(Buffer.concat([node, Buffer.alloc(8)]), machine)).toBe('has data after its certificate table, which the signature does not cover')
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

  // A musl static-pie keeps PT_DYNAMIC for its own relocations (DT_RELA 7, DT_RELASZ 8, DT_FLAGS_1 0x6ffffffb) with no DT_NEEDED; a glibc build linked with a custom loader path, or with PT_INTERP stripped, still carries DT_NEEDED (1) entries naming libc.so.6.
  it('passes a static-pie dynamic segment and refuses one that needs a shared library', () => {
    const staticPie: Array<[bigint, bigint]> = [[7n, 0x1000n], [8n, 0x18n], [0x6ffffffbn, 0x8000000n], [0n, 0n]]
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1], { dynamic: staticPie }), EM_X86_64)).toBeUndefined()
    const needsLibc: Array<[bigint, bigint]> = [[7n, 0x1000n], [1n, 0x20n], [0n, 0n]]
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1], { dynamic: needsLibc }), EM_X86_64)).toBe('is dynamically linked (it needs a shared library); the release ships musl-static binaries only')
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1], { dynamic: [[0n, 0n], [1n, 0x20n]] }), EM_X86_64)).toBeUndefined()
  })

  it('refuses a dynamic segment that runs past the end of the file, and an ELF that is not an executable', () => {
    expect(elfProblem(syntheticElf(EM_X86_64, [1], { dynamic: [[0n, 0n]], dynamicSize: 32 }), EM_X86_64)).toBe('has a dynamic segment that does not fit in the file')
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1], { type: 1 }), EM_X86_64)).toBe('is not an executable (e_type 1)')
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1], { type: 4 }), EM_X86_64)).toBe('is not an executable (e_type 4)')
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1], { type: 2 }), EM_X86_64)).toBeUndefined()
  })

  it('refuses an ELF with no executable loadable segment, and one whose loadable segment runs past the end of the file', () => {
    expect(elfProblem(syntheticElf(EM_X86_64, []), EM_X86_64)).toBe('has no executable loadable segment, so it holds no code to run')
    expect(elfProblem(syntheticElf(EM_X86_64, [1, 1], { loadFlags: 4 }), EM_X86_64)).toBe('has no executable loadable segment, so it holds no code to run')
    expect(elfProblem(syntheticElf(EM_X86_64, [1], { loadSize: 1 << 20 }), EM_X86_64)).toBe('has a loadable segment that does not fit in the file')
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

  it('reports a release binary that lists but cannot be read, and checks the rest', () => {
    const m = writeRelease(validRelease())
    danglingLink('linux-x64/tg-hook')
    const problems = verifyNativeDist(dir, { windows: m.windows, linux: m.linux })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^linux-x64\/tg-hook: cannot be read \(/)
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
    expect(runScript('--without-windows', dir).status).toBe(2)
    expect(runScript('--pack').status).toBe(2)
    // A misspelled flag is a usage error, not a directory named after it.
    expect(runScript('--without-window', dir, dir).status).toBe(2)
  })
})

describe('a release with no Windows signing configuration (HAND-DERIVED hashes over FORMAT-DERIVED binaries)', () => {
  it('ships the two Linux binaries only', () => {
    expect(releaseTargets(true).map((t) => t.platformArch)).toEqual(['linux-x64', 'linux-arm64'])
    expect(releaseTargets(false)).toBe(NATIVE_TARGETS)
  })

  it('passes the Linux binaries alone, and the command says Windows keeps the Node hook', () => {
    const linux = writeLinuxRelease()
    expect(verifyNativeDist(dir, { linux }, { withoutWindows: true })).toEqual([])
    const r = runCliWith(['--without-windows'], [linux])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('verify-native-dist: 2 native binaries verified (no Windows binaries: Windows installs keep the Node hook)\n')
  })

  it('refuses a Windows binary, signed or not, since nothing signed it in this release', () => {
    const linux = writeLinuxRelease()
    writeFiles(new Map([['win32-x64/tg-hook.exe', syntheticPe(IMAGE_FILE_MACHINE_AMD64)], ['win32-arm64/tg-hook.exe', withCertificateTable(syntheticPe(IMAGE_FILE_MACHINE_ARM64))]]))
    expect(verifyNativeDist(dir, { linux }, { withoutWindows: true })).toEqual([
      'win32-arm64/tg-hook.exe: Windows binaries ship only signed, and this release has no Windows signing configuration',
      'win32-x64/tg-hook.exe: Windows binaries ship only signed, and this release has no Windows signing configuration',
    ])
    const r = runCliWith(['--without-windows'], [linux])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('refusing to publish')
  })

  it('still refuses a missing Linux binary, a manifest naming a Windows file, and a dynamically linked build', () => {
    const linux = writeLinuxRelease()
    fs.rmSync(path.join(dir, 'linux-arm64', 'tg-hook'))
    const elf = syntheticElf(EM_X86_64, [6, 3, 1])
    fs.writeFileSync(path.join(dir, 'linux-x64', 'tg-hook'), elf)
    const manifest = `${sha256(elf)}  linux-x64/tg-hook\n${'0'.repeat(64)}  win32-x64/tg-hook.exe\n`
    expect(verifyNativeDist(dir, { linux: manifest }, { withoutWindows: true })).toEqual([
      'linux: lists win32-x64/tg-hook.exe, which is not a release binary',
      'linux-x64/tg-hook: is dynamically linked (it names an ELF interpreter); the release ships musl-static binaries only',
      'linux-arm64/tg-hook: missing',
    ])
    expect(linux).toContain('linux-arm64/tg-hook')
  })

  it('without the flag, the same Linux-only directory is refused as missing its Windows binaries', () => {
    const linux = writeLinuxRelease()
    expect(verifyNativeDist(dir, { linux })).toEqual(['win32-x64/tg-hook.exe: missing', 'win32-arm64/tg-hook.exe: missing'])
  })
})

describe('the prepack check on a working-tree pack or publish (FORMAT-DERIVED binaries)', () => {
  const PACK_REMEDY = 'delete dist/native, or publish through the release workflow, which signs it'

  it('passes when dist/native does not exist, the state every platform supports through the Node hook', () => {
    const missing = path.join(dir, 'native')
    expect(verifyPackDir(missing)).toEqual([])
    const r = runScript('--pack', missing)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(`verify-native-dist: ${missing} holds no unsigned or unexpected native binary\n`)
  })

  it('passes signed Windows and static Linux binaries in release shape, without needing all four', () => {
    writeFiles(new Map([...validRelease()].filter(([rel]) => rel !== 'linux-arm64/tg-hook')))
    expect(verifyPackDir(dir)).toEqual([])
  })

  it('refuses an unsigned Windows binary, a dynamically linked Linux one, and anything that is not a release binary', () => {
    writeFiles(
      new Map([
        ['win32-x64/tg-hook.exe', syntheticPe(IMAGE_FILE_MACHINE_AMD64)],
        ['linux-x64/tg-hook', syntheticElf(EM_X86_64, [6, 3, 1])],
        ['darwin-arm64/tg-hook', Buffer.from('stray')],
      ]),
    )
    expect(verifyPackDir(dir)).toEqual([
      `darwin-arm64/tg-hook: is not a release binary; ${PACK_REMEDY}`,
      `linux-x64/tg-hook: is dynamically linked (it names an ELF interpreter); the release ships musl-static binaries only; ${PACK_REMEDY}`,
      `win32-x64/tg-hook.exe: carries no Authenticode signature (its certificate table is empty); ${PACK_REMEDY}`,
    ])
    const r = runScript('--pack', dir)
    expect(r.status).toBe(1)
    expect(r.stderr.trimEnd().split('\n')).toHaveLength(4)
    expect(r.stderr).toContain('verify-native-dist: refusing to publish\n')
  })

  // HAND-DERIVED: the linked layout is the one `npm install -g .` and `npm link` produce (the global package path is a link to the checkout), and macOS gives the same shape through /var -> /private/var. Node resolves links in import.meta.url but not in argv[1], so a guard comparing the two as typed skipped the check and exited 0 on a tampered binary.
  it('still refuses when the script is run through a linked directory', () => {
    writeFiles(new Map([['win32-x64/tg-hook.exe', syntheticPe(IMAGE_FILE_MACHINE_AMD64)]]))
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-verify-link-'))
    const linked = path.join(linkRoot, 'scripts')
    try {
      fs.symlinkSync(path.dirname(script), linked, process.platform === 'win32' ? 'junction' : 'dir')
      const r = spawnSync(process.execPath, [path.join(linked, 'verify-native-dist.mjs'), '--pack', dir], { encoding: 'utf8' })
      expect(r.stderr).toContain('verify-native-dist: refusing to publish\n')
      expect(r.stderr).toContain(`win32-x64/tg-hook.exe: carries no Authenticode signature (its certificate table is empty); ${PACK_REMEDY}`)
      expect(r.status).toBe(1)
    } finally {
      // The link goes first and on its own (a recursive removal through a junction deletes the target's contents), and a failure to remove it throws before the recursive removal below runs.
      if (fs.existsSync(linked)) {
        try {
          fs.unlinkSync(linked)
        } catch {
          fs.rmdirSync(linked)
        }
      }
      fs.rmSync(linkRoot, { recursive: true, force: true })
    }
  })

  it('refuses a dist/native that exists but cannot be read as a directory', () => {
    const file = path.join(dir, 'native')
    fs.writeFileSync(file, 'not a directory')
    expect(verifyPackDir(file)).toEqual([expect.stringMatching(/^.*native: cannot be read \(/)])
  })

  it('reports an entry that lists but cannot be read instead of failing the whole check, through the command too', () => {
    writeFiles(new Map([...validRelease()].filter(([rel]) => rel.startsWith('win32-'))))
    danglingLink('linux-x64/tg-hook')
    const problems = verifyPackDir(dir)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^linux-x64\/tg-hook: cannot be read \(.*\); delete dist\/native, or publish through the release workflow, which signs it$/)
    const r = runScript('--pack', dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('linux-x64/tg-hook: cannot be read (')
    expect(r.stderr).toContain('verify-native-dist: refusing to publish\n')
  })

  it('is the command package.json runs before a working-tree npm pack or publish, and it refuses an unsigned build from the package root', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const command = pkg.scripts.prepack
    expect(command).toBe('node scripts/verify-native-dist.mjs --pack dist/native')
    // npm runs a lifecycle script through the shell from the package root, so the command runs the same way here against a copy of that root.
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.copyFileSync(script, path.join(dir, 'scripts', 'verify-native-dist.mjs'))
    const run = (): CliResult => {
      const r = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8' })
      return { status: r.status, stdout: r.stdout, stderr: r.stderr }
    }
    expect(run().status).toBe(0)
    writeFiles(new Map([['dist/native/win32-x64/tg-hook.exe', syntheticPe(IMAGE_FILE_MACHINE_AMD64)]]))
    const refused = run()
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`win32-x64/tg-hook.exe: carries no Authenticode signature (its certificate table is empty); ${PACK_REMEDY}`)
  })

  it('stops a real npm pack of an unsigned build, since a packed tarball can be published without npm running prepublishOnly', () => {
    // FORMAT-DERIVED from npm's lifecycle order (https://docs.npmjs.com/cli/v10/using-npm/scripts, "Life Cycle Operation Order"): `npm pack` runs prepack and not prepublishOnly, so only a prepack gate stands in front of a tarball packed first and published second. CAPTURE (npm 11.6.2 here, and CI's npm 10 on every run of this test): the refusal below is npm's, not a simulation of it.
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    // prepare is left out because it runs scripts/install-git-hooks.mjs, which this copy of the package root does not carry.
    const scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([name]) => name !== 'prepare'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tg-prepack-probe', version: '0.0.0', scripts, files: ['dist/', 'scripts/verify-native-dist.mjs'] }))
    fs.mkdirSync(path.join(dir, 'scripts'))
    fs.copyFileSync(script, path.join(dir, 'scripts', 'verify-native-dist.mjs'))
    writeFiles(new Map([['dist/index.mjs', Buffer.from('export {}\n')]]))
    const npm = npmCommand({ platform: process.platform, env: process.env, execPath: process.execPath, exists: fs.existsSync })
    expect(npm, 'no npm-cli.js to run').not.toBeNull()
    const pack = (): CliResult => {
      const r = spawnSync(npm.file, [...npm.prefix, 'pack', '--dry-run'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, npm_config_ignore_scripts: 'false' } })
      return { status: r.status, stdout: r.stdout, stderr: r.stderr }
    }
    // The positive control: the same package packs while dist/native holds nothing, so the refusal below is the gate and not a broken package.
    expect(pack().status).toBe(0)
    writeFiles(new Map([['dist/native/win32-x64/tg-hook.exe', syntheticPe(IMAGE_FILE_MACHINE_AMD64)]]))
    const refused = pack()
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain(`win32-x64/tg-hook.exe: carries no Authenticode signature (its certificate table is empty); ${PACK_REMEDY}`)
  }, 120_000)
})
