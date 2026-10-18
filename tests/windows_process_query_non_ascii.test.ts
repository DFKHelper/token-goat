/** Provenance: CAPTURE of the failure, HAND-DERIVED launcher. Windows PowerShell 5.1.26100 (powershell.exe, console code page 437) answers a pipe in the OEM code page, where U+00E9 is 0x82 and U+4E2D has no byte and becomes 0x3F; the process query of tests/resident_process.test.ts returned the bytes 82 3f for them before bc0aba8a3 set a UTF-8 output encoding. These rows run the two other process queries of src/ (doctor's process list, which stray_residents.ts reads through readAllProcesses, and the claude command-line query behind commandLineRuleSource) on a live stand-in whose launcher path (doctor) or flag (claude) carries those two characters, built with String.fromCodePoint, and assert the text reads back whole. Windows only: elsewhere the queries are `ps`, which has no code page to misread. */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readWindowsProcesses } from '../src/cli_doctor_process.js'
import { commandLineRuleSource, resetHiddenRuleCache } from '../src/claude_hidden_rules.js'

const NON_ASCII = String.fromCodePoint(0xe9, 0x4e2d)

const children: ChildProcess[] = []
const dirs: string[] = []

afterEach(async () => {
  resetHiddenRuleCache()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, 'exit')
    child.stdin?.end()
    child.kill()
    await exited
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A stand-in process that exits when its stdin closes, started from a launcher in a temp directory whose name holds the non-ASCII characters. */
function standIn(args: readonly string[]): { pid: number; launcher: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-oem-${NON_ASCII}-`))
  dirs.push(dir)
  const launcher = path.join(dir, 'launcher.js')
  fs.writeFileSync(launcher, 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume()\n')
  const child = spawn(process.execPath, [launcher, ...args], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  child.stdin?.on('error', () => undefined)
  children.push(child)
  expect(child.pid, 'spawning the stand-in produced no pid').toBeDefined()
  return { pid: child.pid as number, launcher }
}

describe.skipIf(process.platform !== 'win32')('Windows process queries read characters outside the OEM code page whole', () => {
  it('doctor process list returns a launcher path whole', () => {
    const { pid, launcher } = standIn(['--worker-daemon'])
    const listed = readWindowsProcesses()
    expect(Array.isArray(listed), `the process list could not be read: ${JSON.stringify(listed)}`).toBe(true)
    const row = Array.isArray(listed) ? listed.find((p) => p.processId === pid) : undefined
    expect(row?.commandLine ?? '', 'the stand-in is listed with its launcher path whole').toContain(launcher)
  })

  it('claude command-line query returns a flag name whole', () => {
    const flag = `--tg-${NON_ASCII}`
    const { pid } = standIn([flag])
    resetHiddenRuleCache()
    const reason = commandLineRuleSource({ CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(pid) })
    expect(reason, 'the query read the flag whole, so the reason names it').toBe(`claude started with ${flag}`)
  })
})
