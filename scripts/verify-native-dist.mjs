#!/usr/bin/env node
/** The publish gate for the native hook client: refuses a dist/native that is not exactly the release binaries (all four, or the two Linux ones under `--without-windows`), each a statically linked executable for its target and byte-identical to the hash its producing job recorded, with both Windows files carrying an Authenticode signature. Run by the publish job of .github/workflows/publish.yml, which holds the registry token, so it imports nothing but Node builtins: no dependency code runs beside the credential. The signature check binds the signature to these bytes without trusting a certificate chain: the PE certificate table must end the file and hold a WIN_CERTIFICATE wrapping a PKCS#7 SignedData with exactly one signer, every constructed DER element in it holding whole elements and nothing else, and the Authenticode image digest that SignedData signs must equal the digest of the file itself, so a signature lifted from another binary is refused; the sign job has already verified the signature cryptographically, and the hash match is what ties the file here to the file it verified. Usage: `node scripts/verify-native-dist.mjs [--without-windows] <dist/native> <SHA256SUMS>...`, where every manifest is in `sha256sum` format with paths relative to the directory; `--without-windows` is the release with no Windows signing configuration, which ships the two Linux binaries and no Windows one, so Windows installs keep the Node hook. `node scripts/verify-native-dist.mjs --pack <dist/native>` is the prepack check, which npm runs on `npm pack` and on `npm publish` from a directory, so a tarball packed by hand cannot carry what a direct publish would refuse: no manifests, so it checks shape only, and a missing directory passes. Exits 0 when everything holds, otherwise 1 with one line per problem. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every target a release ships: the rustc triple CI builds, the directory the installer (src/native_hook.ts packagedNativeBinary) looks in, the file name there, and the machine the executable header must declare. Linux is built against musl so one static binary serves glibc and musl distributions alike. */
export const NATIVE_TARGETS = Object.freeze([
  Object.freeze({ triple: 'x86_64-pc-windows-msvc', platformArch: 'win32-x64', exe: 'tg-hook.exe', format: 'pe', machine: 0x8664 }),
  Object.freeze({ triple: 'aarch64-pc-windows-msvc', platformArch: 'win32-arm64', exe: 'tg-hook.exe', format: 'pe', machine: 0xaa64 }),
  Object.freeze({ triple: 'x86_64-unknown-linux-musl', platformArch: 'linux-x64', exe: 'tg-hook', format: 'elf', machine: 62 }),
  Object.freeze({ triple: 'aarch64-unknown-linux-musl', platformArch: 'linux-arm64', exe: 'tg-hook', format: 'elf', machine: 183 }),
])

// Microsoft PE/COFF specification (https://learn.microsoft.com/en-us/windows/win32/debug/pe-format): the Certificate Table is data directory 4, and unlike every other directory its address is a file offset, not an RVA. Each entry is a WIN_CERTIFICATE; Authenticode uses revision 2.0 and type PKCS_SIGNED_DATA.
const CERTIFICATE_TABLE = 4
const WIN_CERT_REVISION_2_0 = 0x0200
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 0x0002

