/** The install-refusal rows of the native hook e2e suite. The harness rows live in the native_hook_install_e2e.*.test.ts shards, each under the 60 s wall bound (Ruling 121). */
import * as fs from 'node:fs'

import { spawn } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { registerSandboxLifecycle } from './helpers/native_hook_e2e_rows.js'
import { CLI_TIMEOUT_MS, CONFIG_FILE, NATIVE, WIN, makeSandbox, type Env, type Sandbox } from './helpers/native_hook_e2e_support.js'

registerSandboxLifecycle()

/** Runs the CLI with its stdin closed at once. A child that exits before reading gets EPIPE on that write, which the listener absorbs; the status and output still decide the row. */
function installClosingStdin(sb: Sandbox, args: string[], env: Env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [sb.entry, ...args], { cwd: sb.home, env: { ...sb.env, ...env }, timeout: CLI_TIMEOUT_MS })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end()
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

describe('install refuses a hook path the harness rewrites before running it', () => {
  /** Installs with the native client on and off (so both command forms are checked), with `x` and `y` set so either span would really change the path, and expects a refusal that writes no hook config. */
  async function refuses(dirName: string, flag: string, span: string, file: (sb: Sandbox) => string): Promise<void> {
    const sb = makeSandbox(dirName)
    for (const native of ['1', '0']) {
      const res = await installClosingStdin(sb, ['install', '--dev', flag], { TOKEN_GOAT_NATIVE_HOOKS: native, x: 'expanded', y: 'expanded' })
      expect(res.status, `${native}: ${res.stdout}${res.stderr}`).not.toBe(0)
      // A span holding $ is set in single quotes so a shell reading the message leaves it as written; any other span in double quotes.
      expect(res.stderr).toContain(`Move the path that contains ${span.includes('$') ? `'${span}'` : `"${span}"`}`)
      expect(res.stderr).toContain('then run `token-goat install ' + flag + '` again')
      // The command it refused is the form that install would have written.
      expect(res.stderr.includes(WIN ? 'tg-hook.exe' : 'tg-hook')).toBe(native === '1' && NATIVE)
      expect(fs.existsSync(file(sb)), 'a hook config was written').toBe(false)
    }
  }

  // HAND-DERIVED paths. Grok substitutes `$NAME` in a hook command itself, with no escape and whatever the quoting (grok-build xai-grok-hooks env_expand.rs `iter_env_var_references`), and refuses to run one naming an unset variable (runner/command.rs `find_unresolved_env_vars`).
  it('Grok CLI: a path holding $NAME, in the native and the Node form', async () => {
    await refuses('tg $y', '--grok', '$y', CONFIG_FILE.grok)
  }, 120_000)

  // cmd.exe expands `%NAME%` in its first parsing phase, before it reads a quote, and Kimi Code runs a hook with Node's `spawn(command, { shell: true })`, which is cmd.exe on Windows.
  it.runIf(WIN)('Kimi Code on Windows: a path holding %NAME%, in the native and the Node form', async () => {
    await refuses('tg %x%', '--kimi', '%x%', CONFIG_FILE.kimi)
  }, 120_000)
})
