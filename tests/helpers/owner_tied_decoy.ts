import { spawn, type ChildProcess } from 'node:child_process'

/** The variable that tells a decoy which process owns it. */
export const DECOY_OWNER_PID_ENV = 'TG_DECOY_OWNER_PID'

/** The script a stand-in resident runs: it idles, and leaves once its owner is gone, so a hard-killed test run cannot leave it behind (a plain idle loop has no death condition at all). */
export const OWNER_TIED_DECOY_SOURCE = `const owner = Number(process.env.${DECOY_OWNER_PID_ENV}); setInterval(() => { try { process.kill(owner, 0) } catch (err) { if (err.code !== 'EPERM') process.exit(0) } }, 1000)`

/** The environment a decoy running OWNER_TIED_DECOY_SOURCE needs: the caller's, plus the pid of the process that owns it (default: this one). */
export function ownedDecoyEnv(ownerPid: number = process.pid, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [DECOY_OWNER_PID_ENV]: String(ownerPid) }
}

/** Start a stand-in for a worker daemon: `node -e <idle script> -- <extraArgs>`. Only its command line is meant to look like a daemon's; it runs none of the daemon's code. */
export function spawnOwnedDecoy(extraArgs: readonly string[], ownerPid: number = process.pid): ChildProcess {
  // owner: the process whose pid is in TG_DECOY_OWNER_PID (the vitest worker by default); dies when that process is gone, found by the liveness check the decoy itself runs each second
  return spawn(process.execPath, ['-e', OWNER_TIED_DECOY_SOURCE, '--', ...extraArgs], { stdio: 'ignore', windowsHide: true, env: ownedDecoyEnv(ownerPid) })
}
