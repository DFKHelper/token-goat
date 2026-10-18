// A stand-in for `token-goat --batch-serve <token>` whose behaviour each request chooses with its first argument, so a test controls the event (a reply, a death, a process tree, a hang, a forged reply ahead of the real one, a reply in two writes, a clean exit, a long stderr) instead of waiting on a clock. Provenance: FORMAT-DERIVED from the reply framing in tests/helpers/batch-cli.ts (a line `<token> <json>` with id, status, stdout, stderr); this file serves no real command.
import { spawn } from 'node:child_process'
import process from 'node:process'
import * as readline from 'node:readline'
import { setInterval } from 'node:timers'

const token = process.argv[2]
// Alive until killed, whatever happens to stdin: a test that proves a tree was ended must not have the server leave on its own when its input closes. owner: the test process that started this stand-in; dies when that process is gone, checked once a second, or when the client ends the tree.
const owner = process.ppid
setInterval(() => {
  try {
    process.kill(owner, 0)
  } catch {
    process.exit(0)
  }
}, 1000)

// The second half of a `split` reply, held until a `release` request arrives.
let held = ''

function reply(id, stdout) {
  process.stdout.write(`${token} ${JSON.stringify({ id, status: 0, stdout, stderr: '' })}\n`)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, argv } = JSON.parse(line)
  const [mode, ...rest] = argv
  if (mode === 'echo') reply(id, rest.join(' '))
  else if (mode === 'die') {
    process.stderr.write(`stand-in cannot serve: ${rest.join(' ')}\n`)
    process.exit(3)
  } else if (mode === 'stray') {
    // A forged reply for this request under a token that is not the session's, same length so a client that skipped the token check would parse it, written ahead of the real reply.
    process.stdout.write(`${'-'.repeat(token.length)} ${JSON.stringify({ id, status: 9, stdout: 'forged', stderr: 'forged' })}\n`)
    reply(id, rest.join(' '))
  } else if (mode === 'quit') {
    process.exit(0)
  } else if (mode === 'stderr') {
    // The write callback runs once the text is handed to the pipe, so the exit cannot cut it short.
    process.stderr.write(rest[0], () => process.exit(4))
  } else if (mode === 'split') {
    const text = `${token} ${JSON.stringify({ id, status: 0, stdout: rest.join(' '), stderr: '' })}\n`
    const half = Math.floor(text.length / 2)
    held = text.slice(half)
    process.stdout.write(text.slice(0, half))
  } else if (mode === 'release') {
    process.stdout.write(held)
  } else if (mode === 'tree') {
    // The grandchild shares this process's stderr pipe, so the client's `close` fires only once the grandchild is gone too. It is detached because, measured on Windows with it attached, a client that ended only the root still left no survivor (the grandchild died with its parent), so the row could not tell a tree kill from a root kill; a tree kill still reaches it. owner: the test process that started this stand-in (this process's parent); dies when that process is gone, checked once a second, or when the client ends the tree.
    const watch = 'const owner = Number(process.argv[1]); setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 1000)'
    const grandchild = spawn(process.execPath, ['-e', watch, String(process.ppid)], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] })
    reply(id, JSON.stringify({ server: process.pid, grandchild: grandchild.pid }))
  }
  // Any other mode (`hang`) is read and never answered.
})