/** Why `buf` is not a signed PE for `machine`, or undefined when its certificate table ends the file and holds a PKCS#7 WIN_CERTIFICATE whose signed Authenticode image digest is the digest of `buf` itself. */
export function peSignatureProblem(buf, machine) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return 'is not a PE file (no MZ header)'
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return 'is not a PE file (no PE signature where the MZ header points)'
  const declared = buf.readUInt16LE(pe + 4)
  if (declared !== machine) return `declares machine 0x${declared.toString(16)}, expected 0x${machine.toString(16)}`
  const optionalSize = buf.readUInt16LE(pe + 20)
  const optional = pe + 24
  if (optionalSize < 2 || optional + optionalSize > buf.length) return 'has a truncated optional header'
  const magic = buf.readUInt16LE(optional)
  // PE32+ puts NumberOfRvaAndSizes at 108 and the directories at 112; PE32 at 92 and 96.
  const [countAt, dirsAt] = magic === 0x20b ? [108, 112] : magic === 0x10b ? [92, 96] : [undefined, undefined]
  if (countAt === undefined) return `has an unknown optional header magic 0x${magic.toString(16)}`
  const entry = dirsAt + CERTIFICATE_TABLE * 8
  if (optionalSize < entry + 8 || buf.readUInt32LE(optional + countAt) <= CERTIFICATE_TABLE) return 'has no certificate table directory, so it carries no Authenticode signature'
  const offset = buf.readUInt32LE(optional + entry)
  const size = buf.readUInt32LE(optional + entry + 4)
  if (offset === 0 && size === 0) return 'carries no Authenticode signature (its certificate table is empty)'
  if (size < 8 || offset + size > buf.length) return `has a certificate table (offset ${offset}, size ${size}) that does not fit in the file`
  const length = buf.readUInt32LE(offset)
  if (length < 9 || length > size) return `has a WIN_CERTIFICATE whose length ${length} does not fit its table of ${size} bytes`
  // The table's size sits in the directory entry, which the image digest skips, so a table grown past its one WIN_CERTIFICATE and its quadword padding would carry appended bytes the signature does not cover.
  if (size !== length && size !== ((length + 7) & ~7)) return `has ${size - length} bytes in its certificate table beyond its WIN_CERTIFICATE, which the signature does not cover`
  if (buf.readUInt16LE(offset + 4) !== WIN_CERT_REVISION_2_0) return 'has a WIN_CERTIFICATE that is not revision 2.0'
  if (buf.readUInt16LE(offset + 6) !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) return 'has a WIN_CERTIFICATE that is not PKCS#7 signed data'
  // RFC 5652 ContentInfo: SEQUENCE { contentType OID signedData, [0] EXPLICIT SignedData SEQUENCE }; each element must fit inside the one that holds it.
  const contentInfo = derElement(buf, offset + 8, offset + length)
  if (contentInfo?.tag !== 0x30) return 'has a WIN_CERTIFICATE whose content is not a DER SEQUENCE that fits it'
  const contentType = derElement(buf, contentInfo.start, contentInfo.end)
  if (contentType?.tag !== 0x06 || !buf.subarray(contentType.start, contentType.end).equals(OID_PKCS7_SIGNED_DATA)) return 'has a WIN_CERTIFICATE whose ContentInfo is not PKCS#7 signedData'
  const explicit = derElement(buf, contentType.end, contentInfo.end)
  const signedData = explicit?.tag === 0xa0 ? derElement(buf, explicit.start, explicit.end) : undefined
  if (signedData?.tag !== 0x30) return 'has a WIN_CERTIFICATE whose signedData content is missing or truncated'
  // The signature covers the image, not the WIN_CERTIFICATE around it, so bytes after the DER (the CVE-2013-3900 shape) are refused unless they are the at most 7 zero bytes signers pad to a quadword with.
  if (explicit.end !== contentInfo.end || signedData.end !== explicit.end) return 'has a WIN_CERTIFICATE whose ContentInfo holds bytes after its signedData, which the signature does not cover'
  if (!derTiles(buf, contentInfo)) return 'has a WIN_CERTIFICATE whose DER is malformed: a constructed element holds bytes that are not whole elements, or nests past 64 levels'
  const tail = offset + size - contentInfo.end
  if (tail > 7) return `has ${tail} bytes in its certificate table after its signature, which the signature does not cover`
  if (buf.subarray(contentInfo.end, offset + size).some((b) => b !== 0)) return 'pads its signature with non-zero bytes, which the signature does not cover'
  if (offset + size !== buf.length) return 'has data after its certificate table, which the signature does not cover'
  const signed = signedImageDigest(buf, signedData)
  if (typeof signed === 'string') return `has a WIN_CERTIFICATE whose signedData ${signed}`
  const actual = authenticodeDigest(buf, signed.algorithm, optional + 64, optional + entry, offset)
  if (!actual.equals(signed.digest)) return 'has an Authenticode signature whose image digest does not match the file, so the signature belongs to other bytes'
  return undefined
}

