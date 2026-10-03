/** The release path for the native hook client in .github/workflows/publish.yml: four binaries built in jobs that hold no secret, the two Windows ones Authenticode-signed in a job that runs no repository or dependency code and is the only reader of the signing credentials, the two Linux ones given build provenance, and a publish job that rebuilds dist/native from those artifacts alone and runs a gate that refuses anything unsigned or substituted before `npm publish`. Each property is a check that returns its problems, run twice: on the workflow as committed, where it must find none, and on a copy mutated in memory to break exactly that property, where it must name the break, so no check can pass by reading nothing. Provenance: CAPTURE, parsed from `.github/workflows/publish.yml` itself, the file GitHub executes; the mutations are HAND-DERIVED edits of that parse. The target list is compared against scripts/verify-native-dist.mjs and src/native_hook.ts, the two places the release and the installer name it. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { NATIVE_TARGETS } from '../../scripts/verify-native-dist.mjs'
import { ROOT } from '../helpers/bundle.js'
import { HOOK_BASH } from '../helpers/hook-bash.js'

interface Step {
  name?: string
  id?: string
  if?: string
  'continue-on-error'?: boolean | string
  uses?: string
  run?: string
  shell?: string
  with?: Record<string, string>
  env?: Record<string, string>
}

interface Job {
  needs?: string | string[]
  environment?: string | { name: string }
  permissions?: Record<string, string>
  outputs?: Record<string, string>
  env?: Record<string, string>
  strategy?: { matrix?: { include?: Record<string, string>[] } }
  defaults?: { run?: { shell?: string } }
  steps: Step[]
}

interface Workflow {
  defaults?: { run?: { shell?: string } }
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

const GATE_LINE = /^\s*node scripts\/verify-native-dist\.mjs (--without-windows )?dist\/native /
const GATE_COMMAND = /^\s*node scripts\/verify-native-dist\.mjs (--without-windows )?dist\/native( "[^"]*")+\s*$/
const LINUX_MANIFESTS = ['native/linux-x64.sha256', 'native/linux-arm64.sha256']

/** The verify gate runs in the publish job after assembly and before `npm publish`, over dist/native and the manifest of every job that produced a binary: all three when Windows was signed, and the two Linux ones under --without-windows when it was not. */
function publishVerifiesBeforePublishing(doc: Workflow): string[] {
  const problems: string[] = []
  const steps = job(doc, PUBLISH_JOB).steps
  const gate = steps.findIndex((s) => (s.run ?? '').split('\n').some((l) => GATE_LINE.test(l)))
  const publish = steps.findIndex((s) => /\bnpm publish\b/.test(s.run ?? ''))
  const assembly = steps.findIndex((s) => /^\s*rm -rf dist\/native\s*$/m.test(s.run ?? ''))
  if (publish < 0) problems.push(`${PUBLISH_JOB} has no npm publish step`)
  if (gate < 0) problems.push(`${PUBLISH_JOB} never runs scripts/verify-native-dist.mjs over dist/native`)
  else {
    if (publish >= 0 && gate > publish) problems.push('scripts/verify-native-dist.mjs runs after npm publish')
    if (gate < assembly) problems.push('scripts/verify-native-dist.mjs runs before dist/native is assembled')
    // Ordering alone proves nothing if the gate step can be skipped or can fail without stopping the job: the publish step after it would still run.
    if (steps[gate]!.if !== undefined) problems.push(`the verify gate step is conditional (if: ${steps[gate]!.if}), so a run that skips it still publishes`)
    const lenient = steps[gate]!['continue-on-error']
    if (lenient !== undefined && lenient !== false) problems.push(`the verify gate step has continue-on-error: ${String(lenient)}, so a refusal does not stop npm publish`)
    // A refusal stops the step only if the shell exits on the first failing command and nothing after the gate's own arguments discards its status: `|| true`, a pipe into another command, or a `set +e` earlier in the script all let a refused build reach npm publish.
    const shell = steps[gate]!.shell ?? job(doc, PUBLISH_JOB).defaults?.run?.shell ?? doc.defaults?.run?.shell
    if (shell !== undefined && shell !== 'bash') problems.push(`the verify gate step runs under shell: ${shell}, not bash, so its set -euo pipefail does not apply`)
    const script = steps[gate]!.run!.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
    if (script[0] !== 'set -euo pipefail') problems.push(`the verify gate step does not start with set -euo pipefail, so a refusal can be ignored: ${script[0]}`)
    for (const line of script) if (/^set\s+\+[a-z]*e|^set\s+\+o\s+(errexit|pipefail)/.test(line)) problems.push(`the verify gate step turns failure handling off: ${line}`)
    for (const line of steps[gate]!.run!.split('\n').filter((l) => GATE_LINE.test(l))) if (!GATE_COMMAND.test(line)) problems.push(`scripts/verify-native-dist.mjs is followed by more than its arguments, which can discard its exit status: ${line.trim()}`)
    const runs = steps[gate]!.run!.split('\n').filter((l) => GATE_LINE.test(l))
    const signed = runs.find((l) => !l.includes('--without-windows'))
    const unsigned = runs.find((l) => l.includes('--without-windows'))
    if (signed === undefined) problems.push('scripts/verify-native-dist.mjs has no run for a release with signed Windows binaries')
    else for (const manifest of ['native-signed/SHA256SUMS', ...LINUX_MANIFESTS]) if (!signed.includes(manifest)) problems.push(`scripts/verify-native-dist.mjs is not given ${manifest}`)
    if (unsigned === undefined) problems.push('scripts/verify-native-dist.mjs has no --without-windows run for a release without signing')
    else {
      for (const manifest of LINUX_MANIFESTS) if (!unsigned.includes(manifest)) problems.push(`scripts/verify-native-dist.mjs --without-windows is not given ${manifest}`)
      if (unsigned.includes('native-signed')) problems.push('scripts/verify-native-dist.mjs --without-windows is given the signed Windows manifest')
    }
  }
  return problems
}

