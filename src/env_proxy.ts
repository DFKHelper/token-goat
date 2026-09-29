/** Completes the proxy settings the background worker starts with, so its downloads go through a proxy the machine already names. Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set as well, and it has only honoured the pair since 22.21.0 on the 22 line and 24.0.0 (the v22.21.0 release notes, nodejs/node#57165). A machine that reaches the internet through a proxy therefore usually has the first variable and not the second, and every download token-goat makes fails with a bare "fetch failed". The background worker makes most of those downloads, and token-goat starts it, so its environment is the one place the pair can be completed without asking the user. */

export const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const

/** Whether `env` names a proxy. */
export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_VARS.some((k) => (env[k] ?? '').trim() !== '')
}

/** Whether this Node's fetch honours HTTPS_PROXY under NODE_USE_ENV_PROXY=1: from 22.21.0 on the 22 line, and every release from 24.0.0. */
export function nodeFetchHonoursEnvProxy(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10))
  if (major >= 24) return true
  return major === 22 && minor >= 21
}

/** Whether this process's fetch goes around a proxy the machine names, when the worker's would not: a proxy is set, NODE_USE_ENV_PROXY is not, and this Node honours the flag. Node reads the flag once at startup, so setting it now changes nothing here; a download this process makes connects directly and fails where the worker, started with the flag (worker_lifecycle.ts), goes through. On a Node that cannot use the flag the worker is no better off, so there is nothing to leave to it and this answers false. */
export function fetchBypassesProxy(env: NodeJS.ProcessEnv = process.env, nodeVersion: string = process.versions.node): boolean {
  return env['NODE_USE_ENV_PROXY'] === undefined && proxyConfigured(env) && nodeFetchHonoursEnvProxy(nodeVersion)
}

type SpawnSyncLike = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: 'inherit' }) => { status: number | null }

/** Run this command again in a child that has NODE_USE_ENV_PROXY=1, and return the child's exit code; null when fetchBypassesProxy says this process already downloads the way the child would, so the caller carries on itself. For the commands whose whole job is a download the user asked for (`semantic --warm`, `doctor --repair`): deferring those to the worker would answer the user's "now" with "later". The child's environment names the flag, so it answers null and cannot run itself again. */
export function rerunWithEnvProxy(
  spawn: SpawnSyncLike,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  nodeVersion: string = process.versions.node,
): number | null {
  if (!fetchBypassesProxy(env, nodeVersion)) return null
  const result = spawn(process.execPath, [...process.execArgv, ...argv.slice(1)], { env: withEnvProxyEnabled(env, nodeVersion), stdio: 'inherit' })
  // A child ended by a signal has no status; that is a failure, not a success.
  return result.status ?? 1
}

/** `env` with NODE_USE_ENV_PROXY=1 added when it names a proxy this Node can use and says nothing about the flag itself. A value the user set, including 0, is theirs and stays. Only fetch and the http/https modules read the flag; the worker's own IPC goes over `net` sockets, which it does not touch. */
export function withEnvProxyEnabled(env: NodeJS.ProcessEnv, nodeVersion: string = process.versions.node): NodeJS.ProcessEnv {
  if (env['NODE_USE_ENV_PROXY'] !== undefined || !proxyConfigured(env) || !nodeFetchHonoursEnvProxy(nodeVersion)) return env
  return { ...env, NODE_USE_ENV_PROXY: '1' }
}
