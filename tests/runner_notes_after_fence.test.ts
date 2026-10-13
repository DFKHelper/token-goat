/** The compress runner's own notes about how a run ended -- the capture cap, a spawn failure, the timeout kill -- were appended to the command's stdout and stderr. On a result the runner compressed or capped, those streams go inside the untrusted-content fence, so the note reached the model escaped as a forgery (`&#91;token-goat: command exceeded 2s timeout and was killed]`) among the command's bytes, and it went into the recall copy as though the command had printed it. On a result passed through, it rode in the stderr half under the `---` separator. The notes are token-goat's, so they now print after the closing tag with its other lines, and after the output when it passes through; the recall copy holds only what the command wrote. The timeout is the note a test can reach in seconds; the cap needs 32 MiB of output. The kill budget is sized from a measured warm run, as shell_argv_helper.test.ts sizes its own, so a loaded machine still starts the command before the kill. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getBashOutput } from '../src/bash_output_cache.js'
import { run, runnerRecallId, runRaw } from '../src/bash_runner.js'
import { withoutFenceNonces } from './helpers/fence_nonce.js'

let scriptDir: string
/** Seconds the runner waits before it kills the command: three times a measured warm run plus a second, never under 1.5. */
let budget: number

function nodeCmd(name: string, body: string): string {
  const p = path.join(scriptDir, name)
  fs.writeFileSync(p, body)
  return `"${process.execPath}" "${p}"`
}

/** A command that prints `print` at once and then outlives the kill budget, exiting by itself so a grandchild the kill cannot reach still lets the run finish. */
function lingering(name: string, print: string): string {
  return nodeCmd(name, `${print}\nsetTimeout(() => {}, ${Math.ceil(budget * 1000) + 1500})\n`)
}

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-runner-notes-'))
  const noop = nodeCmd('noop.js', '')
  runRaw(noop)
  const t0 = Date.now()
  runRaw(noop)
  budget = Math.max(1.5, Math.round((3 * (Date.now() - t0) + 1000) / 100) / 10)
})

afterAll(() => {
  fs.rmSync(scriptDir, { recursive: true, force: true })
})

describe('the runner’s own notes print after the command’s bytes, never among them', () => {
  it('puts the timeout note after the closing tag, unescaped, and keeps it out of the recall copy, on a result it fenced', async () => {
    const rows = 'for (let i = 0; i < 400; i++) console.log(`row ${i}: ${"abcdefghij".repeat(3)} ${i * 7919}`)'
    let out = ''
    const code = await run(lingering('rows.js', rows), { filterName: 'passthrough', maxTokens: 300, timeout: budget, writeStdout: (s) => (out += s) })
    expect(code).toBe(124)
    const note = `[token-goat: command exceeded ${budget}s timeout and was killed]`
    const fenced = withoutFenceNonces(out)
    const close = fenced.indexOf('</untrusted-tool-output>')
    expect(close, out).toBeGreaterThan(0)
    expect(fenced.slice(0, close)).not.toContain('timeout and was killed')
    const after = fenced.slice(close).trimEnd().split('\n')
    expect(after.slice(0, 3)).toEqual(['</untrusted-tool-output>', '[token-goat: output capped at ~300 tokens]', note])
    // The recall line still ends the result, which is how the post hook knows it is the runner's.
    expect(after[after.length - 1]).toMatch(/^\[token-goat\] full output: bash-output [0-9a-f]{16} --full$/)
    const id = runnerRecallId(out)
    expect(id).not.toBeNull()
    expect(getBashOutput(id as string)?.output).not.toContain('timeout and was killed')
  })

  it('prints the timeout note after the output it passed through, as a line of its own', async () => {
    let out = ''
    const code = await run(lingering('short.js', "console.log('line one')\nconsole.log('line two')"), { filterName: 'generic', timeout: budget, writeStdout: (s) => (out += s) })
    expect(code).toBe(124)
    expect(out).toBe(`line one\nline two\n[token-goat: command exceeded ${budget}s timeout and was killed]\n`)
  })
})