const SIGNED_STEP = "steps.cfg.outputs.configured == 'true'"
const SIGNED_JOB = "needs.sign-windows.outputs.signed == 'true'"
const SIGNED_ENV = '${{ needs.sign-windows.outputs.signed }}'
const SIGNED_BRANCH = 'if [ "$WINDOWS_SIGNED" = true ]; then'

/** Which branch of the `if [ "$WINDOWS_SIGNED" = true ]` block each line of a run script sits in. */
function signedBranches(run: string): Array<readonly [string, 'outside' | 'then' | 'else']> {
  let state: 'outside' | 'then' | 'else' = 'outside'
  return run.split('\n').map((line) => {
    const t = line.trim()
    if (t === SIGNED_BRANCH) state = 'then'
    else if (t === 'else' && state === 'then') state = 'else'
    else if (t === 'fi' && state !== 'outside') state = 'outside'
    return [t, state] as const
  })
}

/** Without a signing configuration the release ships no Windows binary rather than failing or shipping an unsigned one: the sign job's first step records whether signing is configured, every later step there runs only when it is, the job exports that as `signed`, and the publish job downloads, copies and verifies Windows binaries only on that branch. */
function windowsShipsOnlyWhenSigned(doc: Workflow): string[] {
  const problems: string[] = []
  const sign = job(doc, SIGN_JOB)
  const cfgAt = sign.steps.findIndex((s) => s.id === 'cfg')
  if (cfgAt !== 0) problems.push(`${SIGN_JOB} does not open with a step id'd cfg that records whether signing is configured`)
  else {
    const last = (sign.steps[0]!.run ?? '').trim().split('\n').at(-1)?.trim()
    if (last !== 'echo "configured=true" >> "$GITHUB_OUTPUT"') problems.push(`${SIGN_JOB}: the configuration check does not end by recording configured=true`)
    for (const step of sign.steps.slice(1)) if (step.if !== SIGNED_STEP) problems.push(`${SIGN_JOB}: ${step.name ?? step.uses ?? '(unnamed step)'} runs without signing configured`)
  }
  if (sign.outputs?.['signed'] !== '${{ steps.cfg.outputs.configured }}') problems.push(`${SIGN_JOB} does not export the configuration check as outputs.signed`)
  for (const step of job(doc, PUBLISH_JOB).steps) {
    const label = step.name ?? step.uses ?? '(unnamed step)'
    if (step.with?.['name'] === 'native-windows-signed' && step.if !== SIGNED_JOB) problems.push(`${PUBLISH_JOB}: ${label} runs when nothing was signed`)
    const run = step.run ?? ''
    if (!/win32|verify-native-dist\.mjs/.test(run)) continue
    if (step.env?.['WINDOWS_SIGNED'] !== SIGNED_ENV) problems.push(`${PUBLISH_JOB}: ${label} does not read whether ${SIGN_JOB} signed anything`)
    for (const [line, state] of signedBranches(run)) {
      if (/win32|native-signed/.test(line) && state !== 'then') problems.push(`${PUBLISH_JOB}: ${label}: ${line} runs outside the signed branch`)
      if (line.includes('--without-windows') && state !== 'else') problems.push(`${PUBLISH_JOB}: ${label}: ${line} runs outside the unsigned branch`)
    }
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
    'Assemble dist/native from the release artifacts: touches dist/native before deleting it: mkdir -p dist/native/linux-x64 dist/native/linux-arm64',
  ],
  [
    'publish runs the verify gate before npm publish',
    publishVerifiesBeforePublishing,
    (doc) => {
      const steps = doc.jobs[PUBLISH_JOB]!.steps
      const gate = steps.findIndex((s) => /verify-native-dist\.mjs/.test(s.run ?? ''))
      steps.push(...steps.splice(gate, 1))
    },
    'scripts/verify-native-dist.mjs runs after npm publish',
  ],
  [
    'publish cannot skip the verify gate',
    publishVerifiesBeforePublishing,
    (doc) => {
      doc.jobs[PUBLISH_JOB]!.steps.find((s) => /verify-native-dist\.mjs/.test(s.run ?? ''))!.if = SIGNED_JOB
    },
    `the verify gate step is conditional (if: ${SIGNED_JOB}), so a run that skips it still publishes`,
  ],
  [
    'publish stops when the verify gate refuses',
    publishVerifiesBeforePublishing,
    (doc) => {
      doc.jobs[PUBLISH_JOB]!.steps.find((s) => /verify-native-dist\.mjs/.test(s.run ?? ''))!['continue-on-error'] = true
    },
    'the verify gate step has continue-on-error: true, so a refusal does not stop npm publish',
  ],
  [
    'publish stops when the verify gate refuses, whatever follows the command',
    publishVerifiesBeforePublishing,
    (doc) => {
      const gate = doc.jobs[PUBLISH_JOB]!.steps.find((s) => /verify-native-dist\.mjs/.test(s.run ?? ''))!
      gate.run = gate.run!.split('linux-arm64.sha256"\nelse').join('linux-arm64.sha256" || true\nelse')
    },
    'scripts/verify-native-dist.mjs is followed by more than its arguments, which can discard its exit status: node scripts/verify-native-dist.mjs dist/native "$RUNNER_TEMP/native-signed/SHA256SUMS" "$RUNNER_TEMP/native/linux-x64.sha256" "$RUNNER_TEMP/native/linux-arm64.sha256" || true',
  ],
  [
    'publish stops when the verify gate refuses, whatever the script turns off first',
    publishVerifiesBeforePublishing,
    (doc) => {
      const gate = doc.jobs[PUBLISH_JOB]!.steps.find((s) => /verify-native-dist\.mjs/.test(s.run ?? ''))!
      gate.run = gate.run!.split('set -euo pipefail\n').join('set -euo pipefail\nset +e\n')
    },
    'the verify gate step turns failure handling off: set +e',
  ],
  [
    'publish stops when the verify gate refuses, whichever shell runs it',
    publishVerifiesBeforePublishing,
    (doc) => {
      doc.jobs[PUBLISH_JOB]!.steps.find((s) => /verify-native-dist\.mjs/.test(s.run ?? ''))!.shell = 'sh'
    },
    'the verify gate step runs under shell: sh, not bash, so its set -euo pipefail does not apply',
  ],
  [
    'publish stops when the verify gate refuses, because the script exits on the first failure',
    publishVerifiesBeforePublishing,
    (doc) => {
      const gate = doc.jobs[PUBLISH_JOB]!.steps.find((s) => /verify-native-dist\.mjs/.test(s.run ?? ''))!
      gate.run = gate.run!.split('set -euo pipefail\n').join('')
    },
    'the verify gate step does not start with set -euo pipefail, so a refusal can be ignored: if [ "$WINDOWS_SIGNED" = true ]; then',
  ],
  [
    'Windows binaries are signed, downloaded, copied and verified only when signing is configured',
    windowsShipsOnlyWhenSigned,
    (doc) => {
      const assembly = doc.jobs[PUBLISH_JOB]!.steps.find((s) => s.name === 'Assemble dist/native from the release artifacts')!
      assembly.run = assembly.run!.replace(`${SIGNED_BRANCH}\n`, '').replace(/\n\s*fi\s*$/, '\n')
    },
    `${PUBLISH_JOB}: Assemble dist/native from the release artifacts: mkdir -p dist/native/win32-x64 dist/native/win32-arm64 runs outside the signed branch`,
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

describe('the signing configuration check, run under bash', () => {
  // HAND-DERIVED cases: unset must release without Windows binaries rather than fail, and each provider's variable and secret names are FORMAT-DERIVED from jsign's storetype docs (https://ebourg.github.io/jsign/), the same names the step's env block passes.
  const NAMES = ['WINDOWS_SIGNING_STORETYPE', 'WINDOWS_SIGNING_ALIAS', 'ESIGNER_USERNAME', 'ESIGNER_PASSWORD', 'ESIGNER_TOTP_SECRET', 'DIGICERT_API_KEY', 'DIGICERT_CLIENT_CERT_P12_BASE64', 'DIGICERT_CLIENT_CERT_PASSWORD']
  const ESIGNER = { WINDOWS_SIGNING_STORETYPE: 'ESIGNER', WINDOWS_SIGNING_ALIAS: 'a', ESIGNER_USERNAME: 'u', ESIGNER_PASSWORD: 'p', ESIGNER_TOTP_SECRET: 't' }
  const DIGICERT = { WINDOWS_SIGNING_STORETYPE: 'DIGICERTONE', WINDOWS_SIGNING_ALIAS: 'a', DIGICERT_API_KEY: 'k', DIGICERT_CLIENT_CERT_P12_BASE64: 'c', DIGICERT_CLIENT_CERT_PASSWORD: 'p' }

  function runCfg(vars: Record<string, string>): { status: number | null; output: string; log: string } {
    const step = job(real(), SIGN_JOB).steps.find((s) => s.id === 'cfg')
    expect(step?.run, `${SIGN_JOB} has no step id'd cfg to run`).toBeDefined()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-signcfg-'))
    try {
      const out = path.join(dir, 'GITHUB_OUTPUT')
      fs.writeFileSync(out, '')
      const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: out, ...vars }
      for (const name of NAMES) if (!(name in vars)) delete env[name]
      const r = spawnSync(HOOK_BASH!, ['-c', step!.run!], { env, encoding: 'utf8' })
      return { status: r.status, output: fs.readFileSync(out, 'utf8'), log: r.stdout + r.stderr }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it.skipIf(HOOK_BASH === null)('with no storetype, succeeds and records that nothing will be signed', () => {
    const r = runCfg({})
    expect(r.status, r.log).toBe(0)
    expect(r.output).toBe('configured=false\n')
    expect(r.log).toContain('this release ships no Windows binaries')
  })

  it.skipIf(HOOK_BASH === null)('with an empty storetype, behaves as unset', () => {
    const r = runCfg({ WINDOWS_SIGNING_STORETYPE: '' })
    expect(r.status, r.log).toBe(0)
    expect(r.output).toBe('configured=false\n')
  })

  for (const [label, vars] of [['ESIGNER', ESIGNER], ['DIGICERTONE', DIGICERT]] as const) {
    it.skipIf(HOOK_BASH === null)(`with ${label} and every secret, records that signing is configured`, () => {
      const r = runCfg(vars)
      expect(r.status, r.log).toBe(0)
      expect(r.output).toBe('configured=true\n')
    })

    it.skipIf(HOOK_BASH === null)(`with ${label} and a secret missing, fails and names it`, () => {
      const last = Object.keys(vars).at(-1)!
      const r = runCfg(Object.fromEntries(Object.entries(vars).filter(([k]) => k !== last)))
      expect(r.status).toBe(1)
      expect(r.output).toBe('')
      expect(r.log).toContain(`is missing: ${last}`)
    })
  }

  it.skipIf(HOOK_BASH === null)('with an unknown storetype, fails rather than releasing without Windows binaries', () => {
    const r = runCfg({ ...ESIGNER, WINDOWS_SIGNING_STORETYPE: 'esigner' })
    expect(r.status).toBe(1)
    expect(r.output).toBe('')
    expect(r.log).toContain("WINDOWS_SIGNING_STORETYPE is 'esigner'")
  })
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
