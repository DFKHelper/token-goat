import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { extractTgSurgicalRead } from '../src/bash_extractors.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { getConsumedSectionTargets, getFileLineRanges } from '../src/session.js'
import {
  addSectionReadReceipt,
  createSectionReadReceiptNonce,
  isSectionReadReceiptNonce,
  sectionReadReceiptSessionKey,
  sectionReadReceiptMatches,
  takeSectionReadReceipt,
  writeSectionReadReceipt,
} from '../src/served_extent.js'
import { tokenGoatHome } from '../src/constants.js'
import { normalizePath } from '../src/paths.js'
import { projectTranscriptsDir } from '../src/claude_config_dir.js'
import { runSpawned } from './helpers/batch-cli.js'
import { makeHookEvent } from './helpers/hook-event.js'

// Guard: every `token-goat ...` command a read hook suggests for a JSON/YAML/TOML/XML/lock file must actually run against a real file of that type through the built bundle (dist/token-goat.mjs, built by vitest globalSetup). The shipped bug was a hint naming `token-goat section` for files `section` finds no headings in.

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

interface Case {
  name: string
  /** Test title when two cases share a file name. */
  label?: string
  body: string
  /** Value substituted for any `<placeholder>` argument in a suggested command. */
  arg: string
  /** Text the command's stdout must contain: proves the output is the useful slice, not an error banner. */
  marker: string
  /** Reads before the one under test; the manifest and tsconfig hints only fire on a re-read. */
  priorReads: number
}

// Provenance: HAND-DERIVED. File bodies are minimal documents in each ecosystem's published lockfile/manifest shape; markers are strings the fixture itself contains. The commands' exit codes were observed against the built CLI, not read off the hint matcher.
const CASES: Case[] = [
  { name: 'package-lock.json', body: '{"name":"x","lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.3.0"}}}', arg: 'packages', marker: 'packages', priorReads: 0 },
  { name: 'composer.lock', body: '{"packages":[{"name":"vendor/pkg","version":"1.0.0"}]}', arg: 'packages', marker: 'packages', priorReads: 0 },
  { name: 'Pipfile.lock', body: '{"default":{"requests":{"version":"==2.0"}}}', arg: 'default', marker: 'default', priorReads: 0 },
  { name: 'Package.resolved', body: '{"pins":[{"identity":"swift-log"}],"version":2}', arg: 'pins', marker: 'pins', priorReads: 0 },
  { name: 'pnpm-lock.yaml', body: "lockfileVersion: '9.0'\npackages:\n  foo@1.0.0:\n    resolution: {integrity: abc}\n", arg: 'packages', marker: 'packages', priorReads: 0 },
  { name: 'pubspec.lock', body: 'packages:\n  path:\n    version: "1.8.0"\n', arg: 'packages', marker: 'packages', priorReads: 0 },
  { name: 'yarn.lock', body: 'serde@^1:\n  version "1.0.0"\n', arg: 'serde', marker: 'serde', priorReads: 0 },
  { name: 'Cargo.lock', body: '[[package]]\nname = "serde"\nversion = "1.0.0"\n', arg: 'serde', marker: 'serde', priorReads: 0 },
  { name: 'poetry.lock', body: '[[package]]\nname = "serde"\nversion = "1.0.0"\n', arg: 'serde', marker: 'serde', priorReads: 0 },
  { name: 'uv.lock', body: '[[package]]\nname = "serde"\nversion = "1.0.0"\n', arg: 'serde', marker: 'serde', priorReads: 0 },
  { name: 'Gemfile.lock', body: 'GEM\n  specs:\n    serde (1.0.0)\n', arg: 'serde', marker: 'serde', priorReads: 0 },
  { name: 'go.sum', body: 'github.com/serde/serde v1.0.0 h1:abc=\n', arg: 'serde', marker: 'serde', priorReads: 0 },
  { name: 'mix.lock', body: '%{"serde": {:hex, :serde, "1.0.0"}}\n', arg: 'serde', marker: 'serde', priorReads: 0 },
  { name: 'package.json', body: '{"name":"x","dependencies":{"left-pad":"1.3.0"},"devDependencies":{"vitest":"1.0.0"}}', arg: 'dependencies', marker: 'left-pad', priorReads: 0 },
  { name: 'tsconfig.json', body: '{"compilerOptions":{"target":"es2020"}}', arg: 'compilerOptions', marker: 'es2020', priorReads: 1 },
  // CAPTURE: real `tsc --init` output (tests/fixtures/jsonc/tsc-init-6.0.3.jsonc), whose comments and trailing comma made every command this hint names fail with "Failed to parse JSON".
  { name: 'tsconfig.json', label: 'tsconfig.json from tsc --init', body: fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'jsonc', 'tsc-init-6.0.3.jsonc'), 'utf8'), arg: 'compilerOptions', marker: 'esnext', priorReads: 1 },
  { name: 'composer.json', body: '{"require":{"vendor/pkg":"^1.0"}}', arg: 'require', marker: 'vendor/pkg', priorReads: 1 },
  { name: 'pyproject.toml', body: '[project]\nname = "demo"\n', arg: 'project', marker: 'demo', priorReads: 1 },
  { name: 'pubspec.yaml', body: 'name: demo\ndependencies:\n  path: ^1.8.0\n', arg: 'name', marker: 'demo', priorReads: 1 },
  { name: 'Makefile', body: 'build:\n\techo demo\n', arg: 'build', marker: 'build', priorReads: 1 },
]