/** The image digest a SignedData SEQUENCE signs, per RFC 5652 and the Authenticode PE specification: SignedData { version, digestAlgorithms SET, encapContentInfo { SPC_INDIRECT_DATA OID, [0] SpcIndirectDataContent { data, DigestInfo { AlgorithmIdentifier { OID, NULL? }, OCTET STRING } } }, [0] certificates?, [1] crls?, signerInfos SET { SignerInfo } }, each holding exactly those elements in that order, so no element carries one the shape leaves out. A string says what does not match. Authenticode allows one signer, a SignerInfo { version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature, [1] unsignedAttrs? }; a second signature nests inside the first's unsigned attributes. */
function signedImageDigest(buf, signedData) {
  const parts = derChildren(buf, signedData) ?? []
  const tags = derTags(parts)
  const head = /^02 31 30( a0)?( a1)? 31/.exec(tags)
  if (head === null) return 'is not version, digest algorithms, content, optional certificates and CRLs, then signers'
  if (head[0].length !== tags.length) return 'holds bytes after its signers, which the signature does not cover'
  if (!/^0[1345]$/.test(buf.subarray(parts[0].start, parts[0].end).toString('hex'))) return 'has a version that is not one of the four RFC 5652 gives SignedData'
  const encap = derShaped(buf, parts[2], /^06 a0$/)
  if (encap === undefined) return 'has encapsulated content that is not exactly a content type and one [0] content'
  if (!buf.subarray(encap[0].start, encap[0].end).equals(OID_SPC_INDIRECT_DATA)) return 'does not sign Authenticode indirect data'
  const [indirect] = derShaped(buf, encap[1], /^30$/) ?? []
  const [, digestInfo] = (indirect && derShaped(buf, indirect, /^30 30$/)) ?? []
  const [algorithmId, digest] = (digestInfo && derShaped(buf, digestInfo, /^30 04$/)) ?? []
  const [algorithmOid] = (algorithmId && derShaped(buf, algorithmId, /^06( 05)?$/)) ?? []
  if (algorithmOid === undefined) return 'carries no image digest as one SpcIndirectDataContent of data and a DigestInfo'
  const algorithm = DIGEST_ALGORITHMS.get(buf.subarray(algorithmOid.start, algorithmOid.end).toString('hex'))
  if (algorithm === undefined) return 'uses an image digest algorithm this check does not know'
  const signers = derChildren(buf, parts[parts.length - 1]) ?? []
  if (signers.length === 0) return 'has no signer'
  if (signers.length > 1) return `has ${signers.length} signers where Authenticode allows one`
  const signer = signers[0].tag === 0x30 ? derShaped(buf, signers[0], /^02 (30|80) 30 a0 30 04( a1)?$/) : undefined
  if (signer === undefined) return 'has a signer that is not version, signer identifier, digest algorithm, signed attributes, signature algorithm, signature and optional unsigned attributes'
  if (buf.subarray(signer[0].start, signer[0].end).toString('hex') !== (signer[1].tag === 0x30 ? '01' : '03')) return 'has a signer whose version is not 1 for an issuer and serial number or 3 for a key identifier'
  return { algorithm, digest: buf.subarray(digest.start, digest.end) }
}

/** The Authenticode image hash of `buf`: every byte before the certificate table except the CheckSum field and the Certificate Table directory entry. This is the specification's section-by-section hash for an image whose headers and sections are contiguous, which is how linkers lay them out and how signing tools hash them. */
function authenticodeDigest(buf, algorithm, checksumAt, entryAt, tableAt) {
  return createHash(algorithm)
    .update(buf.subarray(0, checksumAt))
    .update(buf.subarray(checksumAt + 4, entryAt))
    .update(buf.subarray(entryAt + 8, tableAt))
    .digest()
}

// 1.2.840.113549.1.7.2, the PKCS#7 signedData content type, as DER OID content bytes.
const OID_PKCS7_SIGNED_DATA = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02])
// 1.3.6.1.4.1.311.2.1.4, SPC_INDIRECT_DATA_OBJID, the content type an Authenticode signature signs.
const OID_SPC_INDIRECT_DATA = Buffer.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04])
// Digest algorithm OIDs (RFC 3279 for SHA-1, RFC 5754 for the SHA-2 family) as DER content hex, to Node hash names.
const DIGEST_ALGORITHMS = new Map([
  ['2b0e03021a', 'sha1'],
  ['608648016503040201', 'sha256'],
  ['608648016503040202', 'sha384'],
  ['608648016503040203', 'sha512'],
])

