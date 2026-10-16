/** HAND-DERIVED: runs the embedded Copilot shim as an async child whose exit is awaited, with no timer of its own (the per-test vitest timeout is the only bound); tree teardown on every path is cleanupTrees, which walks each registered pid's descendants and sweeps any process whose command line names a registered root. */
import { spawn } from 'node:child_process'

import { ownedPids, ownedRoots } from './copilot_session_start_tree.js'

export interface ShimRun { status: number | null; stdout: string; stderr: string }

/** Starts `node <args>` in `cwd`, feeds it `stdin`, and resolves when the child has closed. The child pid and `cwd` are registered with cleanupTrees before anything can fail, so a vitest timeout or a rejected assertion still kills the whole tree and removes the directory. */
export function runNodeAsync(options: { args: string[]; cwd: string; stdin: string; env?: NodeJS.ProcessEnv }): Promise<ShimRun> {
  if (!ownedRoots.includes(options.cwd)) ownedRoots.push(options.cwd)
  return new Promise<ShimRun>((resolve, reject) => {
    const child = spawn(process.execPath, options.args, { cwd: options.cwd, env: options.env, stdio: 'pipe', windowsHide: true })
    if (child.pid !== undefined) ownedPids.push(child.pid)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.stdin.on('error', () => undefined)
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(options.stdin)
  })
}
