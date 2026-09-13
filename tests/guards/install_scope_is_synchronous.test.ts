/**
 * The install scope is a MODULE-LEVEL variable restored in a `finally`, which is only correct while
 * every installer is synchronous end to end. That precondition was written down in a JSDoc and
 * pinned by nothing.
 *
 * THE HAZARD. `withInstallScope(root, fn)` sets `installProjectRoot`, calls `fn`, and restores the
 * previous value in a `finally`. Make one installer `async` and `fn()` returns a promise at its
 * FIRST `await` -- so the `finally` fires there, the scope goes back to `undefined`, and every write
 * the installer has not reached yet runs with containment switched off. No error, no failing test,
 * and the flag whose containment silently evaporated is exactly the kind that shipped vulnerable
 * before. It is the class of defect this whole area exists to stop: not a check that is wrong, a
 * check that is no longer running.
 *
 * WHY BOTH HALVES. The RUNTIME half (`withInstallScope` refuses a thenable) only fires on a path
 * something actually executes, and the behavioural half of the sibling containment guard runs a
 * hand-maintained list of flags -- so a new bridge nobody added to that list could go async and
 * never be run by the suite at all. The STRUCTURAL half below catches it without executing it. The
 * runtime half in turn catches what the structural one cannot: a synchronous-looking function that
 * returns a promise it got from somewhere else, which no `async`/`await` keyword appears in.
 *
 * PROVENANCE: CAPTURE for the behavioural cases (the refusal is the real thrown error from the real
 * `withInstallScope`, and the containment verdicts are real `isInsideRoot` answers about real
 * directories). HAND-DERIVED for the structural regex, which is a syntax rule rather than a wire
 * format.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assertWriteInScope, withInstallScope } from '../../src/bridges/project_scope_guard.js'
import { pinnedPopulation } from './population.js'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/**
 * JS `async`/`await` syntax, and NOT the word "async" in other positions.
 *
 * `codex_install.ts` writes `async: false` into a hook config object and mentions it again in the
 * docblock above, so a bare /async|await/ reports two hits in a file that contains no asynchronous
 * code at all -- which is how a rule like this gets dismissed as noisy and then deleted. The `:`
 * after the property name is what distinguishes them.
 */
const ASYNC_SYNTAX = /\basync\s+(?:function\b|\(|[A-Za-z_$][\w$]*\s*(?:=>|\())|\bawait\s/

/** Modules that declare an install scope, and therefore depend on the synchronous restore. */
function scopeDeclaringModules(): string[] {
  const out: string[] = []
  for (const dir of [path.join(SRC, 'bridges'), SRC]) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.ts')) continue
      const full = path.join(dir, name)
      const rel = path.relative(SRC, full).replace(/\\/g, '/')
      if (out.includes(rel)) continue
      if (/\bwithInstallScope\s*\(/.test(fs.readFileSync(full, 'utf8'))) out.push(rel)
    }
  }
  return out
}

describe('the install scope depends on installers being synchronous, and that is pinned', () => {
  it('has no async or await in any module that declares an install scope', () => {
    // MEASURED at 6: the six installer modules that call `withInstallScope`. It is the CALLERS that
    // matter -- `project_scope_guard.ts` itself is deliberately not a member, since `export function
    // withInstallScope<T>(` is a definition rather than a call, and a definition has no scope to
    // leak. Floor at the measured count (this population may not shrink at all without someone
    // having removed an installer's containment) and ceiling a little above, re-pinned together.
    // Anchored EXACTLY, since as a substring `install.ts` also matches `pi_install.ts` and every
    // other member, so that anchor would survive `src/install.ts` being deleted outright.
    const offenders: string[] = []
    for (const rel of pinnedPopulation({
      what: 'modules that call withInstallScope and so depend on a synchronous restore',
      items: scopeDeclaringModules(),
      floor: 6,
      ceiling: 10,
      mustIncludeExact: ['bridges/copilot_cli_install.ts', 'bridges/cursor_install.ts', 'bridges/pi_install.ts', 'bridges/visualstudio_install.ts', 'bridges/vscode_install.ts', 'install.ts'],
    })) {
      const code = fs.readFileSync(path.join(SRC, rel), 'utf8')
      // Block comments blanked (not deleted) so reported line numbers stay true; this very file's
      // header would otherwise match its own rule.
      const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      if (ASYNC_SYNTAX.test(codeOnly)) offenders.push(rel)
    }

    expect(
      offenders,
      'This module calls withInstallScope and contains async/await. The scope is a module-level ' +
        'variable restored in a finally, so it is put back at the first await rather than at the end ' +
        'of the run -- every write after that point executes with containment switched off, silently. ' +
        'Either keep the installer synchronous, or move the scope to AsyncLocalStorage FIRST and then ' +
        'delete this guard in the same commit.',
    ).toEqual([])
  })

  it('refuses at run time a scoped function that returns a thenable', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-sync-')))
    try {
      // POSITIVE CONTROL, first: the same call shape with a synchronous body must work, or the
      // refusal below is indistinguishable from withInstallScope being broken outright.
      expect(withInstallScope(root, () => 'sync-result')).toBe('sync-result')

      expect(() => withInstallScope(root, () => Promise.resolve('async-result'))).toThrow(/thenable/i)
      // A hand-rolled thenable too: the check is on the shape, not on being a real Promise, because
      // that is what an installer returning some library's deferred would hand it.
      expect(() => withInstallScope(root, () => ({ then: () => undefined }))).toThrow(/thenable/i)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the outer scope after the refusal rather than leaving containment stuck on', () => {
    // The refusal runs inside the `try`, so the `finally` still restores. If it did not, one thrown
    // error would leave a project root latched for the rest of the process and every later
    // user-scope write in the same run would start failing.
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-restore-')))
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-outside-')))
    try {
      // In-band positive control: inside the scope, an outside target really is refused. Without
      // this, the "allowed" assertion after it could pass on a guard that never refuses anything.
      withInstallScope(root, () => {
        expect(() => assertWriteInScope(path.join(outside, 'x.json'))).toThrow(/resolves outside the project/)
        expect(() => assertWriteInScope(path.join(root, 'x.json'))).not.toThrow()
      })

      expect(() => withInstallScope(root, () => Promise.resolve(1))).toThrow(/thenable/i)

      // Back at user scope: the same outside target is allowed again, so the scope was restored.
      expect(() => assertWriteInScope(path.join(outside, 'x.json'))).not.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
