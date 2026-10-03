#!/usr/bin/env node
/** The publish gate for the native hook client: refuses a dist/native that is not exactly the four release binaries, each byte-identical to the hash its producing job recorded, with both Windows files carrying an Authenticode signature. Run by the publish job of .github/workflows/publish.yml, which holds the registry token, so it imports nothing but Node builtins: no dependency code runs beside the credential. The signature check is structural (the PE certificate table is present and holds a PKCS#7 WIN_CERTIFICATE); the sign job has already verified the signature cryptographically, and the hash match is what ties the file here to the file it verified. Usage: `node scripts/verify-native-dist.mjs [--without-windows] <dist/native> <SHA256SUMS>...`, where every manifest is in `sha256sum` format with paths relative to the directory; `--without-windows` is the release with no Windows signing configuration, which ships the two Linux binaries and no Windows one, so Windows installs keep the Node hook. `node scripts/verify-native-dist.mjs --pack <dist/native>` is the prepublishOnly check for a publish from a working tree: no manifests, so it checks shape only, and a missing directory passes. Exits 0 when everything holds, otherwise 1 with one line per problem. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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

/** Why `buf` is not a signed PE for `machine`, or undefined when its certificate table holds a well-formed PKCS#7 WIN_CERTIFICATE. */
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
  if (buf.readUInt16LE(offset + 4) !== WIN_CERT_REVISION_2_0) return 'has a WIN_CERTIFICATE that is not revision 2.0'
  if (buf.readUInt16LE(offset + 6) !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) return 'has a WIN_CERTIFICATE that is not PKCS#7 signed data'
  // A PKCS#7 ContentInfo is a DER SEQUENCE.
  if (buf[offset + 8] !== 0x30) return 'has a WIN_CERTIFICATE whose content is not DER'
  return undefined
}

/** Why `buf` is not a static 64-bit little-endian ELF executable for `machine`, or undefined when it is. Header layout per the System V ABI (elf(5)): e_machine at 18, e_phoff at 32, e_phentsize and e_phnum at 54 and 56. A program header of type PT_INTERP (3) names a dynamic loader, which a musl-static build does not have and a glibc build does. */
export function elfProblem(buf, machine) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return 'is not an ELF file'
  if (buf[4] !== 2 || buf[5] !== 1) return 'is not a 64-bit little-endian ELF file'
  const declared = buf.readUInt16LE(18)
  if (declared !== machine) return `declares machine ${declared}, expected ${machine}`
  const phoff = Number(buf.readBigUInt64LE(32))
  const phentsize = buf.readUInt16LE(54)
  const phnum = buf.readUInt16LE(56)
  if (phentsize < 4 || phoff + phentsize * phnum > buf.length) return 'has program headers that do not fit in the file'
  for (let i = 0; i < phnum; i++) {
    if (buf.readUInt32LE(phoff + i * phentsize) === 3) return 'is dynamically linked (it names an ELF interpreter); the release ships musl-static binaries only'
  }
  return undefined
}

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
    const buf = readFileSync(path.join(dir, rel))
    const want = hashes.get(rel)
    const got = createHash('sha256').update(buf).digest('hex')
    if (want === undefined) problems.push(`${rel}: no manifest records its sha256`)
    else if (want !== got) problems.push(`${rel}: sha256 ${got} does not match the recorded ${want}`)
    const shape = target.format === 'pe' ? peSignatureProblem(buf, target.machine) : elfProblem(buf, target.machine)
    if (shape !== undefined) problems.push(`${rel}: ${shape}`)
  }
  return problems
}

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
    const buf = readFileSync(path.join(dir, rel))
    const shape = target.format === 'pe' ? peSignatureProblem(buf, target.machine) : elfProblem(buf, target.machine)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))