/** The DER element (X.690) whose identifier octets start at `at`: its first identifier octet as `tag`, and where its content starts and ends. Undefined when the header or the content runs past `limit`, the length is the indefinite form DER forbids, or a high tag number runs past four octets. */
function derElement(buf, at, limit) {
  let header = at + 1
  // Tag number bits all set mean the number follows in base-128 octets, the last with bit 8 clear.
  if (at < limit && (buf[at] & 0x1f) === 0x1f) {
    while (header < limit && header - at <= 4 && buf[header] & 0x80) header++
    if (++header - at > 5) return undefined
  }
  if (header + 1 > limit) return undefined
  const first = buf[header]
  let start = header + 1
  let len = first
  if (first >= 0x80) {
    const octets = first & 0x7f
    if (octets === 0 || octets > 4 || start + octets > limit) return undefined
    len = buf.readUIntBE(start, octets)
    start += octets
  }
  return start + len > limit ? undefined : { tag: buf[at], start, end: start + len }
}

/** The elements `parent`'s content holds, or undefined when they do not tile it exactly: X.690 makes a constructed element's content whole elements, so a gap or an overrun is bytes no element accounts for. */
function derChildren(buf, parent) {
  const children = []
  for (let at = parent.start; at < parent.end; at = children[children.length - 1].end) {
    const child = derElement(buf, at, parent.end)
    if (child === undefined) return undefined
    children.push(child)
  }
  return children
}

/** Whether every constructed element within `element`, itself included, holds whole elements and nothing else, nesting no deeper than 64 levels. Primitive content is opaque bytes, so only constructed content is walked. */
function derTiles(buf, element, depth = 0) {
  if ((element.tag & 0x20) === 0) return true
  if (depth >= 64) return false
  const children = derChildren(buf, element)
  return children !== undefined && children.every((child) => derTiles(buf, child, depth + 1))
}

/** `parent`'s children when their tags, as derTags lays them out, match `shape`; undefined otherwise. */
function derShaped(buf, parent, shape) {
  const children = derChildren(buf, parent)
  return children !== undefined && shape.test(derTags(children)) ? children : undefined
}

/** The first identifier octet of each of `elements`, as two-digit hex joined by spaces, the form the shape patterns match. */
function derTags(elements) {
  return elements.map((element) => element.tag.toString(16).padStart(2, '0')).join(' ')
}

/** Why `buf` is not a static 64-bit little-endian ELF executable for `machine`, or undefined when it is. Header layout per the System V ABI (elf(5)): e_machine at 18, e_phoff at 32, e_phentsize and e_phnum at 54 and 56. A program header of type PT_INTERP (3) names a dynamic loader, which a musl-static build does not have and a glibc build does; a DT_NEEDED entry in the dynamic segment names a shared library, which a static-pie build does not have either. A PT_LOAD (1) segment's file bytes (p_offset at 8, p_filesz at 32) must lie inside the file, and at least one must carry PF_X (p_flags at 4), so a header with nothing to run behind it is refused. */
export function elfProblem(buf, machine) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return 'is not an ELF file'
  if (buf[4] !== 2 || buf[5] !== 1) return 'is not a 64-bit little-endian ELF file'
  const declared = buf.readUInt16LE(18)
  if (declared !== machine) return `declares machine ${declared}, expected ${machine}`
  const type = buf.readUInt16LE(16)
  if (type !== ET_EXEC && type !== ET_DYN) return `is not an executable (e_type ${type})`
  const phoff = Number(buf.readBigUInt64LE(32))
  const phentsize = buf.readUInt16LE(54)
  const phnum = buf.readUInt16LE(56)
  if (phentsize < ELF64_PHDR_SIZE || phoff + phentsize * phnum > buf.length) return 'has program headers that do not fit in the file'
  const dynamicSegments = []
  let executable = false
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize
    const segment = buf.readUInt32LE(at)
    if (segment === PT_INTERP) return 'is dynamically linked (it names an ELF interpreter); the release ships musl-static binaries only'
    if (segment === PT_DYNAMIC) dynamicSegments.push(at)
    if (segment !== PT_LOAD) continue
    if (Number(buf.readBigUInt64LE(at + 8)) + Number(buf.readBigUInt64LE(at + 32)) > buf.length) return 'has a loadable segment that does not fit in the file'
    if ((buf.readUInt32LE(at + 4) & PF_X) !== 0) executable = true
  }
  if (!executable) return 'has no executable loadable segment, so it holds no code to run'
  // A static-pie has a PT_DYNAMIC segment for its own relocations but no DT_NEEDED entry; a DT_NEEDED names a shared library some loader would have to supply. Entries are 16 bytes (d_tag, d_val), ending at DT_NULL.
  for (const at of dynamicSegments) {
    const start = Number(buf.readBigUInt64LE(at + 8))
    const end = start + Number(buf.readBigUInt64LE(at + 32))
    if (end > buf.length) return 'has a dynamic segment that does not fit in the file'
    for (let entry = start; entry + 16 <= end; entry += 16) {
      const tag = buf.readBigInt64LE(entry)
      if (tag === DT_NULL) break
      if (tag === DT_NEEDED) return 'is dynamically linked (it needs a shared library); the release ships musl-static binaries only'
    }
  }
  return undefined
}

