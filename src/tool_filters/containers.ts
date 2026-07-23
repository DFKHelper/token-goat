// Batch F — container / kubernetes filter family.
//
// Faithfully ported from the Python bash_compress.py container family: DockerFilter, DockerComposeFilter, KubectlFilter, KubectlLogsFilter, HelmFilter.
//
// Dispatch ordering in CONTAINER_FILTERS: 1. KubectlLogsFilter before KubectlFilter — both match `kubectl`/`k`; KubectlLogsFilter's custom matches() gate (requires the `logs` positional arg) is the more specific guard and must win first. 2. DockerComposeFilter before DockerFilter — both match `docker`; the compose-subcommand check in DockerComposeFilter.matches() would lose to DockerFilter's generic binary match if DockerFilter came first.

import { ToolFilter } from './base.js'
import {
  ERROR_SIGNAL_RE,
  TIMESTAMP_PREFIX_RE,
  headTailCompress,
  pathName,
  pathStem,
  positionalArgs,
  truncateTableRows,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Docker regexes (BuildKit and legacy format)
// ---------------------------------------------------------------------------

// #N sha256:… digest lines or #N resolve … lines — noise
const _DOCKER_DIGEST_RE = /^\s*#\d+\s+(sha256:[a-f0-9]{8,}|resolve\s)/
// #N 12.3MB / 50.0MB … — layer-transfer progress
const _DOCKER_PROGRESS_RE = /^\s*#\d+\s+\d+(?:\.\d+)?(?:MB|kB|GB)\s+\//
// #N [internal/build/stage …] or => … — step header (keep)
const _DOCKER_STEP_RE = /^\s*=>\s|^\s*#\d+\s+\[(internal|build|stage)/
// #N 0.123s some body line — step body (drop unless step header or error)
const _DOCKER_STEP_BODY_RE = /^\s*#\d+\s+\d+(?:\.\d+)?\s+/
// #N CACHED — layer reused from cache; dozens appear on warm builds
const _DOCKER_CACHED_RE = /^\s*#\d+\s+CACHED\s*$/
// push noise: "Layer already exists" / "Mounted from …" / "Pushing N:"
const _DOCKER_PUSH_NOISE_RE = /^\s*(?:\S+:\s+)?(?:Layer already exists|Mounted from \S+|Pushing\s+\S+:\s+\d)/i
// pull per-layer status lines
const _DOCKER_PULL_LAYER_RE =
  /^\s*[a-f0-9]{12}:\s+(?:Pull complete|Verifying Checksum|Download complete|Already exists|Waiting|Pulling fs layer)/i
// old-format (non-BuildKit) patterns
const _DOCKER_OLD_CACHE_RE = /^ *---> Using cache\s*$/
const _DOCKER_OLD_SHA_RE = /^ *---> (?:sha256:)?[0-9a-f]{12,}\s*$/
const _DOCKER_OLD_STEP_RE = /^Step \d+\/\d+ : /
const _DOCKER_OLD_SUCCESS_RE = /^Successfully built [0-9a-f]+/
const _DOCKER_OLD_INTERMEDIATE_RE = /^Removing intermediate container [0-9a-f]+/

// ---------------------------------------------------------------------------
// DockerFilter
// ---------------------------------------------------------------------------

export class DockerFilter extends ToolFilter {
  readonly name = 'docker'
  override readonly binaries = new Set(['docker', 'buildah', 'podman', 'nerdctl'])

  // Docker writes progress/errors to stderr; only stdout carries build bodies. Merge with stderr first so errors appear before raw build output.
  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    // Note: reversed arg order (stderr, stdout) — docker progress goes to stderr
    const merged = this.combineOutput(stderr, stdout)
    const lines = merged.split('\n')
    let kept: string[] = []
    let droppedDigest = 0
    let droppedProgress = 0
    let droppedBody = 0
    let droppedCached = 0
    let droppedPushNoise = 0
    let droppedPullLayers = 0

    for (const line of lines) {
      if (_DOCKER_DIGEST_RE.test(line)) { droppedDigest++; continue }
      if (_DOCKER_PROGRESS_RE.test(line)) { droppedProgress++; continue }
      if (_DOCKER_CACHED_RE.test(line)) { droppedCached++; continue }
      if (_DOCKER_PUSH_NOISE_RE.test(line)) { droppedPushNoise++; continue }
      if (_DOCKER_PULL_LAYER_RE.test(line)) { droppedPullLayers++; continue }
      // Drop step body lines (prefixed timestamp/counter) unless they are step headers or carry an error/warning signal.
      if (
        _DOCKER_STEP_BODY_RE.test(line) &&
        !_DOCKER_STEP_RE.test(line) &&
        !line.includes('ERROR') &&
        !line.toUpperCase().includes('WARN')
      ) {
        droppedBody++
        continue
      }
      kept.push(line)
    }

    // Old-format (non-BuildKit) docker build enhancement pass
    if (lines.some((l) => _DOCKER_OLD_STEP_RE.test(l))) {
      const oldStepCount = lines.filter((l) => _DOCKER_OLD_STEP_RE.test(l)).length
      const oldCacheCount = lines.filter((l) => _DOCKER_OLD_CACHE_RE.test(l)).length
      const oldNew: string[] = []
      let oldStepHdr: string | null = null
      let oldStepErr = false
      let oldDroppedCache = 0
      let oldDroppedSha = 0
      let oldDroppedImd = 0
      let oldDroppedStep = 0

      for (const ol of kept) {
        if (_DOCKER_OLD_SUCCESS_RE.test(ol)) {
          if (oldStepHdr !== null && !oldStepErr) oldDroppedStep++
          else if (oldStepHdr !== null) oldNew.push(oldStepHdr)
          oldStepHdr = null
          oldNew.push(ol)
          continue
        }
        if (_DOCKER_OLD_CACHE_RE.test(ol)) { oldDroppedCache++; continue }
        if (_DOCKER_OLD_SHA_RE.test(ol)) { oldDroppedSha++; continue }
        if (_DOCKER_OLD_INTERMEDIATE_RE.test(ol)) { oldDroppedImd++; continue }
        if (_DOCKER_OLD_STEP_RE.test(ol)) {
          if (oldStepHdr !== null) {
            if (oldStepErr) oldNew.push(oldStepHdr)
            else oldDroppedStep++
          }
          oldStepHdr = ol
          oldStepErr = false
          continue
        }
        if (ol.toLowerCase().includes('error')) oldStepErr = true
        oldNew.push(ol)
      }
      if (oldStepHdr !== null) {
        if (oldStepErr) oldNew.push(oldStepHdr)
        else oldDroppedStep++
      }
      if (oldCacheCount > 0) {
        oldNew.unshift(`[building ${oldStepCount} layers, ${oldCacheCount} cached]`)
      }
      kept = oldNew
      // Suppress the old-format individual drop counters that were already folded in
      void oldDroppedCache; void oldDroppedSha; void oldDroppedImd; void oldDroppedStep
    }

    const parts: string[] = []
    if (droppedDigest) parts.push(`${droppedDigest} digest`)
    if (droppedProgress) parts.push(`${droppedProgress} transfer`)
    if (droppedBody) parts.push(`${droppedBody} body`)
    if (droppedCached) parts.push(`${droppedCached} CACHED`)
    if (droppedPushNoise) parts.push(`${droppedPushNoise} push-layer`)
    if (droppedPullLayers) parts.push(`${droppedPullLayers} pull-layer`)
    if (parts.length) kept.push(`[token-goat: dropped ${parts.join(', ')} lines]`)

    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// DockerCompose helpers + filter
// ---------------------------------------------------------------------------

// Streaming service logs: "service_name | message"
const _DC_SERVICE_LOG_RE = /^(?<svc>[a-zA-Z0-9_\-.]+(?:-\d+)?)\s*\|\s*(?<msg>.*)$/
// Pulling service lines: "Pulling service_name (image:tag)..."
const _DC_PULLING_RE = /^Pulling\s+\S+\s+\(.*\)\s*\.\.\.\s*$/
// Health-check retry lines
const _DC_HEALTH_RE = /Container\s+\S+\s+(Waiting|health:\s+\w+|starting|unhealthy)/i

export class DockerComposeFilter extends ToolFilter {
  readonly name = 'docker-compose'
  // binaries declared for documentation; matches() below is the real gate
  override readonly binaries = new Set(['docker-compose', 'docker'])
  override readonly errorPassthrough = true

  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    const name = pathName(argv[0]!).toLowerCase()
    if (stem === 'docker-compose' || name === 'docker-compose') return true
    if (stem === 'docker' || name === 'docker') {
      const pos = positionalArgs(argv.slice(1))
      return pos.length > 0 && pos[0] === 'compose'
    }
    return false
  }

  protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')

    const serviceLines = new Map<string, string[]>()
    const kept: string[] = []
    let pullingCount = 0
    let pullingKept = 0
    const healthCounts = new Map<string, number>()

    for (const line of lines) {
      // Health-check retry collapsing
      if (_DC_HEALTH_RE.test(line)) {
        const words = line.split(/\s+/)
        const containerKey = words[1] ?? 'container'
        const prev = healthCounts.get(containerKey) ?? 0
        healthCounts.set(containerKey, prev + 1)
        if (prev === 0) kept.push(line)
        continue
      }

      // Pulling lines: keep the first, collapse the rest
      if (_DC_PULLING_RE.test(line)) {
        pullingCount++
        if (pullingKept === 0) { kept.push(line); pullingKept = 1 }
        continue
      }

      // Streaming service log lines: buffer per service
      const sm = _DC_SERVICE_LOG_RE.exec(line)
      if (sm) {
        const svc = sm.groups?.['svc'] ?? sm[1]!
        if (!serviceLines.has(svc)) serviceLines.set(svc, [])
        serviceLines.get(svc)!.push(line)
        continue
      }

      kept.push(line)
    }

    // Flush pulled-count summary
    if (pullingCount > pullingKept) {
      kept.push(`[token-goat: ${pullingCount - pullingKept} more Pulling lines elided]`)
    }

    // Flush health-check summaries
    for (const [containerKey, count] of [...healthCounts.entries()].sort()) {
      if (count > 1) {
        kept.push(`[token-goat: ${count - 1} more health-check wait lines for ${containerKey}]`)
      }
    }

    // Flush service log buffers — collapse services with >50 lines
    const STREAM_THRESHOLD = 50
    const STREAM_TAIL = 10
    for (const svc of [...serviceLines.keys()].sort()) {
      const svcLines = serviceLines.get(svc)!
      if (svcLines.length <= STREAM_THRESHOLD) {
        kept.push(...svcLines)
      } else {
        const extra = svcLines.length - STREAM_TAIL
        kept.push(`[token-goat: ${extra} lines from ${svc} elided (showing last ${STREAM_TAIL})]`)
        kept.push(...svcLines.slice(-STREAM_TAIL))
      }
    }

    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// Kubectl table / describe / events helpers
// ---------------------------------------------------------------------------

function _compressKubectlTable(text: string, maxRows = 10): string {
  return truncateTableRows(text, maxRows, 'use --selector or -l to narrow')
}

const _MAX_PER_REASON = 3

function _compressKubectlEvents(text: string): string {
  const lines = text.split('\n')
  const nonEmpty = lines.filter((l) => l.trim())
  if (nonEmpty.length <= 5) return text
  const header = nonEmpty[0]!
  if (!header.toUpperCase().includes('REASON')) {
    return _compressKubectlTable(text, 10)
  }
  const reasonIdx = header.toUpperCase().indexOf('REASON')
  const groups = new Map<string, string[]>()
  for (const row of nonEmpty.slice(1)) {
    let reason = 'Unknown'
    if (row.length > reasonIdx) {
      const tail = row.slice(reasonIdx)
      const words = tail.split(/\s+/).filter(Boolean)
      if (words.length > 0) reason = words[0]!
    }
    if (!groups.has(reason)) groups.set(reason, [])
    groups.get(reason)!.push(row)
  }
  const kept: string[] = [header]
  let totalElided = 0
  for (const [reason, rows] of groups.entries()) {
    if (rows.length <= _MAX_PER_REASON) {
      kept.push(...rows)
    } else {
      const elided = rows.length - _MAX_PER_REASON
      totalElided += elided
      kept.push(...rows.slice(-_MAX_PER_REASON))
      kept.push(`  [token-goat: ${elided} earlier '${reason}' events elided]`)
    }
  }
  if (totalElided) {
    kept.push(`[token-goat: ${totalElided} events collapsed; use --field-selector to filter]`)
  }
  return kept.join('\n')
}

const _KEY_PREFIXES = [
  'Name:', 'Namespace:', 'Status:', 'State:', 'Node:', 'IP:', 'PodIP:',
  'NodeIP:', 'QoS Class:', 'Priority:', 'Image:', 'Ready:', 'Restart Count:',
  'Started:', 'Finished:', 'Exit Code:', 'Reason:', 'Message:',
  'Replicas:', 'StrategyType:', 'Selector:', 'Type:', 'ClusterIP:',
  'Limits:', 'Requests:', 'cpu:', 'memory:',
]

function _compressKubectlDescribe(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const stripped = line.trim()
    if (!stripped) { i++; continue }

    const labelKey = stripped.includes(':') ? stripped.split(':')[0]! : ''

    // Collapse Labels / Annotations: keep header + first 3 indented entries
    if (labelKey === 'Labels' || labelKey === 'Annotations') {
      kept.push(line)
      const headerIndent = line.length - line.trimStart().length
      const entries: string[] = []
      i++
      while (i < lines.length) {
        const nxt = lines[i]!
        const nxtIndent = nxt.trim() ? nxt.length - nxt.trimStart().length : 0
        if (nxt.trim() && nxtIndent > headerIndent) {
          entries.push(nxt)
          i++
        } else {
          break
        }
      }
      kept.push(...entries.slice(0, 3))
      if (entries.length > 3) {
        kept.push(' '.repeat(headerIndent + 2) + `[token-goat: ${entries.length - 3} more entries elided]`)
      }
      continue
    }

    // Conditions: keep the whole section
    if (stripped.startsWith('Conditions:')) {
      kept.push(line)
      i++
      while (i < lines.length) {
        const nxt = lines[i]!
        if (!nxt.trim()) break
        kept.push(nxt)
        i++
      }
      continue
    }

    // Events: keep last 10 lines, elide older with a count
    if (stripped.startsWith('Events:')) {
      kept.push('')
      kept.push('Events:')
      const eventLines = lines.slice(i + 1).filter((l) => l.trim())
      if (eventLines.length > 0) {
        if (eventLines.length > 10) {
          kept.push(`  [token-goat: ${eventLines.length - 10} earlier events elided]`)
          kept.push(...eventLines.slice(-10))
        } else {
          kept.push(...eventLines)
        }
      }
      break
    }

    // Key single-line fields always kept
    if (_KEY_PREFIXES.some((pfx) => stripped.startsWith(pfx))) {
      kept.push(line)
    }
    i++
  }

  if (kept.length === 0) {
    return lines.slice(0, 20).join('\n') + '\n[token-goat: describe output truncated]'
  }
  return kept.join('\n')
}

// ---------------------------------------------------------------------------
// KubectlFilter
// ---------------------------------------------------------------------------

export class KubectlFilter extends ToolFilter {
  readonly name = 'kubectl'
  override readonly binaries = new Set(['kubectl', 'k', 'k9s', 'oc'])
  override readonly errorPassthrough = true

  protected override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const pos = positionalArgs(argv.slice(1))
    const subcommand = pos[0] ?? ''
    let text = stdout

    if (subcommand === 'get' || subcommand === 'top') {
      if (text.includes('\n')) {
        const resource = pos[1] ?? ''
        if (resource === 'events' || resource === 'ev' || resource === 'event') {
          text = _compressKubectlEvents(text)
        } else {
          text = _compressKubectlTable(text, 10)
        }
      }
    } else if (subcommand === 'describe') {
      if (text.includes('\n')) text = _compressKubectlDescribe(text)
    } else if (subcommand === 'apply' || subcommand === 'create' || subcommand === 'delete') {
      // Typically short — pass through
    } else if (subcommand === 'logs') {
      if (text.includes('\n')) {
        const nonEmpty = text.split('\n').filter((l) => l.trim())
        if (nonEmpty.length > 50) {
          text = headTailCompress(nonEmpty, 30, 20, 'log lines')
        } else {
          text = nonEmpty.join('\n')
        }
      }
    } else if (subcommand === 'exec') {
      // Interactive — pass through
    } else if (subcommand === 'diff') {
      const diffLines = text.split('\n')
      if (diffLines.length > 50) {
        text = headTailCompress(diffLines, 50, 0, 'diff lines')
      }
    }

    if (stderr.trim()) {
      return text.trim() ? `${text.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}` : stderr
    }
    return text
  }
}

