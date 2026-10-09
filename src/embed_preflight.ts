/** Whether semantic search can run now, and when it cannot because the embedding model has not downloaded, why and what fixes it. checkEmbeddingPreflight in embed_model.ts answers from configuration and the files on disk; it cannot see a download that failed in another process, so with the network blocked it reported "load_error ... Check model integrity" after a `--warm`, and "0 of N files have embeddings, run `token-goat index`" otherwise, and neither is the problem or the fix. This file reads the failure the download recorded (model_download_gate.ts) and rewrites the result to say so. It lives outside embed_model.ts because that file is hashed into EMBED_FINGERPRINT and a wording change here must not re-embed anyone's index; nothing here changes a vector. */

import { getProjectConfigInfo, loadConfig, resolveConfigKeyLayer } from './config.js'
import { displaySafeText } from './paths.js'
import { modelDir, modelFilesPresent, type EmbeddingPreflightResult } from './embed_model.js'
// Through embeddings.js, the module every other caller takes it from, so a test that stubs the preflight there stubs it here too.
import { checkEmbeddingPreflight } from './embeddings.js'
import { fetchBypassesProxy, nodeFetchHonoursEnvProxy, proxyConfigured } from './env_proxy.js'
import { activeRuntime, NATIVE_RUNTIME_INSTALL, wasmBinaryPresent } from './embed_runtime.js'
import { activeDownloadCooldown, isExplicitDownload, lastDownloadFailure, MODEL_DOWNLOAD_HOST, RUNTIME_DOWNLOAD_HOST } from './model_download_gate.js'
import { countNoun } from './util.js'

/** The approximate size of the pinned model files together (711 396 + 34 014 426 bytes). */
const MODEL_MB = 35

/** The command that downloads the model now, through any hold. */
export const WARM_COMMAND = 'token-goat semantic --preflight --warm'

/** The hosts an embed still has to download from before it can produce a vector: huggingface.co while the model files are missing, and registry.npmjs.org while the WebAssembly runtime is the one in use and its binary is missing. Checking only the model host let the worker retry the runtime tarball on every file once the model was in place, since nothing looked at that host's hold. */
function pendingDownloadHosts(): string[] {
  const hosts: string[] = []
  if (!modelFilesPresent()) hosts.push(MODEL_DOWNLOAD_HOST)
  if (activeRuntime() === 'onnxruntime-web' && !wasmBinaryPresent()) hosts.push(RUNTIME_DOWNLOAD_HOST)
  return hosts
}

/** True when an automatic download for embedding should not be tried now: something it needs (the model files, or the WebAssembly runtime's binary) is not on this machine, and either offline mode forbids the download or the last try at that host failed recently enough that repeating it would only fail again. The worker checks this before each embed so a blocked network costs one failed download per hold rather than one per file. */
export function modelDownloadHeld(now: number = Date.now()): boolean {
  const hosts = pendingDownloadHosts()
  if (hosts.length === 0) return false
  if (loadConfig().network?.offline === true) return true
  return hosts.some((host) => activeDownloadCooldown(host, now) !== null)
}

/** modelDownloadHeld, plus the case where only this process is stuck: a download is still needed, this process's fetch would go around the machine's proxy (env_proxy.ts fetchBypassesProxy), and the user did not ask for the download by name. Such a try fails and records a hold on the host, and that hold then stops the worker too, whose downloads do go through the proxy. Only foreground callers ask this; the worker asks modelDownloadHeld, since it is the process these downloads are left to. */
export function foregroundDownloadDeferred(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env, nodeVersion: string = process.versions.node): boolean {
  if (modelDownloadHeld(now)) return true
  return !isExplicitDownload() && fetchBypassesProxy(env, nodeVersion) && pendingDownloadHosts().length > 0
}

/** What to try when the model download failed, shaped by this machine's proxy settings. */
export function downloadAdvice(env: NodeJS.ProcessEnv = process.env, nodeVersion: string = process.versions.node): string {
  return `${proxyAdvice(env, nodeVersion)}, or copy the model files into ${modelDir()}. Then run \`${WARM_COMMAND}\` to download it now.`
}

/** What to try when the WebAssembly runtime's download failed. Copying model files does nothing for it; the native runtime is the way around a registry this machine cannot reach. */
export function runtimeDownloadAdvice(env: NodeJS.ProcessEnv = process.env, nodeVersion: string = process.versions.node): string {
  return `${proxyAdvice(env, nodeVersion)}, or ${NATIVE_RUNTIME_INSTALL}. Then run \`${WARM_COMMAND}\` to download it now.`
}

/** With NODE_USE_ENV_PROXY unset, token-goat's downloads already go through a proxy named in HTTPS_PROXY (env_proxy.ts: the worker starts with the flag, and `--warm` and `doctor --repair` run themselves again with it), so the flag is never the fix to name. What a user can change is the proxy, or going around it with NODE_USE_ENV_PROXY=0, which nothing else would tell them exists. */
function proxyAdvice(env: NodeJS.ProcessEnv, nodeVersion: string): string {
  const proxied = proxyConfigured(env)
  const honoured = nodeFetchHonoursEnvProxy(nodeVersion)
  if (proxied && !honoured) return `This machine sets a proxy, but Node ${nodeVersion} cannot send fetch through it: upgrade to Node 22.21+ or 24+`
  if (proxied && env['NODE_USE_ENV_PROXY'] === '0') return "NODE_USE_ENV_PROXY=0 sends token-goat's downloads around the proxy in HTTPS_PROXY. If this machine reaches the internet only through that proxy, remove it"
  if (proxied) return `Check that the proxy in HTTPS_PROXY lets ${MODEL_DOWNLOAD_HOST} and ${RUNTIME_DOWNLOAD_HOST} through. If this machine reaches them without it, set NODE_USE_ENV_PROXY=0 and token-goat's downloads go around the proxy`
  if (!honoured) return 'If this machine reaches the internet through a proxy, set HTTPS_PROXY to it and upgrade to Node 22.21+ or 24+, the first versions that can use it'
  return 'If this machine reaches the internet through a proxy, set HTTPS_PROXY to it'
}

