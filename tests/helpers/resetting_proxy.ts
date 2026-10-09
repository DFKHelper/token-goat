import { spawn, type ChildProcess } from 'node:child_process'

// Runs in its own process because the bundle under test is started with spawnSync, which blocks this process's event loop and would leave a server here unanswered.
const SERVER_SOURCE = "const net = require('node:net'); const s = net.createServer((sock) => { sock.on('error', () => {}); sock.once('data', () => sock.resetAndDestroy()) }); s.listen(0, '127.0.0.1', () => console.log(s.address().port))"

export interface ResettingProxy {
  /** `http://127.0.0.1:<port>` of a listener that resets the first request it reads. */
  url: string
  stop(): void
}

/** A proxy that accepts the connection and resets it, so a client behind it fails with ECONNRESET on every platform. A refused connection (a closed port) is not portable: on WSL2 with mirrored networking and the Windows firewall on, a connect to a closed loopback port is dropped and times out instead of being refused. */
export async function startResettingProxy(): Promise<ResettingProxy> {
  const child: ChildProcess = spawn(process.execPath, ['-e', SERVER_SOURCE], { stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const line = out.split('\n')[0]?.trim() ?? ''
      if (/^\d+$/.test(line) && out.includes('\n')) resolve(line)
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`the resetting proxy exited (${String(code)}) before it listened`)))
  })
  return { url: `http://127.0.0.1:${port}`, stop: () => void child.kill() }
}
