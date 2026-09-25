/** The release path for the native hook client in .github/workflows/publish.yml: four binaries built in jobs that hold no secret, the two Windows ones Authenticode-signed in a job that runs no repository or dependency code and is the only reader of the signing credentials, the two Linux ones given build provenance, and a publish job that rebuilds dist/native from those artifacts alone and runs a gate that refuses anything unsigned or substituted before `npm publish`. Each property is a check that returns its problems, run twice: on the workflow as committed, where it must find none, and on a copy mutated in memory to break exactly that property, where it must name the break, so no check can pass by reading nothing. Provenance: CAPTURE, parsed from `.github/workflows/publish.yml` itself, the file GitHub executes; the mutations are HAND-DERIVED edits of that parse. The target list is compared against scripts/verify-native-dist.mjs and src/native_hook.ts, the two places the release and the installer name it. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { NATIVE_TARGETS } from '../../scripts/verify-native-dist.mjs'
import { ROOT } from '../helpers/bundle.js'

interface Step {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, string>
  env?: Record<string, string>
}

interface Job {
  needs?: string | string[]
  environment?: string | { name: string }
  permissions?: Record<string, string>
  env?: Record<string, string>
  strategy?: { matrix?: { include?: Record<string, string>[] } }
  steps: Step[]
}

interface Workflow {
  jobs: Record<string, Job>
}

const SIGN_JOB = 'sign-windows'
const ATTEST_JOB = 'attest-linux'
const PUBLISH_JOB = 'publish'
const BUILD_JOB = 'native'

const real = (): Workflow => yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8')) as Workflow

function job(doc: Workflow, name: string): Job {
  const found = doc.jobs[name]
  expect(found, `publish.yml has no ${name} job, so the checks below would read nothing`).toBeDefined()
  expect(found!.steps.length, `the ${name} job parsed with no steps`).toBeGreaterThan(0)
  return found!
}

const environmentName = (j: Job): string | undefined => (typeof j.environment === 'string' ? j.environment : j.environment?.name)
const secretsIn = (value: unknown): string[] => [...new Set([...JSON.stringify(value).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]!))].sort()

/** The job that holds the signing credentials checks out nothing, sets up no language runtime, and runs no package manager, compiler, or script from the repository: it only downloads the build jobs' artifacts, signs, verifies, and uploads. */
function signJobRunsNoProjectCode(doc: Workflow): string[] {
  const problems: string[] = []
  for (const step of job(doc, SIGN_JOB).steps) {
    const label = step.name ?? step.uses ?? '(unnamed step)'
    if (step.uses !== undefined && !/^actions\/(download|upload)-artifact@/.test(step.uses)) problems.push(`${label}: uses ${step.uses}; the sign job may only move artifacts`)
    const tool = /(?:^|[\s;&|(`$])(npm|npx|node|cargo|rustup|yarn|pnpm|pip|python3?)\b/m.exec(step.run ?? '')
    if (tool !== null) problems.push(`${label}: runs ${tool[1]}`)
  }
  return problems
}

/** Every secret the sign job reads is read by no other job, and it reads them through the `signing` environment, which no other job uses. The build jobs read no secret at all, and the publish job reads only the registry token. */
function signingSecretsStayInTheSignJob(doc: Workflow): string[] {
  const problems: string[] = []
  const sign = job(doc, SIGN_JOB)
  const signing = secretsIn(sign)
  if (signing.length === 0) problems.push(`${SIGN_JOB} reads no secret, so this check has nothing to hold`)
  if (environmentName(sign) !== 'signing') problems.push(`${SIGN_JOB} does not run in the signing environment`)
  const { jobs, ...rest } = doc
  if (secretsIn(rest).length > 0) problems.push(`the workflow reads ${secretsIn(rest).join(', ')} outside any job`)
  for (const [name, other] of Object.entries(jobs)) {
    if (name === SIGN_JOB) continue
    if (environmentName(other) === 'signing') problems.push(`${name} runs in the signing environment`)
    const allowed = name === PUBLISH_JOB ? ['NPM_TOKEN'] : []
    for (const secret of secretsIn(other)) if (!allowed.includes(secret)) problems.push(`${name} reads secrets.${secret}`)
  }
  return problems
}

/** Every file a job downloads with curl is checked against a sha256 pinned in the job's env before anything else touches it, and comes from a versioned https URL. */
function downloadsAreHashPinned(doc: Workflow): string[] {
  const problems: string[] = []
  let downloads = 0
  for (const [name, j] of Object.entries(doc.jobs)) {
    for (const step of j.steps) {
      const lines = (step.run ?? '').split('\n')
      lines.forEach((line, i) => {
        if (!/\b(curl|wget)\b/.test(line)) return
        const m = /\bcurl\b[^\n]*\s-o\s+"([^"]+)"\s+"\$(\w+)"\s*$/.exec(line)
        if (m === null) {
          problems.push(`${name}: cannot tell what this download writes or where it comes from: ${line.trim()}`)
          return
        }
        downloads++
        const [, file, urlVar] = m as unknown as [string, string, string]
        const url = { ...j.env, ...step.env }[urlVar] ?? ''
        if (!/^https:\/\/\S+\/[^/]*\d[^/]*$/.test(url) || /latest/.test(url)) problems.push(`${name}: ${urlVar} is not a versioned https URL: ${JSON.stringify(url)}`)
        const next = lines.slice(i + 1).find((l) => l.includes(file))
        const check = next === undefined ? null : /^\s*echo "\$(\w+) {2}(.+)" \| sha256sum -c -\s*$/.exec(next)
        if (check === null || check[2] !== file) {
          problems.push(`${name}: ${file} is not checked against a pinned sha256 before its next use`)
          return
        }
        const pin = { ...j.env, ...step.env }[check[1]!] ?? ''
        if (!/^[0-9a-f]{64}$/.test(pin)) problems.push(`${name}: ${check[1]} is not a sha256: ${JSON.stringify(pin)}`)
      })
    }
  }
  if (downloads < 2) problems.push(`found ${downloads} pinned downloads; the sign job fetches jsign and osslsigncode`)
  return problems
}

/** Every action the workflow runs is pinned to a full commit SHA, so a moved tag cannot change what runs beside the credentials. */
function actionsArePinnedToCommits(doc: Workflow): string[] {
  const problems: string[] = []
  for (const [name, j] of Object.entries(doc.jobs)) {
    for (const step of j.steps) if (step.uses !== undefined && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(step.uses)) problems.push(`${name}: ${step.uses} is not pinned to a commit SHA`)
  }
  return problems
}

/** Only the Linux attestation job may write attestations, and it attests both Linux binaries. */
function attestationCoversLinuxOnly(doc: Workflow): string[] {
  const problems: string[] = []
  for (const [name, j] of Object.entries(doc.jobs)) if (j.permissions?.['attestations'] === 'write' && name !== ATTEST_JOB) problems.push(`${name} is granted attestations: write`)
  const attest = job(doc, ATTEST_JOB)
  if (attest.permissions?.['attestations'] !== 'write' || attest.permissions['id-token'] !== 'write') problems.push(`${ATTEST_JOB} lacks the id-token and attestations grants attesting needs`)
  const step = attest.steps.find((s) => s.uses?.startsWith('actions/attest-build-provenance@'))
  const subjects = (step?.with?.['subject-path'] ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  for (const binary of ['native/linux-x64/tg-hook', 'native/linux-arm64/tg-hook']) if (!subjects.includes(binary)) problems.push(`${ATTEST_JOB} does not attest ${binary}`)
  return problems
}

/** The publish job rebuilds dist/native from the release artifacts only: it deletes the bundle's copy (which holds the build job's glibc test binary) before copying anything in, takes the Windows binaries from the signed artifact rather than the unsigned ones, and waits for the sign and attest jobs. */
function publishAssemblesFromReleaseArtifacts(doc: Workflow): string[] {
  const problems: string[] = []
  const publish = job(doc, PUBLISH_JOB)
  const needs = [publish.needs ?? []].flat()
  for (const upstream of [BUILD_JOB, SIGN_JOB, ATTEST_JOB]) if (!needs.includes(upstream)) problems.push(`${PUBLISH_JOB} does not need ${upstream}`)
  const downloaded = publish.steps.filter((s) => s.uses?.startsWith('actions/download-artifact@')).map((s) => s.with?.['name'])
  for (const unsigned of ['native-win32-x64', 'native-win32-arm64']) if (downloaded.includes(unsigned)) problems.push(`${PUBLISH_JOB} downloads the unsigned ${unsigned} artifact`)
  if (!downloaded.includes('native-windows-signed')) problems.push(`${PUBLISH_JOB} does not download the signed Windows binaries`)
  const bundleAt = publish.steps.findIndex((s) => s.with?.['name'] === 'dist')
  const writers = publish.steps.map((s, i) => [s, i] as const).filter(([s]) => /\bdist\/native\b/.test(s.run ?? '') && !/verify-native-dist\.mjs/.test(s.run ?? ''))
  if (writers.length !== 1) problems.push(`${PUBLISH_JOB} has ${writers.length} steps writing dist/native; expected one assembly step`)
  for (const [step, i] of writers) {
    const first = (step.run ?? '').split('\n').find((l) => /\bdist\/native\b/.test(l))
    if (first?.trim() !== 'rm -rf dist/native') problems.push(`${step.name ?? 'assembly'}: touches dist/native before deleting it: ${first?.trim()}`)
    if (i < bundleAt) problems.push(`${step.name ?? 'assembly'}: runs before the bundle download, which would put the bundle's dist/native back`)
  }
  return problems
}

/** The verify gate runs in the publish job after assembly and before `npm publish`, over dist/native and the manifest of every job that produced a binary. */
function publishVerifiesBeforePublishing(doc: Workflow): string[] {
  const problems: string[] = []
  const steps = job(doc, PUBLISH_JOB).steps
  const gate = steps.findIndex((s) => /^node scripts\/verify-native-dist\.mjs dist\/native /.test(s.run ?? ''))
  const publish = steps.findIndex((s) => /\bnpm publish\b/.test(s.run ?? ''))
  const assembly = steps.findIndex((s) => /^\s*rm -rf dist\/native\s*$/m.test(s.run ?? ''))
  if (publish < 0) problems.push(`${PUBLISH_JOB} has no npm publish step`)
  if (gate < 0) problems.push(`${PUBLISH_JOB} never runs scripts/verify-native-dist.mjs over dist/native`)
  else {
    if (publish >= 0 && gate > publish) problems.push('scripts/verify-native-dist.mjs runs after npm publish')
    if (gate < assembly) problems.push('scripts/verify-native-dist.mjs runs before dist/native is assembled')
    for (const manifest of ['native-signed/SHA256SUMS', 'native/linux-x64.sha256', 'native/linux-arm64.sha256']) if (!steps[gate]!.run!.includes(manifest)) problems.push(`scripts/verify-native-dist.mjs is not given ${manifest}`)
  }
  return problems
}

/** The build matrix produces exactly the targets the publish gate expects and the installer looks for, each under the directory and file name the installer computes. */
function matrixMatchesTheShippedTargets(doc: Workflow): string[] {
  const include = job(doc, BUILD_JOB).strategy?.matrix?.include ?? []
  const built = include.map((e) => `${e['target']} -> ${e['platform-arch']}/${e['exe']}`).sort()
  const expected = NATIVE_TARGETS.map((t) => `${t.triple} -> ${t.platformArch}/${t.exe}`).sort()
  return JSON.stringify(built) === JSON.stringify(expected) ? [] : [`the ${BUILD_JOB} matrix builds ${built.join(', ')}; the release ships ${expected.join(', ')}`]
}

const CHECKS: ReadonlyArray<readonly [string, (doc: Workflow) => string[], (doc: Workflow) => void, string]> = [
  [
    'the sign job runs no npm, cargo, node, or repository code',
    signJobRunsNoProjectCode,
    (doc) => {
      doc.jobs[SIGN_JOB]!.steps.unshift({ uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' }, { name: 'Install', run: 'npm ci' })
    },
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1: uses actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1; the sign job may only move artifacts',
  ],
  [
    'the signing secrets are read by the sign job alone',
    signingSecretsStayInTheSignJob,
    (doc) => {
      doc.jobs[BUILD_JOB]!.env = { ...doc.jobs[BUILD_JOB]!.env, LEAK: '${{ secrets.DIGICERT_API_KEY }}' }
    },
    `${BUILD_JOB} reads secrets.DIGICERT_API_KEY`,
  ],
  [
    'every download is checked against a pinned sha256 before use',
    downloadsAreHashPinned,
    (doc) => {
      const install = doc.jobs[SIGN_JOB]!.steps.find((s) => s.name === 'Install jsign and osslsigncode')!
      install.run = install.run!.replace(/^.*jsign\.jar" \| sha256sum -c -\n/m, '')
    },
    `${SIGN_JOB}: $RUNNER_TEMP/jsign.jar is not checked against a pinned sha256 before its next use`,
  ],
  [
    'every action is pinned to a full commit SHA',
    actionsArePinnedToCommits,
    (doc) => {
      doc.jobs[ATTEST_JOB]!.steps.find((s) => s.uses?.startsWith('actions/attest-build-provenance@'))!.uses = 'actions/attest-build-provenance@v4'
    },
    `${ATTEST_JOB}: actions/attest-build-provenance@v4 is not pinned to a commit SHA`,
  ],
  [
    'only the Linux attestation job writes attestations, over both Linux binaries',
    attestationCoversLinuxOnly,
    (doc) => {
      doc.jobs[BUILD_JOB]!.permissions = { contents: 'read', attestations: 'write' }
    },
    `${BUILD_JOB} is granted attestations: write`,
  ],
  [
    'publish deletes dist/native before assembling it from the signed and attested artifacts',
    publishAssemblesFromReleaseArtifacts,
    (doc) => {
      const assembly = doc.jobs[PUBLISH_JOB]!.steps.find((s) => s.name === 'Assemble dist/native from the release artifacts')!
      assembly.run = assembly.run!.replace('rm -rf dist/native\n', '')
    },
    'Assemble dist/native from the release artifacts: touches dist/native before deleting it: mkdir -p dist/native/win32-x64 dist/native/win32-arm64 dist/native/linux-x64 dist/native/linux-arm64',
  ],
  [
    'publish runs the verify gate before npm publish',
    publishVerifiesBeforePublishing,
    (doc) => {
      const steps = doc.jobs[PUBLISH_JOB]!.steps
      const gate = steps.findIndex((s) => s.run?.startsWith('node scripts/verify-native-dist.mjs'))
      steps.push(...steps.splice(gate, 1))
    },
    'scripts/verify-native-dist.mjs runs after npm publish',
  ],
  [
    'the build matrix is exactly the shipped target list',
    matrixMatchesTheShippedTargets,
    (doc) => {
      doc.jobs[BUILD_JOB]!.strategy!.matrix!.include![3]!['target'] = 'aarch64-unknown-linux-gnu'
    },
    `the ${BUILD_JOB} matrix builds aarch64-pc-windows-msvc -> win32-arm64/tg-hook.exe, aarch64-unknown-linux-gnu -> linux-arm64/tg-hook, x86_64-pc-windows-msvc -> win32-x64/tg-hook.exe, x86_64-unknown-linux-musl -> linux-x64/tg-hook; the release ships aarch64-pc-windows-msvc -> win32-arm64/tg-hook.exe, aarch64-unknown-linux-musl -> linux-arm64/tg-hook, x86_64-pc-windows-msvc -> win32-x64/tg-hook.exe, x86_64-unknown-linux-musl -> linux-x64/tg-hook`,
  ],
]

describe('the native release in publish.yml', () => {
  for (const [title, check, mutate, expected] of CHECKS) {
    it(`${title}: holds on the committed workflow`, () => {
      expect(check(real())).toEqual([])
    })

    it(`${title}: names the break in a copy that violates it`, () => {
      const doc = real()
      mutate(doc)
      expect(check(doc)).toContain(expected)
    })
  }
})

describe('the release target list', () => {
  it('names the same four directories the installer looks in', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'native_hook.ts'), 'utf8')
    const literal = /const NATIVE_TARGETS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(source)
    expect(literal, 'src/native_hook.ts no longer declares NATIVE_TARGETS as a Set literal; update this reader').not.toBeNull()
    const installer = [...literal![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()
    expect(installer).toHaveLength(4)
    expect(NATIVE_TARGETS.map((t) => t.platformArch).sort()).toEqual(installer)
  })

  it('is the list the CI cross-target check compiles', () => {
    const ci = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) as Workflow
    const run = job(ci, 'native-targets').steps.map((s) => s.run ?? '').join('\n')
    const list = /^\s*targets=\(([^)]*)\)\s*$/m.exec(run)
    expect(list, 'the native-targets job no longer declares its targets as a bash array; update this reader').not.toBeNull()
    expect(list![1]!.trim().split(/\s+/).sort()).toEqual(NATIVE_TARGETS.map((t) => t.triple).sort())
  })
})

describe('the scripts the credential-holding and secret-free jobs run without npm ci', () => {
  // The publish job runs scripts/verify-native-dist.mjs beside the registry token, and the native build jobs run scripts/build-native.mjs, both without installing anything, so neither may import a package: only Node builtins and each other.
  for (const script of ['verify-native-dist.mjs', 'build-native.mjs']) {
    it(`${script} imports only Node builtins and sibling scripts`, () => {
      const source = fs.readFileSync(path.join(ROOT, 'scripts', script), 'utf8')
      const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!)
      expect(specifiers.length, `found no imports in ${script}, so this check read nothing`).toBeGreaterThan(0)
      expect(specifiers.filter((s) => !s.startsWith('node:') && s !== './verify-native-dist.mjs')).toEqual([])
    })
  }
})