/** Rewrite `result` when the only thing between it and semantic search is a download that has not happened yet: the model, or the WebAssembly runtime it runs on. Pure apart from reading the failure record and the files on disk, so a caller can hand it any result. */
export function explainModelDownload(result: EmbeddingPreflightResult, now: number = Date.now()): EmbeddingPreflightResult {
  // The snapshot of modelFilesPresent in the result was taken before any warm, so a warm that just downloaded the files would otherwise still read "missing".
  if (result.modelWarmed) return result.modelFilesPresent ? result : { ...result, modelFilesPresent: true }
  if (result.status !== 'ready' && result.status !== 'no_embeddings' && result.status !== 'load_error') return result
  const pending = pendingDownloadHosts()
  if (pending.length === 0) return result
  const modelMissing = pending.includes(MODEL_DOWNLOAD_HOST)

  const rebuild = (status: EmbeddingPreflightResult['status'], available: boolean, message: string, suggestion: string | undefined, error: string | undefined): EmbeddingPreflightResult => {
    const { suggestion: _s, actionRequired: _a, error: _e, ...rest } = result
    return {
      ...rest,
      status,
      available,
      message,
      summary: message,
      modelFilesPresent: !modelMissing,
      ...(suggestion !== undefined ? { suggestion, actionRequired: suggestion } : {}),
      ...(error !== undefined ? { error } : {}),
    }
  }

  // The most recent failure among the hosts still needed: that is the one the next embed runs into.
  let failure: { host: string; at: number; message: string } | null = null
  for (const host of pending) {
    const record = lastDownloadFailure(host)
    if (record !== null && (failure === null || record.at > failure.at)) failure = { host, at: record.at, message: record.message }
  }
  if (failure !== null) {
    const cooldown = activeDownloadCooldown(failure.host, now)
    const when = cooldown !== null ? `It is tried again automatically after ${new Date(cooldown.retryAt).toISOString()}.` : 'It is tried again automatically the next time a file is embedded.'
    const runtime = failure.host === RUNTIME_DOWNLOAD_HOST
    const what = runtime ? `The WebAssembly runtime the embedding model runs on (onnxruntime-web, from ${RUNTIME_DOWNLOAD_HOST}) is not downloaded yet` : 'The embedding model is not downloaded yet'
    const message = `${what}. The last try, at ${new Date(failure.at).toISOString()}, failed: ${failure.message}. ${when}`
    return rebuild(runtime ? 'missing_runtime' : 'missing_model_files', false, message, runtime ? runtimeDownloadAdvice() : downloadAdvice(), message)
  }
  // No failure recorded: a load_error with no record is some other fault, and saying "downloading" would hide it. A missing runtime binary alone, with the model in place, is fetched on first use and needs no rewording.
  if (result.status === 'load_error' || !modelMissing) return result
  if (result.status === 'no_embeddings') {
    const message = `The embedding model (about ${MODEL_MB} MB, once) is not downloaded yet. It downloads by itself in the background, and this project's ${countNoun(result.indexedFiles, 'indexed file')} are embedded after it.`
    return rebuild('missing_model_files', false, message, `Nothing to do. To download it now instead, run \`${WARM_COMMAND}\`.`, undefined)
  }
  return rebuild('ready', true, `Semantic search is ready. The embedding model (about ${MODEL_MB} MB) is not downloaded yet; it is fetched on first use.`, undefined, undefined)
}

/** checkEmbeddingPreflight, with a model that is not downloaded yet explained rather than misreported. Every command and tool that reports semantic readiness goes through this. */
export async function checkSemanticReadiness(options?: Parameters<typeof checkEmbeddingPreflight>[0]): Promise<EmbeddingPreflightResult> {
  return explainModelDownload(await checkEmbeddingPreflight(options))
}

/** The stderr notice for files `index` left unembedded because offline mode holds the model download, or null when offline mode is off and the usual "the worker downloads it" wording applies. Names the setting that holds it (the environment variable, config.toml, or the project's own file), says which commands need no model, and points at the directory the pinned files can be copied into, since neither the worker nor --warm can fetch them while offline. */
export function offlineEmbedNotice(fileCount: string, rootDir?: string): string | null {
  const cfg = loadConfig(rootDir)
  if (!cfg.network.offline) return null
  const state = resolveConfigKeyLayer('network.offline', cfg.network.offline, cfg as unknown as Record<string, unknown>, getProjectConfigInfo(rootDir))
  const holder =
    state.layer === 'env' || state.layer === 'env-invalid'
      ? `${state.envVar} is set in your environment`
      : state.layer === 'project'
        ? `${displaySafeText(state.path)} sets network.offline`
        : 'network.offline is on in config.toml'
  return `token-goat: index: ${fileCount} not embedded: the embedding model is not downloaded and ${holder}, so nothing will download it. symbol, read, outline and section work now; semantic falls back to keyword search. To embed them, unset it so the model can be downloaded, or copy the pinned model files into ${modelDir()}; then run \`token-goat index\` again.`
}
