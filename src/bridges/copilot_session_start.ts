import { SHIM_SESSION_START_TIMEOUT_MS } from './shim_common.js'

/** Standalone helpers embedded into the generated shared Copilot/VS Code shim. */
export const COPILOT_SESSION_START_HELPERS = `
const SHIM_SESSION_START_TIMEOUT_MS = ${SHIM_SESSION_START_TIMEOUT_MS}
const SESSION_START_CLEANUP_RESERVE_MS = 1000
const SESSION_START_MAX_INPUT_BYTES = 1024 * 1024

function failOpenSessionStart(reason) {
  process.stderr.write('[token-goat] SessionStart failed open: ' + reason + '\\n')
  process.stdout.write('{}')
}

function readSessionStartInput(timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const closers = []
    let totalBytes = 0
    let frameStart = -1
    let frameEnd = -1
    let inString = false
    let escaped = false
    let settled = false
    let timer

    function cleanup() {
      clearTimeout(timer)
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      process.stdin.pause()
      if (typeof process.stdin.unref === 'function') process.stdin.unref()
      process.stdin.destroy()
    }

    function finish(error, value) {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(new Error(error))
      else resolve(value)
    }

    function onData(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const chunkStart = totalBytes
      totalBytes += bytes.length
      if (totalBytes > SESSION_START_MAX_INPUT_BYTES) {
        finish('input exceeded 1 MiB')
        return
      }
      chunks.push(bytes)

      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index]
        const position = chunkStart + index
        if (frameEnd !== -1) {
          if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
            finish('input contained trailing data')
            return
          }
          continue
        }
        if (frameStart === -1) {
          if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
          if (byte !== 0x7b) {
            finish('input was not a JSON object')
            return
          }
          frameStart = position
          closers.push(0x7d)
          continue
        }
        if (inString) {
          if (escaped) escaped = false
          else if (byte === 0x5c) escaped = true
          else if (byte === 0x22) inString = false
          continue
        }
        if (byte === 0x22) {
          inString = true
        } else if (byte === 0x7b) {
          closers.push(0x7d)
        } else if (byte === 0x5b) {
          closers.push(0x5d)
        } else if (byte === 0x7d || byte === 0x5d) {
          if (closers.pop() !== byte) {
            finish('input contained malformed JSON')
            return
          }
          if (closers.length === 0) frameEnd = position + 1
        }
      }

      if (frameEnd !== -1) {
        const framed = Buffer.concat(chunks, totalBytes)
        const raw = framed.subarray(frameStart, frameEnd).toString('utf8')
        try {
          const parsed = JSON.parse(raw)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            finish('input was not a JSON object')
            return
          }
        } catch {
          finish('input contained malformed JSON')
          return
        }
        finish(undefined, raw)
      }
    }

    function onEnd() {
      finish(frameStart === -1 ? 'stdin closed without input' : 'stdin closed before the JSON object was complete')
    }

    function onError() {
      finish('stdin could not be read')
    }

    // A payload already in the pipe must be framed even when the deadline has passed, so the expiry is deferred one turn: the poll phase delivers buffered stdin before setImmediate runs.
    timer = setTimeout(() => setImmediate(() => finish('input deadline exceeded')), Math.max(0, timeoutMs))
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
    process.stdin.resume()
  })
}

// Plain-JS mirror of session_start_owed.ts::resetSessionStartOwed for a main-thread key: tests/session_start_owed_reset.test.ts pins both to the same files. It runs before anything can throw so a helper killed before its own stamp still leaves the start begun, and an earlier start's marker cannot read settled.
function resetSessionStartOwedFiles(payload) {
  try {
    const raw = payload && (payload.session_id !== undefined ? payload.session_id : payload.sessionId)
    if (typeof raw !== 'string' || raw === '' || raw.indexOf(':agent:') !== -1) return
    // A subagent's key is salted, and its start is not the parent's to reset.
    if (payload.agent_id || payload.agentId) return
    const override = (process.env.TOKEN_GOAT_HOME || '').trim()
    const rooted = override !== '' && require('node:path').isAbsolute(override) &&
      (process.platform !== 'win32' || !['', '/', String.fromCharCode(92)].includes(require('node:path').parse(override).root))
    const home = rooted ? override : require('node:path').join(require('node:os').homedir(), '.token-goat')
    const stem = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    if (stem === '') return
    // The claim goes, and the settle file is rewritten as a begun stamp: only a begun, unsettled start is owed.
    require('node:fs').rmSync(require('node:path').join(home, 'sessions', stem + '.session-start-owed'), { force: true })
    require('node:fs').mkdirSync(require('node:path').join(home, 'sessions'), { recursive: true })
    require('node:fs').writeFileSync(require('node:path').join(home, 'sessions', stem + '.session-start'), JSON.stringify({ begunAtMs: Date.now() }), 'utf8')
  } catch {
    // Best-effort: the helper clears the marker itself when it gets that far.
  }
}

async function runBoundedSessionStart(entryPath, eventName, payload, harness, deadline) {
  resetSessionStartOwedFiles(payload)
  // Do not probe entryPath here: even existsSync can block on a network filesystem.
  if (typeof entryPath !== 'string' || entryPath === '') throw new Error('hook entry unavailable')
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new Error('overall deadline exceeded')
  // Reject before spawning when only the process-tree teardown reserve remains.
  if (remainingMs <= SESSION_START_CLEANUP_RESERVE_MS) {
    throw new Error('insufficient time for process-tree cleanup')
  }

  const args = [entryPath, 'hook', eventName]
  const env = Object.assign({}, process.env, { TOKEN_GOAT_HOOK_SERVER: '0' })
  if (process.platform === 'win32') env.TG_SESSION_START_DEFER_WORKER = '1'
  // Lets the helper's settle marker say how close to the deadline it finished.
  env.TG_SESSION_START_DEADLINE_EPOCH = String(deadline)
  if (harness === 'vscode') {
    args.push('--harness', 'vscode')
    env.TOKEN_GOAT_HARNESS_OVERRIDE = 'vscode'
    env.TOKEN_GOAT_VSCODE_HOOKS_DIR = __dirname
  } else {
    env.TOKEN_GOAT_HARNESS_OVERRIDE = 'copilot_cli'
    env.TOKEN_GOAT_COPILOT_HOOKS_DIR = __dirname
  }

  const stdout = await superviseSessionStart({ args, env, payload, deadline })
  try {
    const parsed = JSON.parse(stdout.trim())
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('hook helper returned a non-object response')
    }
    return JSON.stringify(parsed)
  } catch {
    throw new Error('hook helper returned invalid JSON')
  }
}

function superviseSessionStart({ args, env, payload, deadline }) {
  if (process.platform === 'win32') return superviseWindowsSessionStart({ args, env, payload, deadline })
  const { spawn } = require('node:child_process')
  // On POSIX, retain the canonical root until its detached group is killed.
  const supervisor = [
    "const keeper = setInterval(() => {}, 1000); keeper.unref()",
    "let finished = false",
    "function done(code) { if (finished) return; finished = true; keeper.ref(); process.send({ type: 'hookExit', code }) }",
    "process.exit = code => done(code === undefined ? (process.exitCode || 0) : Number(code))",
    "process.once('beforeExit', code => done(code))",
    "process.once('uncaughtException', () => done(1))",
    "process.once('unhandledRejection', () => done(1))",
    "import(require('node:url').pathToFileURL(require('node:path').resolve(process.argv[1])).href).catch(() => done(1))",
  ].join(';')
  return new Promise((resolve, reject) => {
    const root = spawn(process.execPath, ['-e', supervisor, ...args], {
      env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    let helperCode
    let rootClosed = false
    let cleaning = false
    let cleaned = false
    let settled = false
    let failure
    let outputBytes = 0
    const output = []
    let stderrBytes = 0
    let timer
    let hardTimer

    function alive(pid) {
      if (!pid) return false
      try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
    }

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      root.removeListener('message', onMessage)
      root.removeListener('exit', onExit)
      root.removeListener('close', onClose)
      root.stdout.removeListener('data', onOutput)
      root.stderr.removeListener('data', onStderr)
      root.stdin.destroy()
      root.stdout.destroy()
      root.stderr.destroy()
      if (root.connected) root.disconnect()
      root.unref()
      if (error) reject(new Error(error))
      else resolve(Buffer.concat(output, outputBytes).toString('utf8'))
    }

    function complete() {
      // close, not exit, proves all buffered stdout was drained. The hard deadline
      // below also covers an escaped descendant retaining a pipe indefinitely.
      if (!cleaned || !rootClosed) return
      if (!failure && (helperCode !== 0 || outputBytes === 0)) failure = 'hook helper exited without a response'
      finish(failure)
    }

    function cleanupFailed(reason) {
      // Verify the known owned PIDs before falling back to direct kills. Unknown
      // descendants cannot be certified clean when the tree utility has failed.
      const remaining = [root.pid].filter(alive)
      for (const pid of remaining) {
        try { process.kill(pid, 'SIGKILL') } catch (error) {
          if (error.code !== 'ESRCH') reason += '; direct kill failed for PID ' + pid
        }
      }
      finish((failure ? failure + '; ' : '') + 'process-tree cleanup failed: ' + reason
        + '; remaining owned PIDs before fallback: ' + (remaining.join(',') || 'none')
        + '; remaining known PIDs after fallback: ' + (remaining.filter(alive).join(',') || 'none')
        + '; descendant termination not verified')
    }

    function beginCleanup(reason) {
      if (reason && !failure) failure = reason
      if (settled || cleaning) return
      cleaning = true
      clearTimeout(timer)
      if (!root.pid) { finish(failure || 'hook helper could not run'); return }
      try {
        process.kill(-root.pid, 'SIGKILL')
        cleaned = true
        complete()
      } catch (error) {
        cleanupFailed(error.code || 'group kill failed')
      }
    }

    function onOutput(chunk) {
      outputBytes += chunk.length
      if (outputBytes > SESSION_START_MAX_INPUT_BYTES) { beginCleanup('hook helper output exceeded 1 MiB'); return }
      output.push(chunk)
    }

    function onStderr(chunk) {
      stderrBytes += chunk.length
      if (stderrBytes > SESSION_START_MAX_INPUT_BYTES) beginCleanup('hook helper stderr exceeded 1 MiB')
    }

    function onMessage(message) {
      if (message && message.type === 'hookExit') {
        helperCode = message.code
        beginCleanup(message.code === 0 ? undefined : 'hook helper exited without a response')
      }
    }

    function onExit() {
      if (!cleaning) cleanupFailed('supervisor exited before tree cleanup')
    }

    function onClose() { rootClosed = true; complete() }

    root.on('message', onMessage)
    root.once('exit', onExit)
    root.once('close', onClose)
    root.once('error', () => beginCleanup('hook helper could not run'))
    root.stdin.on('error', () => beginCleanup('hook helper input failed'))
    root.stdout.on('data', onOutput)
    root.stderr.on('data', onStderr)
    root.stdout.on('error', () => beginCleanup('hook helper stdout failed'))
    root.stderr.on('error', () => beginCleanup('hook helper stderr failed'))
    const remaining = deadline - Date.now()
    // Reserve the final second of the single 3 s budget for owned-tree teardown.
    timer = setTimeout(() => beginCleanup('hook helper timed out'), Math.max(0, remaining - SESSION_START_CLEANUP_RESERVE_MS))
    hardTimer = setTimeout(() => cleanupFailed('overall deadline exceeded'), Math.max(0, remaining))
    root.stdin.end(JSON.stringify(payload))
  })
}

function superviseWindowsSessionStart({ args, env, payload, deadline }) {
  const { spawn } = require('node:child_process')
  const path = require('node:path')
  // Pure path arithmetic on the trusted installed entry, never PATH lookup or
  // synchronous filesystem probing in the externally visible parent.
  const binary = path.join(path.dirname(args[0]), 'native', 'win32-' + process.arch, 'tg-hook.exe')
  return new Promise((resolve, reject) => {
    const root = spawn(binary, ['--session-start-owner-v1', String(deadline), process.execPath, ...args], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const output = []
    const diagnostics = []
    let outputBytes = 0
    let diagnosticBytes = 0
    let settled = false
    let timer
    function finish(error, candidate) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      root.stdin.destroy()
      root.stdout.destroy()
      root.stderr.destroy()
      // Killing the owner closes the sole non-inherited job handle. Never
      // traverse a dead canonical PID or launch an unowned Windows fallback.
      if (error && root.pid) root.kill('SIGKILL')
      root.unref()
      if (error) reject(new Error(error))
      else resolve(JSON.stringify(candidate))
    }
    root.once('error', error => finish('native startup owner unavailable: ' + error.message))
    root.stdin.on('error', error => finish('native startup owner input failed: ' + error.message))
    root.stdout.on('error', error => finish('native startup owner stdout failed: ' + error.message))
    root.stderr.on('error', error => finish('native startup owner stderr failed: ' + error.message))
    root.stdout.on('data', chunk => {
      outputBytes += chunk.length
      if (outputBytes > SESSION_START_MAX_INPUT_BYTES + 4096) finish('native startup owner output exceeded 1 MiB')
      else output.push(chunk)
    })
    root.stderr.on('data', chunk => {
      diagnosticBytes += chunk.length
      if (diagnosticBytes > SESSION_START_MAX_INPUT_BYTES) finish('native startup owner stderr exceeded 1 MiB')
      else diagnostics.push(chunk)
    })
    root.once('close', code => {
      if (settled) return
      const diagnostic = Buffer.concat(diagnostics).toString('utf8').trim()
      if (code !== 0) { finish('native startup owner failed: ' + (diagnostic || 'exit ' + code)); return }
      let ack
      try { ack = JSON.parse(Buffer.concat(output).toString('utf8')) } catch {
        finish('native startup owner returned invalid protocol JSON'); return
      }
      if (!ack || ack.protocol !== 'tg-session-start-owner-v1' || ack.capability !== 'atomic-job-list'
          || ack.activeProcesses !== 0 || ack.rootExited !== true || ack.pipesDrained !== true
          || !ack.candidate || typeof ack.candidate !== 'object' || Array.isArray(ack.candidate)) {
        finish('native startup owner incompatible protocol or unverified cleanup'); return
      }
      if (ack.workerWake === true) {
        // The installed native entry owns this shim too. Relay only a bounded
        // request; it, not an inner owner, must launch outside every startup job.
        if (process.argv[4] && process.argv[4].startsWith('--session-start-deadline=')) {
          process.stderr.write('\\x1eTG_WORKER_WAKE_V1\\x1e\\n')
        } else if (process.env.TOKEN_GOAT_NO_WORKER_SPAWN !== '1') {
          const workerEnv = Object.assign({}, process.env)
          delete workerEnv.TG_SESSION_START_DEFER_WORKER
          try {
            const worker = spawn(process.execPath, [args[0], '--worker-daemon', '--claim-worker'], {
              env: workerEnv, cwd: require('node:os').tmpdir(), detached: true, windowsHide: true, stdio: 'ignore',
            })
            worker.on('error', () => {})
            worker.unref()
          } catch {
            // Queue remains durable; ordinary lifecycle activation can retry.
          }
        }
      }
      finish(undefined, ack.candidate)
    })
    timer = setTimeout(() => finish('native startup owner overall deadline exceeded'), Math.max(0, deadline - Date.now()))
    root.stdin.end(JSON.stringify(payload))
  })
}
`