// elf(5): e_type values, program header types, the execute permission flag, the dynamic tags read above, and the size of an Elf64_Phdr.
const ET_EXEC = 2
const ET_DYN = 3
const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_INTERP = 3
const PF_X = 1
const DT_NULL = 0n
const DT_NEEDED = 1n
const ELF64_PHDR_SIZE = 56

/** `sha256sum` output (text or binary mode) as a map from relative path to lowercase hex digest. A line that is not a digest and a path is a problem, not something to skip. */
export function parseManifest(text, label = 'manifest') {
  const entries = new Map()
  const problems = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line)
    if (m === null) {
      problems.push(`${label}: not a sha256sum line: ${JSON.stringify(line)}`)
      continue
    }
    const rel = m[2].replace(/\\/g, '/').replace(/^\.\//, '')
    if (entries.has(rel)) problems.push(`${label}: lists ${rel} twice`)
    entries.set(rel, m[1].toLowerCase())
  }
  return { entries, problems }
}

function filesUnder(dir) {
  const out = []
  const walk = (at) => {
    for (const entry of readdirSync(path.join(dir, at), { withFileTypes: true })) {
      const rel = at === '' ? entry.name : `${at}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

const targetPath = (t) => `${t.platformArch}/${t.exe}`

/** The targets a release ships: all of them, or only the Linux ones when there is no Windows signing configuration, since a Windows binary ships signed or not at all. */
export const releaseTargets = (withoutWindows = false) => (withoutWindows ? NATIVE_TARGETS.filter((t) => t.format !== 'pe') : NATIVE_TARGETS)

const UNSIGNED_RELEASE = 'Windows binaries ship only signed, and this release has no Windows signing configuration'

/** Every reason `dir` must not be published, given the manifests' text keyed by a label for messages. Empty when the directory holds exactly the release binaries, each matching exactly one manifest entry and, for Windows, signed. */
export function verifyNativeDist(dir, manifests, { withoutWindows = false } = {}) {
  const problems = []
  const expected = new Map(releaseTargets(withoutWindows).map((t) => [targetPath(t), t]))
  const windows = new Set(NATIVE_TARGETS.filter((t) => t.format === 'pe').map(targetPath))
  const hashes = new Map()
  for (const [label, text] of Object.entries(manifests)) {
    const parsed = parseManifest(text, label)
    problems.push(...parsed.problems)
    for (const [rel, digest] of parsed.entries) {
      if (!expected.has(rel)) problems.push(`${label}: lists ${rel}, which is not a release binary`)
      else if (hashes.has(rel)) problems.push(`${rel}: listed by more than one manifest`)
      else hashes.set(rel, digest)
    }
  }
  let present
  try {
    present = filesUnder(dir)
  } catch (e) {
    return [...problems, `${dir}: cannot be read (${e instanceof Error ? e.message : String(e)})`]
  }
  for (const rel of present) {
    if (expected.has(rel)) continue
    problems.push(withoutWindows && windows.has(rel) ? `${rel}: ${UNSIGNED_RELEASE}` : `${rel}: is not a release binary; dist/native must hold the release artifacts and nothing else`)
  }
  for (const [rel, target] of expected) {
    if (!present.includes(rel)) {
      problems.push(`${rel}: missing`)
      continue
    }
    const read = readBinary(dir, rel)
    if (typeof read === 'string') {
      problems.push(`${rel}: ${read}`)
      continue
    }
    const want = hashes.get(rel)
    const got = createHash('sha256').update(read).digest('hex')
    if (want === undefined) problems.push(`${rel}: no manifest records its sha256`)
    else if (want !== got) problems.push(`${rel}: sha256 ${got} does not match the recorded ${want}`)
    const shape = shapeProblem(read, target)
    if (shape !== undefined) problems.push(`${rel}: ${shape}`)
  }
  return problems
}

/** The bytes of `dir/rel`, or why they cannot be read: a dangling link or a link to a directory is listed as a file but has none. */
function readBinary(dir, rel) {
  try {
    return readFileSync(path.join(dir, rel))
  } catch (e) {
    return `cannot be read (${e instanceof Error ? e.message : String(e)})`
  }
}

const shapeProblem = (buf, target) => (target.format === 'pe' ? peSignatureProblem(buf, target.machine) : elfProblem(buf, target.machine))

const PACK_REMEDY = 'delete dist/native, or publish through the release workflow, which signs it'

/** Every reason a publish from a working tree must not pack `dir`. A missing directory is the supported state, since the Node hook serves every platform without it; anything present must be a release target in its release shape, so a local `npm run build:native` output, an unsigned Windows build above all, never reaches the registry. No manifest exists here, so this checks shape, not provenance. */
export function verifyPackDir(dir) {
  let present
  try {
    present = filesUnder(dir)
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return []
    return [`${dir}: cannot be read (${e instanceof Error ? e.message : String(e)})`]
  }
  const targets = new Map(NATIVE_TARGETS.map((t) => [targetPath(t), t]))
  const problems = []
  for (const rel of present) {
    const target = targets.get(rel)
    if (target === undefined) {
      problems.push(`${rel}: is not a release binary; ${PACK_REMEDY}`)
      continue
    }
    const read = readBinary(dir, rel)
    const shape = typeof read === 'string' ? read : shapeProblem(read, target)
    if (shape !== undefined) problems.push(`${rel}: ${shape}; ${PACK_REMEDY}`)
  }
  return problems
}

const USAGE = 'usage: node scripts/verify-native-dist.mjs [--without-windows] <dist/native> <SHA256SUMS>...\n       node scripts/verify-native-dist.mjs --pack <dist/native>\n'

function refuse(problems) {
  for (const p of problems) process.stderr.write(`verify-native-dist: ${p}\n`)
  process.stderr.write('verify-native-dist: refusing to publish\n')
  return 1
}

function main(argv) {
  if (argv[0] === '--pack') {
    if (argv.length !== 2) {
      process.stderr.write(USAGE)
      return 2
    }
    const problems = verifyPackDir(argv[1])
    if (problems.length > 0) return refuse(problems)
    process.stdout.write(`verify-native-dist: ${argv[1]} holds no unsigned or unexpected native binary\n`)
    return 0
  }
  const withoutWindows = argv[0] === '--without-windows'
  const [dir, ...manifestPaths] = withoutWindows ? argv.slice(1) : argv
  if (dir === undefined || dir.startsWith('--') || manifestPaths.length === 0) {
    process.stderr.write(USAGE)
    return 2
  }
  const manifests = {}
  for (const file of manifestPaths) {
    try {
      manifests[file] = readFileSync(file, 'utf8')
    } catch (e) {
      process.stderr.write(`verify-native-dist: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`)
      return 1
    }
  }
  const problems = verifyNativeDist(dir, manifests, { withoutWindows })
  if (problems.length > 0) return refuse(problems)
  const note = withoutWindows ? ' (no Windows binaries: Windows installs keep the Node hook)' : ''
  process.stdout.write(`verify-native-dist: ${releaseTargets(withoutWindows).length} native binaries verified${note}\n`)
  return 0
}

// Node resolves symlinks in the module URL but not in argv[1], so both sides are resolved: comparing the raw path let a run through a linked directory (an npm link or a global install of a checkout) skip the check and exit 0.
const realOrResolved = (p) => {
  try {
    return realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
