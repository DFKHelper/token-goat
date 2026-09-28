import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWindowsBash } from '../src/shell.js'
import { ROOT } from './helpers/bundle.js'

/** The commit-msg hook refuses a message naming anything on the confidential denylist, matched without regard to case and as a literal string. It matched each listed name with `grep -qi -F`, and the grep that ships with Git for Windows (GNU grep 3.0) aborts with exit 134 on that flag pair. Inside an `if` the abort read as "no match", so on Windows every listed name passed the hook. These run the real script under the real bash against a temp denylist, with HOME and USERPROFILE pointed at the temp dir so the script's fallback can never reach a real list. HAND-DERIVED: every name below is invented for this file, and each expected verdict follows from the name and the message alone. */

const SCRIPT = path.join(ROOT, '.lefthook-scripts', 'check-commit-msg.sh').replace(/\\/g, '/')
/** Git for Windows' `bin\bash.exe` is a launcher that puts Git's own `mingw64\bin` and `usr\bin` at the front of PATH before starting `usr\bin\bash.exe`, so a stub prepended to PATH never runs under it. CAPTURE: CI's test-windows job on 6593e34f resolved that launcher from the runner's PATH and the grep-failure case below got exit 0, while this machine resolves `usr\bin\bash.exe` and passed. The hook itself runs under whatever bash lefthook finds; only the stub needs the real shell. */
function directBash(bash: string | null): string | null {
  if (bash === null || !/[\\/]git[\\/]bin[\\/]bash\.exe$/i.test(bash)) return bash
  const direct = path.join(path.dirname(path.dirname(bash)), 'usr', 'bin', 'bash.exe')
  return fs.existsSync(direct) ? direct : bash
}

const BASH = process.platform === 'win32' ? directBash(resolveWindowsBash()) : 'bash'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-commit-msg-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function slash(p: string): string {
  return p.replace(/\\/g, '/')
}

/** The inherited environment with PATH's own key replaced, since Windows spells it `Path` and a second `PATH` key leaves which one wins to the platform. */
function envWithPathPrefix(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ''}` }
}

function runHook(names: string[], message: string, pathPrefix?: string): { status: number | null; stderr: string } {
  const list = path.join(tmp, 'names.txt')
  fs.writeFileSync(list, names.join('\n') + '\n')
  const msg = path.join(tmp, 'COMMIT_EDITMSG')
  fs.writeFileSync(msg, message)
  const base: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_CONFIDENTIAL_NAMES: slash(list), HOME: slash(tmp), USERPROFILE: tmp }
  const env = pathPrefix === undefined ? base : envWithPathPrefix(base, pathPrefix)
  const r = spawnSync(BASH as string, [SCRIPT, slash(msg)], { env, encoding: 'utf8' })
  if (r.error) throw r.error
  return { status: r.status, stderr: r.stderr }
}

describe('commit-msg hook: confidential denylist', () => {
  // With no bash at all the hook cannot run on this machine either, so there is nothing to observe; that is a skip, not a pass.
  const hasBash = BASH !== null

  it.skipIf(!hasBash)('refuses a message that names a listed entry in a different case', () => {
    const r = runHook(['Quillfeather Labs'], 'feat: wire the importer for QUILLFEATHER labs\n')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/confidential name/)
  })

  it.skipIf(!hasBash)('passes a message that names nothing on the list', () => {
    const r = runHook(['Quillfeather Labs', 'Ostrander'], 'feat: wire the importer for the new ledger\n')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it.skipIf(!hasBash)('matches a name holding regex and glob metacharacters literally', () => {
    const names = ['a.b*c[d]']
    expect(runHook(names, 'fix: rename A.B*C[D] in the loader\n').status).toBe(1)
    // "axbbcd" is what the name matches read as a regex, and "a.bZZcd" is what it matches read as a glob; a literal match refuses neither.
    expect(runHook(names, 'fix: rename axbbcd in the loader\n').status).toBe(0)
    expect(runHook(names, 'fix: rename a.bZZcd in the loader\n').status).toBe(0)
  })

  it.skipIf(!hasBash)('refuses the commit when grep cannot run instead of reading the failure as a clean message', () => {
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    // Exit 2 is how grep reports that it could not search at all, as opposed to 1 for "no line matched".
    fs.writeFileSync(path.join(bin, 'grep'), '#!/bin/sh\nexit 2\n', { mode: 0o755 })
    const r = runHook(['Quillfeather Labs'], 'feat: wire the importer for the new ledger\n', bin)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/grep exited 2/)
  })
})