// ---------------------------------------------------------------------------
// KubectlLogsFilter helpers
// ---------------------------------------------------------------------------

// HTTP access-log pattern: IP + HTTP method/path/status
const _KUBE_ACCESS_LOG_RE =
  /(?:\d{1,3}\.){3}\d{1,3}.*?"(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s[^"]*"\s+(\d{3})\b/

// Stack-trace frame patterns (Java, Python, Go, Node)
const _KUBE_STACKFRAME_RE = /^\s+(?:at\s+[\w.$<>]+\(|File "[^"]+", line \d+|goroutine \d+ \[|\s+\.\.\.)/

// Pod/container prefix for --prefix and sidecar-style output
const _KUBECTL_POD_PREFIX_RE =
  /^\[[^\]]+\]\s+|^[a-z0-9][a-z0-9\-.]*\s+\|\s+/

function _collapseAccessLogs(lines: string[]): string[] {
  const ACCESS_THRESHOLD = 20
  const accessLines: string[] = []
  const otherLines: string[] = []
  for (const line of lines) {
    if (_KUBE_ACCESS_LOG_RE.test(line)) accessLines.push(line)
    else otherLines.push(line)
  }
  if (accessLines.length <= ACCESS_THRESHOLD) return lines
  const counts: Record<string, number> = {}
  for (const line of accessLines) {
    const m = _KUBE_ACCESS_LOG_RE.exec(line)
    if (m) {
      const status = m[1]!
      const bucket = `${status[0]}xx`
      counts[bucket] = (counts[bucket] ?? 0) + 1
    }
  }
  const detail = Object.entries(counts).sort().map(([k, v]) => `${k}: ${v}`).join(', ')
  const summary = `[token-goat: ${accessLines.length} HTTP access log lines collapsed (${detail})]`
  return [...otherLines, summary]
}