function suggestedText(c: Case, dir: string): { text: string; shown: string } {
  const file = path.join(dir, c.name)
  fs.writeFileSync(file, c.body)
  const sessionId = `hint-run-${c.label ?? c.name}-${process.pid}`
  let text = ''
  for (let i = 0; i <= c.priorReads; i++) {
    const out = preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: file }, sessionId }))
    text = out.hookType === 'deny' ? out.message : out.hookType === 'context' ? out.context : ''
  }
  return { text, shown: file.replace(/\\/g, '/') }
}

function tokenize(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? '')
  return out
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function beginIsolatedSession(dir: string): {
  sessionId: string
  tokenHome: string
  env: NodeJS.ProcessEnv
  restore: () => void
} {
  const sessionId = `hint-run-${randomUUID()}`
  const tokenHome = path.join(dir, 'token-goat-home')
  const overrides: Record<string, string> = {
    HOME: dir,
    USERPROFILE: dir,
    LOCALAPPDATA: path.join(dir, 'local-app-data'),
    APPDATA: path.join(dir, 'roaming'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
    XDG_DATA_HOME: path.join(dir, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
    TOKEN_GOAT_HOME: tokenHome,
    CLAUDE_CODE_SESSION_ID: sessionId,
  }
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return {
    sessionId,
    tokenHome,
    env: { ...process.env },
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

function postBashEvent(command: string, response: unknown, sessionId: string, cwd: string) {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId,
    raw: {
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: response,
      cwd,
    },
  })
}

describe('commands suggested by the read hooks run against a real file of that type', () => {
  for (const c of CASES) {
    it(`${c.label ?? c.name}: every suggested token-goat command exits 0 with useful output`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hint-run-'))
      tmpDirs.push(dir)
      const { text } = suggestedText(c, dir)
      const commands = [...text.matchAll(/`token-goat ([^`]+)`/g)].map((m) => m[1] ?? '')
      expect(commands.length, `no suggested command in: ${text}`).toBeGreaterThan(0)
      let anyMarker = false
      for (const command of commands) {
        const args = tokenize(command.replace(/<[^>]+>/g, c.arg))
        const res = runSpawned(args, { cwd: dir })
        expect(res.status, `\`token-goat ${command}\` failed: ${res.stdout}${res.stderr}`).toBe(0)
        expect(res.stdout.trim().length).toBeGreaterThan(0)
        if (res.stdout.includes(c.marker)) anyMarker = true
      }
      expect(anyMarker, `no command output contained ${c.marker}`).toBe(true)
    })
  }
})

