// Shared, once-per-module-load probe for whether this machine lets an unprivileged process create
// a symbolic link.
//
// Windows refuses `symlinkSync` to a process that is neither elevated nor running with Developer
// Mode on, so every symlink fixture in this suite has to cope with the link simply not being
// creatable. Before this helper, each site coped the same way and invisibly: `try { symlinkSync(...) }
// catch { return }` inside the test body, which reports PASSED on a machine that never built the
// fixture, never ran the assertion, and never said so. `it.skipIf(!CAN_SYMLINK)` reports SKIPPED
// instead, which is the honest answer and is visible in the run summary.
//
// Evaluated once at import, not per call: the probe itself creates and removes a link, and doing
// that once per test would be both slower and more likely to race. It creates its scratch directory
// under the OS temp root with `mkdtempSync` and removes the whole directory in a `finally`, so a
// failure at any point still leaves nothing behind -- including on the Windows path where the
// symlink call throws before the link exists.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function probe(kind: 'file' | 'junction'): boolean {
  let dir: string | null = null
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-symlink-probe-'))
    if (kind === 'junction') {
      // A junction needs a real directory to point at, unlike the dangling-target case below.
      mkdirSync(path.join(dir, 'target'))
      symlinkSync(path.join(dir, 'target'), path.join(dir, 'probe'), 'junction')
      return true
    }
    // A dangling target is deliberate: the question is whether the OS grants the privilege, not whether any particular file exists. POSIX creates a dangling link happily; Windows throws EPERM here exactly when it would throw for a real fixture.
    symlinkSync(path.join(dir, 'nothing'), path.join(dir, 'probe'), 'file')
    return true
  } catch {
    return false
  } finally {
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best effort: a temp directory left behind by a failed cleanup is not worth failing a run over, and the OS temp root is swept independently.
      }
    }
  }
}

/** True when this process can create a file or directory symbolic link. See the module comment for why it is a constant rather than a function. */
export const CAN_SYMLINK: boolean = probe('file')

// Windows junctions are a separate privilege from symlinks and an unprivileged process can normally create one, so a fixture that only plants junctions on Windows runs on machines where CAN_SYMLINK is false. Gating those on CAN_SYMLINK would skip tests that currently run, which is why this is a second probe rather than one flag for both. On POSIX, Node maps the 'junction' type onto a directory symlink, so the two answers coincide there by construction.
export const CAN_JUNCTION: boolean = probe('junction')