function _collapseStackTraces(lines: string[]): string[] {
  const MAX_FRAMES = 5
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (_KUBE_STACKFRAME_RE.test(lines[i]!)) {
      let j = i
      while (j < lines.length && _KUBE_STACKFRAME_RE.test(lines[j]!)) j++
      const frames = lines.slice(i, j)
      out.push(...frames.slice(0, MAX_FRAMES))
      if (frames.length > MAX_FRAMES) {
        out.push(`    ... ${frames.length - MAX_FRAMES} more frames`)
      }
      i = j
    } else {
      out.push(lines[i]!)
      i++
    }
  }
  return out
}

function _normaliseLogLine(line: string): string {
  const noPod = line.replace(_KUBECTL_POD_PREFIX_RE, '')
  return noPod.replace(TIMESTAMP_PREFIX_RE, '').trim()
}

function _dedupLogLinesWithPodPrefix(lines: string[], keepFirstN = 3): string[] {
  const out: string[] = []
  const seen = new Map<string, number>()
  const omit = new Map<string, number>()
  let prevKey: string | null = null

  for (const line of lines) {
    const key = _normaliseLogLine(line)
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)

    if (count < keepFirstN) {
      // Flush any pending omit marker when moving to a different message
      if (prevKey !== null && prevKey !== key) {
        const pendingOmit = omit.get(prevKey) ?? 0
        if (pendingOmit > 0) {
          out.push(`[token-goat: ${pendingOmit} more similar lines omitted]`)
          omit.set(prevKey, 0)
        }
      }
      out.push(line)
    } else {
      omit.set(key, (omit.get(key) ?? 0) + 1)
    }
    prevKey = key
  }

  // Flush final omit counters in insertion order
  const flushed = new Set<string>()
  for (const [key, count] of omit.entries()) {
    if (count > 0 && !flushed.has(key)) {
      out.push(`[token-goat: ${count} more similar lines omitted]`)
      flushed.add(key)
    }
  }
  return out
}

