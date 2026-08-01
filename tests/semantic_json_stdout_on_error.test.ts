// Regression: cmdSemantic (src/cli.ts) routed output via `(code === 0 ? out : err)(text)`, so any
// non-zero-code --json return (a no-match miss, `--limit 0`, an invalid --project-root) went to
// stderr instead of stdout, breaking `token-goat semantic ... --json | jq .` on exactly the cases
// a machine caller most needs to detect programmatically. --json output must always land on
// stdout; only the exit code communicates success/failure. Non-JSON text mode must stay
// byte-identical (still routes non-zero codes to stderr).
import { describe, expect, it, vi } from 'vitest'

const { run } = await import('../src/cli.js')

async function runCli(argv: string[]): Promise<{ code: number | string | undefined; stdout: string; stderr: string }> {
  const prev = process.exitCode
  process.exitCode = 0
  const outChunks: string[] = []
  const errChunks: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    outChunks.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errChunks.push(String(chunk))
    return true
  })
  try {
    await run(['node', 'token-goat', ...argv])
    return { code: process.exitCode, stdout: outChunks.join(''), stderr: errChunks.join('') }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
    process.exitCode = prev
  }
}

describe('cmdSemantic --json routes every exit code to stdout', () => {
  it('writes a no-match miss to stdout (parseable JSON) instead of stderr', async () => {
    const { code, stdout, stderr } = await runCli(['semantic', 'noSuchTermAtAllZzJsonStdout9k2', '--json'])
    expect(code).not.toBe(0)
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout) as { items: unknown[] }
    expect(payload.items).toEqual([])
  })

  it('writes a --limit 0 error to stdout as parseable JSON instead of stderr', async () => {
    const { code, stdout, stderr } = await runCli(['semantic', 'anything', '--limit', '0', '--json'])
    expect(code).not.toBe(0)
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout) as { error: string }
    expect(payload.error.toLowerCase()).toContain('limit')
  })

  it('non-JSON text mode still routes a non-zero code to stderr (byte-identical old behavior)', async () => {
    const { code, stdout, stderr } = await runCli(['semantic', 'noSuchTermAtAllZzJsonStdout9k2'])
    expect(code).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('no matches')
  })
})
