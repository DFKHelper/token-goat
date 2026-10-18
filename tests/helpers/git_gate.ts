// A gate a real git blocks on until the test lets it go, with an event for the moment git reached it. PROVENANCE: CAPTURE. Measured on this machine's Windows git and on WSL Ubuntu git (see tests/git_gate.test.ts): a config include served by a Windows named pipe, or by a POSIX FIFO, leaves `git rev-parse` blocked until the serving end closes, after which git exits 0 with its normal answer. This is not the lock-file of tests/run_git_timeout_reaps_git.test.ts: that one blocks `git pack-refs` only, and neither `rev-parse --show-toplevel` nor `ls-files` (the worker's reconcile commands) waits on any lock file.
import { execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

export interface GitGate {
  /** Environment variables that make every git started with them read the gate as a config include, and so block on it until {@link release}. */
  readonly env: Readonly<Record<string, string>>
  /** Resolves once a git has opened the gate and is blocked reading it. It resolves on the event loop of the process holding the gate, so a caller that blocked that loop on the git (a synchronous spawn) never sees it resolve. */
  readonly reached: Promise<void>
  /** Lets every git blocked on the gate go, and every git that reaches it later. */
  release(): void
  /** Releases, stops serving and removes what the gate created. Safe to call twice. */
  dispose(): Promise<void>
}

/** Keys the gate sets. A caller restoring the environment names these. */
export const GIT_GATE_ENV_KEYS = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const

function environmentFor(target: string): Record<string, string> {
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: target }
}

/** Serves the gate as a Windows named pipe: each connection git makes is held open until release, then ended with no data, which git reads as an empty config file. */
async function windowsGate(): Promise<GitGate> {
  const target = String.raw`\\.\pipe\tg-git-gate-` + crypto.randomBytes(8).toString('hex')
  const held = new Set<net.Socket>()
  let released = false
  let signal!: () => void
  const reached = new Promise<void>((resolve) => {
    signal = resolve
  })
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    signal()
    if (released) {
      socket.end()
      return
    }
    held.add(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(target, resolve)
  })
  const release = (): void => {
    released = true
    for (const socket of held) socket.end()
    held.clear()
  }
  let disposed = false
  return {
    env: environmentFor(target),
    reached,
    release,
    async dispose() {
      if (disposed) return
      disposed = true
      release()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Serves the gate as a FIFO: opening it for writing completes only once a reader (git) has it open, which is the `reached` event; closing the writer is the end of file git reads as an empty config file. */
async function fifoGate(): Promise<GitGate> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-git-gate-'))
  const target = path.join(root, 'gate')
  execFileSync('mkfifo', [target], { stdio: 'ignore' })
  let released = false
  let disposed = false
  let signal!: () => void
  let open!: () => void
  const reached = new Promise<void>((resolve) => {
    signal = resolve
  })
  const releasedEvent = new Promise<void>((resolve) => {
    open = resolve
  })
  const serving = (async () => {
    while (!disposed) {
      let writer: FileHandle
      try {
        writer = await fs.promises.open(target, 'w')
      } catch {
        return
      }
      signal()
      if (!released) await releasedEvent
      await writer.close()
    }
  })()
  const release = (): void => {
    released = true
    open()
  }
  return {
    env: environmentFor(target),
    reached,
    release,
    async dispose() {
      if (disposed) return
      disposed = true
      release()
      // A writer still waiting in open() for a reader that never came is let through by holding the read end open until the serving loop has ended.
      let reader: number | null = null
      try {
        reader = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
      } catch {
        // The gate is already gone.
      }
      await serving
      if (reader !== null) fs.closeSync(reader)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Opens a gate. The caller starts git with {@link GitGate.env} (or sets those variables in its own environment), waits for {@link GitGate.reached}, and calls {@link GitGate.release} when the blocked git may go on; {@link GitGate.dispose} belongs in a `finally`/`afterEach`, since a gate never released leaves its git blocked. */
export async function openGitGate(): Promise<GitGate> {
  return process.platform === 'win32' ? windowsGate() : fifoGate()
}