function _jsonBlobSummary(blobLines: string[]): string {
  try {
    const obj: unknown = JSON.parse(blobLines.join('\n'))
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>
      for (const key of ['message', 'msg', 'level', 'severity', 'event', 'type']) {
        if (key in rec) return `: ${key}=${JSON.stringify(rec[key])}`
      }
    }
  } catch {
    // ignore
  }
  return ''
}

function _collapseJsonBlobs(lines: string[], maxJsonLines = 5): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const stripped = line.trim()
    if (stripped.startsWith('{') && !stripped.endsWith('}')) {
      let depth = (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length
      let j = i + 1
      while (j < lines.length && depth > 0) {
        const chunk = lines[j]!.trim()
        depth += (chunk.match(/\{/g) ?? []).length - (chunk.match(/\}/g) ?? []).length
        j++
      }
      const blobLines = lines.slice(i, j)
      if (blobLines.length > maxJsonLines) {
        const summary = _jsonBlobSummary(blobLines)
        out.push(`[token-goat: JSON blob ${blobLines.length} lines collapsed${summary}]`)
        i = j
        continue
      }
    }
    out.push(line)
    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// KubectlLogsFilter
// ---------------------------------------------------------------------------

export class KubectlLogsFilter extends ToolFilter {
  readonly name = 'kubectl-logs'
  override readonly binaries = new Set(['kubectl', 'k'])
  override readonly errorPassthrough = true

  override matches(argv: string[]): boolean {
    if (argv.length === 0) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    const name = pathName(argv[0]!).toLowerCase()
    if (!['kubectl', 'k'].includes(stem) && !['kubectl', 'k'].includes(name)) return false
    const pos = positionalArgs(argv.slice(1))
    return pos.length > 0 && pos[0] === 'logs'
  }

  protected override compressBody(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const lines = stdout.split('\n')
    let nonEmpty = lines.filter((l) => l.trim())

    if (nonEmpty.length <= 50) return stdout

    // Step 1: access-log collapsing
    nonEmpty = _collapseAccessLogs(nonEmpty)
    // Step 2: stack-trace collapsing
    nonEmpty = _collapseStackTraces(nonEmpty)
    // Step 3: repetitive-line dedup (timestamp + pod-prefix normalised)
    nonEmpty = _dedupLogLinesWithPodPrefix(nonEmpty, 3)
    // Step 4: JSON blob collapsing
    nonEmpty = _collapseJsonBlobs(nonEmpty, 5)
    // Step 5: hard head+tail cap
    let result: string
    if (nonEmpty.length > 200) {
      result = headTailCompress(nonEmpty, 40, 40, 'log lines')
    } else {
      result = nonEmpty.join('\n')
    }

    if (stderr.trim()) {
      return result.trim() ? `${result.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}` : stderr
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Helm helpers
// ---------------------------------------------------------------------------

// Release description boilerplate (first-word match)
const _HELM_RELEASE_DESC_RE =
  /^(NAME|LAST DEPLOYED|NAMESPACE|CHART|APP VERSION|REVISION|TEST SUITE|NOTES\.|RESOURCES:|==>|USER-SUPPLIED VALUES:|COMPUTED VALUES:|HOOKS:|MANIFEST:)\b/

const _HELM_STATUS_RE = /^STATUS:\s*\S+/

function _compressHelmInstall(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let dropped = 0
  let inNotes = false

  for (const line of lines) {
    if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
    if (_HELM_STATUS_RE.test(line)) { kept.push(line); continue }
    if (line.trim() === 'NOTES:') {
      inNotes = true
      dropped++
      continue
    }
    if (inNotes) {
      if (!line.trim()) inNotes = false
      dropped++
      continue
    }
    if (_HELM_RELEASE_DESC_RE.test(line)) { dropped++; continue }
    kept.push(line)
  }

  if (dropped) kept.push(`[token-goat: ${dropped} helm release description lines elided]`)
  return kept.join('\n')
}

function _compressHelmList(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim())
  const MAX_ROWS = 10
  if (lines.length <= MAX_ROWS + 1) return text
  const header = lines[0]!
  const data = lines.slice(1)
  const kept = [header, ...data.slice(0, MAX_ROWS)]
  kept.push(
    `[token-goat: ${data.length - MAX_ROWS} more helm releases elided; use --filter or --namespace to narrow]`,
  )
  return kept.join('\n')
}

function _compressHelmTemplate(lines: string[]): string {
  const total = lines.length
  const sections: string[] = []
  for (const line of lines) {
    if (line.trim().startsWith('---')) sections.push(line)
  }
  if (sections.length === 0) {
    return headTailCompress(lines, 10, 10, 'template lines')
  }
  sections.push(
    `[token-goat: helm template ${total} total lines; showing ${sections.length} document headers only]`,
  )
  return sections.join('\n')
}

// ---------------------------------------------------------------------------
// HelmFilter
// ---------------------------------------------------------------------------

export class HelmFilter extends ToolFilter {
  readonly name = 'helm'
  override readonly binaries = new Set(['helm'])
  override readonly errorPassthrough = true

  protected override compressBody(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const pos = positionalArgs(argv.slice(1))
    const subcommand = pos[0] ?? ''
    let text = stdout

    if (subcommand === 'install' || subcommand === 'upgrade') {
      text = _compressHelmInstall(text)
    } else if (subcommand === 'list') {
      text = _compressHelmList(text)
    } else if (subcommand === 'template') {
      const lines = text.split('\n')
      if (lines.length > 200) text = _compressHelmTemplate(lines)
    }
    // rollback, status, history, etc. — pass through

    if (stderr.trim()) {
      return text.trim() ? `${text.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}` : stderr
    }
    return text
  }
}

// ---------------------------------------------------------------------------
// Exported registry Ordering is load-bearing: KubectlLogsFilter BEFORE KubectlFilter; DockerComposeFilter BEFORE DockerFilter.
// ---------------------------------------------------------------------------

export const kubectlLogsFilter = new KubectlLogsFilter()
export const dockerComposeFilter = new DockerComposeFilter()
export const kubectlFilter = new KubectlFilter()
export const dockerFilter = new DockerFilter()
export const helmFilter = new HelmFilter()

export const CONTAINER_FILTERS: ToolFilter[] = [
  kubectlLogsFilter,  // must precede kubectlFilter
  dockerComposeFilter, // must precede dockerFilter
  kubectlFilter,
  dockerFilter,
  helmFilter,
]
