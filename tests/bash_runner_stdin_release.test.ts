import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSync } from 'esbuild'

// HAND-DERIVED: a process stays alive while a readable stream it has started reading is open, so a library caller of `run(..., { rawStdin: true })` whose stdin is never closed must still exit once the command has ended; the script awaits the runner and does nothing else, so a live handle can only be the stdin pipe the runner left behind.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stdin-release-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function buildRunner(): string {
  const outfile = path.join(dir, 'runner.mjs')
  buildSync({ entryPoints: [path.join(import.meta.dirname, '..', 'src', 'bash_runner.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
  const script = path.join(dir, 'caller.mjs')
  fs.writeFileSync(script, `import { run } from './runner.mjs'\nconst code = await run('node -e "console.log(7)"', { rawStdin: true, maxTokens: 50, writeStdout: () => {}, writeStderr: () => {} })\nprocess.stdout.write('code=' + code + '\\n')\n`)
  return script
}

describe('bash_runner releases the caller stdin after the command ends', () => {
  it('lets a process that never closes its stdin exit once run() resolves', async () => {
    const script = buildRunner()
    const child = spawn(process.execPath, [script], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    const result = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve('hung')
      }, 20_000)
      child.on('close', () => {
        clearTimeout(timer)
        resolve('exited')
      })
    })
    expect(result).toBe('exited')
    expect(out + err).toContain('code=0')
  }, 30_000)
})