describe('section receipts across the read hint, built CLI, and PostToolUse', () => {
  it('transports the session binding to the CLI and records the canonical target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-receipt-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'guide.md')
    const content = [
      '# Guide',
      'Intro.',
      '## Alpha',
      'alpha-body-marker',
      '## Beta',
      'beta-body-marker',
      '## Gamma',
      'gamma-body-marker',
      ...Array.from({ length: 44 }, (_, i) => `supporting line ${i + 1}`),
    ].join('\n')
    fs.writeFileSync(file, content)

    const sessionId = `hint-run-${randomUUID()}`
    const tokenHome = path.join(dir, 'token-goat-home')
    const localAppData = path.join(dir, 'local-app-data')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      LOCALAPPDATA: localAppData,
      APPDATA: path.join(dir, 'roaming'),
      XDG_DATA_HOME: path.join(dir, 'xdg-data'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
      TOKEN_GOAT_HOME: tokenHome,
      CLAUDE_CODE_SESSION_ID: sessionId,
    }
    const cliEnv = { ...env }
    delete cliEnv.CLAUDE_CODE_SESSION_ID
    const previousHome = process.env['TOKEN_GOAT_HOME']
    const previousSession = process.env['CLAUDE_CODE_SESSION_ID']
    process.env['TOKEN_GOAT_HOME'] = tokenHome
    process.env['CLAUDE_CODE_SESSION_ID'] = sessionId

    try {
      expect(tokenGoatHome()).toBe(tokenHome)
      const firstHint = preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: file },
        sessionId,
      }))
      const firstText = firstHint.hookType === 'deny' ? firstHint.message : firstHint.hookType === 'context' ? firstHint.context : ''
      const suggestedFirstCommand = /`(token-goat section [^`]+)`/.exec(firstText)?.[1]
      if (suggestedFirstCommand === undefined) throw new Error(`no section hint in: ${firstText}`)
      expect(suggestedFirstCommand).toContain('--_section-read-receipt')
      expect(suggestedFirstCommand).toContain(`--_section-read-session-key ${sha256(sessionId)}`)
      expect(suggestedFirstCommand).not.toContain(sessionId)

      const firstCommand = suggestedFirstCommand.replace('::Alpha', '::alpha')
      const args = tokenize(firstCommand.slice('token-goat '.length))
      const result = runSpawned(args, { cwd: dir, env: cliEnv })
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('alpha-body-marker')

      await postBashHandler(makeHookEvent({
        eventName: 'post_tool_use',
        toolName: 'Bash',
        toolInput: { command: firstCommand },
        sessionId,
        raw: {
          tool_name: 'Bash',
          tool_input: { command: firstCommand },
          tool_response: result.stdout,
          cwd: dir,
        },
      }))

      expect(getConsumedSectionTargets(normalizePath(file))).toEqual(new Set(['Alpha']))

      const nextHint = preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: file },
        sessionId,
      }))
      const nextText = nextHint.hookType === 'deny' ? nextHint.message : nextHint.hookType === 'context' ? nextHint.context : ''
      expect(nextText).toContain('Beta')
      expect(nextText).not.toContain('::Alpha')

      let hintText = nextText
      for (const [target, marker, following] of [
        ['Beta', 'beta-body-marker', 'Gamma'],
        ['Gamma', 'gamma-body-marker', 'token-goat outline'],
      ] as const) {
        const command = /`(token-goat section [^`]+)`/.exec(hintText)?.[1]
        if (command === undefined) throw new Error(`no section hint in: ${hintText}`)
        expect(command).toContain('--_section-read-receipt')
        const sectionResult = runSpawned(tokenize(command.slice('token-goat '.length)), { cwd: dir, env: cliEnv })
        expect(sectionResult.status, `${sectionResult.stdout}${sectionResult.stderr}`).toBe(0)
        expect(sectionResult.stdout).toContain(marker)

        await postBashHandler(makeHookEvent({
          eventName: 'post_tool_use',
          toolName: 'Bash',
          toolInput: { command },
          sessionId,
          raw: {
            tool_name: 'Bash',
            tool_input: { command },
            tool_response: sectionResult.stdout,
            cwd: dir,
          },
        }))

        expect(getConsumedSectionTargets(normalizePath(file))).toContain(target)
        const followingHint = preReadHandler(makeHookEvent({
          toolName: 'Read',
          toolInput: { file_path: file },
          sessionId,
        }))
        hintText = followingHint.hookType === 'deny' ? followingHint.message : followingHint.hookType === 'context' ? followingHint.context : ''
        expect(hintText).toContain(following)
        expect(hintText).not.toContain(`::${target}`)
      }
    } finally {
      if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
      else process.env['TOKEN_GOAT_HOME'] = previousHome
      if (previousSession === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']
      else process.env['CLAUDE_CODE_SESSION_ID'] = previousSession
    }
  })

  it('records the ordinary section range when receipt evidence is absent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-range-fallback-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'guide.md')
    fs.writeFileSync(file, '# Guide\n\n## Alpha\nalpha-body-marker\n## Beta\nbeta-body-marker\n')
    const { sessionId, env, restore } = beginIsolatedSession(dir)

    try {
      const normalized = normalizePath(file)
      const command = `token-goat section "${file.replace(/\\/g, '/')}" "Alpha"`
      const result = runSpawned(tokenize(command.slice('token-goat '.length)), { cwd: dir, env })
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('alpha-body-marker')

      await postBashHandler(postBashEvent(command, result.stdout, sessionId, dir))

      expect(getFileLineRanges(normalized)).toEqual([[3, 4]])
      expect(getConsumedSectionTargets(normalized)).toEqual(new Set())
    } finally {
      restore()
    }
  })

  it('does not consume a valid section receipt when the output is piped through cat', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-receipt-piped-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'guide.md')
    fs.writeFileSync(file, [
      '# Guide',
      'Intro.',
      '## Alpha',
      'alpha-body-marker',
      '## Beta',
      'beta-body-marker',
      '## Gamma',
      'gamma-body-marker',
      ...Array.from({ length: 44 }, (_, i) => `supporting line ${i + 1}`),
    ].join('\n'))
    const { sessionId, env, restore } = beginIsolatedSession(dir)

    try {
      const firstHint = preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: file },
        sessionId,
      }))
      const firstText = firstHint.hookType === 'deny' ? firstHint.message : firstHint.hookType === 'context' ? firstHint.context : ''
      const command = /`(token-goat section [^`]+)`/.exec(firstText)?.[1]
      if (command === undefined) throw new Error(`no section hint in: ${firstText}`)
      expect(command).toContain('--_section-read-receipt')

      const cliEnv = { ...env }
      delete cliEnv.CLAUDE_CODE_SESSION_ID
      const result = runSpawned(tokenize(command.slice('token-goat '.length)), { cwd: dir, env: cliEnv })
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('alpha-body-marker')

      const pipedCommand = `${command} | cat`
      await postBashHandler(postBashEvent(pipedCommand, result.stdout, sessionId, dir))

      const normalized = normalizePath(file)
      expect(getConsumedSectionTargets(normalized)).toEqual(new Set())
      expect(getFileLineRanges(normalized)).toEqual([])
    } finally {
      restore()
    }
  })
})

describe('section read receipt evidence', () => {
  it('stores redacted one-use evidence with the SHA of the original file bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-receipt-raw-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'guide.md')
    const sourceBytes = Buffer.from('# Guide\r\n## Alpha\r\nalpha-body-marker\r\n## Beta\r\nbeta-body-marker\r\n', 'utf8')
    fs.writeFileSync(file, sourceBytes)
    const shown = file.replace(/\\/g, '/')
    const { sessionId, tokenHome, env, restore } = beginIsolatedSession(dir)

    try {
      expect(tokenGoatHome()).toBe(tokenHome)
      const command = addSectionReadReceipt(`token-goat section "${shown}" "Alpha"`)
      const nonce = /--_section-read-receipt ([0-9a-f]{32})(?:\s|$)/.exec(command)?.[1]
      if (nonce === undefined) throw new Error(`section command has no receipt nonce: ${command}`)
      const result = runSpawned(tokenize(command.slice('token-goat '.length)), { cwd: dir, env })
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('alpha-body-marker')

      const sessionKey = sectionReadReceiptSessionKey(sessionId)
      const receipt = takeSectionReadReceipt(sessionKey, nonce)
      if (receipt === null) throw new Error('section command did not persist its read receipt')
      expect(receipt.sourceSha).toBe(sha256(sourceBytes))
      expect(sectionReadReceiptMatches(receipt, shown, 'Alpha', result.stdout)).toBe(true)
      const serialized = JSON.stringify(receipt)
      expect(serialized).not.toContain(shown)
      expect(serialized).not.toContain('Alpha')
      expect(serialized).not.toContain('alpha-body-marker')
      expect(takeSectionReadReceipt(sessionKey, nonce)).toBeNull()

      const filteredCommand = addSectionReadReceipt(`token-goat section "${shown}" "Alpha" --max-lines 1`)
      const filteredNonce = /--_section-read-receipt ([0-9a-f]{32})(?:\s|$)/.exec(filteredCommand)?.[1]
      if (filteredNonce === undefined) throw new Error(`filtered section command has no receipt nonce: ${filteredCommand}`)
      const filteredResult = runSpawned(tokenize(filteredCommand.slice('token-goat '.length)), { cwd: dir, env })
      expect(filteredResult.status, `${filteredResult.stdout}${filteredResult.stderr}`).toBe(0)
      expect(takeSectionReadReceipt(sessionKey, filteredNonce)).toBeNull()
    } finally {
      restore()
    }
  })

  it('fails open when evidence is missing, malformed, stale, mismatched, capped, persisted, or unsuccessful', async () => {
    const failures = [
      'path mismatch',
      'target mismatch',
      'output mismatch',
      'stale source bytes',
      'invalid source hash',
      'missing current file',
      'capped output',
      'persisted output',
      'nonzero exit',
      'invalid nonce',
    ] as const

    for (const reason of failures) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-receipt-reject-'))
      tmpDirs.push(dir)
      const file = path.join(dir, 'guide.md')
      const sourceBytes = Buffer.from('# Guide\n## Alpha\nalpha-body-marker\n## Beta\nbeta-body-marker\n', 'utf8')
      fs.writeFileSync(file, sourceBytes)
      const normalized = normalizePath(file)
      const { sessionId, tokenHome, restore } = beginIsolatedSession(dir)

      try {
        expect(tokenGoatHome()).toBe(tokenHome)
        const output = '## Alpha\nalpha-body-marker\n'
        let receiptOutput = output
        let receiptPath = normalized
        let receiptTarget = 'Alpha'
        let receiptSourceSha = sha256(sourceBytes)
        let response: unknown = output
        let nonce = createSectionReadReceiptNonce()

        if (reason === 'path mismatch') {
          receiptPath = normalizePath(path.join(dir, 'other.md'))
          fs.writeFileSync(receiptPath, sourceBytes)
        } else if (reason === 'target mismatch') {
          receiptTarget = 'Beta'
        } else if (reason === 'output mismatch') {
          receiptOutput = 'different section output'
        } else if (reason === 'invalid source hash') {
          receiptSourceSha = 'not-a-sha256'
        } else if (reason === 'capped output') {
          receiptOutput = '[token-goat: output capped at ~2 KB] section output'
          response = receiptOutput
        } else if (reason === 'nonzero exit') {
          response = { stdout: output, exit_code: 1 }
        } else if (reason === 'invalid nonce') {
          nonce = 'not-a-valid-nonce'
        }

        if (reason !== 'invalid nonce') {
          const stored = writeSectionReadReceipt(sessionId, nonce, {
            filePath: receiptPath,
            target: receiptTarget,
            start: 2,
            end: 3,
            sourceSha: receiptSourceSha,
          }, receiptOutput)
          expect(stored).toBe(reason !== 'invalid source hash')
        } else {
          expect(isSectionReadReceiptNonce(nonce)).toBe(false)
        }

        if (reason === 'persisted output') {
          const toolResultsDir = path.join(projectTranscriptsDir(dir), sessionId, 'tool-results')
          fs.mkdirSync(toolResultsDir, { recursive: true })
          const persistedPath = path.join(toolResultsDir, 'section-output.txt')
          fs.writeFileSync(persistedPath, output)
          response = {
            stdout: output,
            persistedOutputPath: persistedPath,
            persistedOutputSize: Buffer.byteLength(output, 'utf8'),
          }
        } else if (reason === 'stale source bytes') {
          fs.writeFileSync(file, Buffer.from(`${sourceBytes.toString('utf8')}changed\n`, 'utf8'))
        } else if (reason === 'missing current file') {
          fs.unlinkSync(file)
        }

        const command = `token-goat section "${normalized}" "Alpha" --_section-read-receipt ${nonce}`
        await postBashHandler(postBashEvent(command, response, sessionId, dir))
        expect(getConsumedSectionTargets(normalized), reason).toEqual(new Set())
        expect(takeSectionReadReceipt(sessionId, nonce)).toBeNull()
      } finally {
        restore()
      }
    }
  })

  it('keeps an ambiguous Markdown section hint untagged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-receipt-ambiguous-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'ambiguous.md')
    fs.writeFileSync(file, [
      '## Repeated',
      'first body',
      '## Repeated',
      'second body',
      '## Repeated',
      'third body',
      ...Array.from({ length: 44 }, (_, i) => `supporting line ${i + 1}`),
    ].join('\n'))
    const { sessionId, tokenHome, restore } = beginIsolatedSession(dir)

    try {
      expect(tokenGoatHome()).toBe(tokenHome)
      const hint = preReadHandler(makeHookEvent({
        toolName: 'Read',
        toolInput: { file_path: file },
        sessionId,
      }))
      const text = hint.hookType === 'deny' ? hint.message : hint.hookType === 'context' ? hint.context : ''
      expect(text).toContain('token-goat read')
      expect(text).not.toContain('--_section-read-receipt')
      expect(text).not.toContain('token-goat outline')
    } finally {
      restore()
    }
  })
})

describe('section receipt command parsing', () => {
  const shown = path.join(os.tmpdir(), 'tg parser guide', 'guide.md').replace(/\\/g, '/')
  const cwd = path.dirname(shown)
  const normalized = normalizePath(shown)
  const nonce = '0123456789abcdef0123456789abcdef'
  const sessionKey = sha256('parser-session')

  it('parses positional and legacy section specs with attached and separate receipt bindings', () => {
    const positional = extractTgSurgicalRead(
      `token-goat section "${shown}" "Alpha" --grep "alpha-body" --max-lines 20 --_section-read-receipt ${nonce} --_section-read-session-key ${sessionKey}`,
      cwd,
    )
    expect(positional).toMatchObject({
      sub: 'section',
      spec: `${normalized}::Alpha`,
      filePath: normalized,
      sectionReceiptNonce: nonce,
      sectionReadSessionKey: sessionKey,
    })

    const legacy = extractTgSurgicalRead(
      `tg section "${shown}::Alpha" --_section-read-receipt=${nonce} --_section-read-session-key=${sessionKey}`,
      cwd,
    )
    expect(legacy).toMatchObject({
      sub: 'section',
      spec: `${normalized}::Alpha`,
      filePath: normalized,
      sectionReceiptNonce: nonce,
      sectionReadSessionKey: sessionKey,
    })
  })

  it('preserves read ranges and rejects malformed receipt near-misses', () => {
    for (const suffix of ['@12', '@12-34']) {
      expect(extractTgSurgicalRead(`token-goat read "${shown}${suffix}"`, cwd)).toEqual({
        sub: 'read',
        spec: `${normalized}${suffix}`,
        filePath: normalized,
      })
    }

    const invalid = extractTgSurgicalRead(`token-goat section "${shown}" "Alpha" --_section-read-receipt not-a-nonce`, cwd)
    expect(invalid?.sectionReceiptNonce).toBe('not-a-nonce')
    expect(isSectionReadReceiptNonce(invalid?.sectionReceiptNonce ?? '')).toBe(false)

    const missing = extractTgSurgicalRead(`token-goat section "${shown}" "Alpha" --_section-read-receipt`, cwd)
    expect(missing?.sectionReceiptNonce).toBeUndefined()

    const extra = extractTgSurgicalRead(`token-goat section "${shown}" "Alpha" "unexpected" --_section-read-receipt ${nonce}`, cwd)
    expect(extra?.spec).toBe(normalized)
  })
})
