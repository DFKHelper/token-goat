import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { canRunPowerShell, resolvePowerShell } from '../src/shell.js'
import { BUNDLE } from './helpers/bundle.js'

// HAND-DERIVED: `compress --stdin` runs the built bundle (the shipping path, not an injected callback) with a real stdin pipe; the expected text is the input itself, because `node -e "process.stdin.pipe(process.stdout)"` copies its stdin to its stdout unchanged, and the byte count is the length of the input in UTF-8 computed by hand ("abc" is 3 bytes).
const TEXT = 'héllo ✓\n'
const COPY = 'node -e "process.stdin.pipe(process.stdout)"'
const COUNT = `node -e "let n=0;process.stdin.on('data',c=>{n+=c.length});process.stdin.on('end',()=>{console.log('bytes='+n);process.exit(1)})"`
const pwshPath = resolvePowerShell({ PATH: process.env['PATH'] })
const hasPwsh = /^pwsh/i.test(path.basename(pwshPath)) && canRunPowerShell()

const compress = (args: string[], input: string | null) =>
  spawnSync(process.execPath, [BUNDLE, 'compress', ...args], { input: input ?? undefined, stdio: input === null ? ['ignore', 'pipe', 'pipe'] : 'pipe', timeout: 60_000 })

const shells: Array<[string, string[], boolean]> = [['default shell', [], true], ['--shell pwsh', ['--shell', 'pwsh'], hasPwsh]]

describe('compress --stdin on the built bundle', () => {
  for (const [label, shellArgs, available] of shells) {
    describe.skipIf(!available)(label, () => {
      it('round-trips UTF-8 input byte for byte on the capped path', () => {
        const r = compress(['--stdin', '--max-tokens', '50', ...shellArgs, '-c', COPY], TEXT)
        expect(r.stderr.toString()).toBe('')
        expect(r.stdout.toString('hex')).toBe(Buffer.from(TEXT, 'utf8').toString('hex'))
        expect(r.status).toBe(0)
      })

      it('round-trips UTF-8 input byte for byte on the unfiltered path', () => {
        const r = compress(['--stdin', ...shellArgs, '-c', COPY], TEXT)
        expect(r.stdout.toString('hex')).toBe(Buffer.from(TEXT, 'utf8').toString('hex'))
        expect(r.status).toBe(0)
      })

      it('exits 0 when standard input is closed', () => {
        const r = compress(['--stdin', '--max-tokens', '50', ...shellArgs, '-c', COPY], null)
        expect(r.stdout.toString().trim()).toBe('')
        expect(r.status).toBe(0)
      })

      // The default is no standard input on every path, so one rule covers a hook-wrapped run and a typed one; --stdin opts in on every path.
      for (const [route, pathArgs] of [['unfiltered', []], ['capped', ['--max-tokens', '50']], ['quiet', ['-q']], ['raw', ['--no-compress']]] as Array<[string, string[]]>) {
        it(`gives the command an empty input unless --stdin is given (${route})`, () => {
          const r = compress([...pathArgs, ...shellArgs, '-c', COUNT], 'abc')
          expect(r.stdout.toString()).toContain('bytes=0')
          expect(r.status).toBe(1)
        })

        it(`hands the command the caller's input with --stdin (${route})`, () => {
          const r = compress(['--stdin', ...pathArgs, ...shellArgs, '-c', COUNT], 'abc')
          expect(r.stdout.toString()).toContain('bytes=3')
          expect(r.status).toBe(1)
        })
      }
    })
  }

  // HAND-DERIVED: a process stays alive while a stream it reads holds the event loop open, so a stdin pipe that is never closed and never unpiped would keep the CLI running after the command ended; exiting within the timeout shows it is released.
  it('exits after the command ends even when the caller never closes standard input', async () => {
    const child = spawn(process.execPath, [BUNDLE, 'compress', '--stdin', '--max-tokens', '50', '-c', 'node -e "console.log(1)"'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const exit = await new Promise<number | string | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve('hung')
      }, 30_000)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    expect(exit).toBe(0)
  }, 40_000)
})
