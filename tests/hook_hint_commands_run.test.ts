import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { preReadHandler } from '../src/hooks_read.js'
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
