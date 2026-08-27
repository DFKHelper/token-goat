// CI / security-scanner filter family (Batch H): GhRunLogFilter, GhFilter, ActFilter, GenericCIFilter, PreCommitFilter, BanditFilter, TrivyFilter, SnykFilter, SemgrepFilter.
//
// Ported faithfully from the Python bash_compress.py CI + security families. GhFilter includes the *_url-stripping enhancement from the python-gh-filter-ref tag (strips boilerplate *_url fields from `gh api` JSON responses while preserving html_url, avatar_url, clone_url, ssh_url).
//
// Dispatch ordering note: GhRunLogFilter (`gh run view --log`) must precede GhFilter in CI_FILTERS — both match `gh`, but GhRunLogFilter is the more specific handler that requires the `--log` flag.

import { ToolFilter } from './base.js'
import {
  ERROR_SIGNAL_RE,
  maybeNote,
  pathName,
  pathStem,
  positionalArgs,
  squeezeBlankLines,
  stripTimestamps,
} from './helpers.js'

// ---------------------------------------------------------------------------
// GhFilter regexes
// ---------------------------------------------------------------------------

// Pass step (✓ or √ at start of line)
const _GH_RUN_PASS_STEP_RE = /^\s*[✓√]\s/

// Fail step (✗ ❌ FAILED: Error:)
const _GH_RUN_FAIL_STEP_RE = /^\s*[X✗❌]\s|^\s*FAIL(:|ED|URE)\b|^\s*Error:\s/

// GitHub API URL-field stripping
const _GH_API_URL_SUFFIX = '_url'
const _GH_API_URL_KEEP = new Set(['html_url', 'avatar_url', 'clone_url', 'ssh_url'])

// gh global flags that consume a separate next-token value (e.g. `gh -R owner/repo pr list`) --
// without this, positionalArgs() lets the value token survive and shifts subcommand routing.
const GH_GLOBAL_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname'])
const _GH_API_NOISE_KEYS = new Set(['gravatar_id', 'site_admin'])

// Base64 content redaction
const _GH_CONTENT_B64_RE = /^[A-Za-z0-9+/=\n]+$/
const _GH_BASE64_MIN_LEN = 200

// ---------------------------------------------------------------------------
// GhRunLogFilter regexes
// ---------------------------------------------------------------------------

// ##[group]Step name
const _GH_LOG_GROUP_RE = /^##\[group\](.*)/
// ##[endgroup]
const _GH_LOG_ENDGROUP_RE = /^##\[endgroup\]/
// ##[command]… — command-echo noise
const _GH_LOG_COMMAND_RE = /^##\[command\]/

// gh run view --log format: job-name TAB step-name TAB timestamp. Both
// tab-delimited fields must be stripped — leaving just the step-name field
// behind lets it collide with downstream ^-anchored regexes (e.g. a step
// literally named "Run actions/checkout@v3" would falsely match
// _GH_LOG_SETUP_ACTION_RE and sweep genuine content into that bucket).
const _GH_LOG_STEP_PREFIX_RE = /^[^\t]+\t[^\t]+\t/

// Run actions/checkout@v3 setup lines
const _GH_LOG_SETUP_ACTION_RE = /^Run [a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@/

// Post-run cleanup steps
const _GH_LOG_POST_STEP_RE = /^Post job cleanup\.|^Cleaning up orphan processes|^Post Run /

// Runner boilerplate
const _GH_LOG_BOILERPLATE_RE =
  /^Setting up runner|^Runner version |^Operating System\s+:\s|^Virtual Environment|^Prepare all required actions|^Getting action download info|^Download action repository|^Complete job name:/

// Failure indicator — always keep
const _GH_LOG_FAILURE_RE =
  /error:|Error:|ERROR|FAILED|failed|##\[error\]|##\[warning\]|Process completed with exit code [^0]/i

// ---------------------------------------------------------------------------
// ActFilter regexes
// ---------------------------------------------------------------------------

// [job-name/step-name]   | output here
const _ACT_JOB_PREFIX_RE = /^\[(?<job>[^\]]+)\]\s+\|\s*(?<body>.*)/
// [job-name/step-name] ✅ ❌
const _ACT_STATUS_RE = /^\[(?<job>[^\]]+)\]\s+(?<status>[✅❌✓✗])/
// Docker pull progress inside act
const _ACT_DOCKER_PULL_RE = /^\[(?:[^\]]+)\]\s+\|\s*(?:Pulling |Waiting\s*$|Verifying |Extracting |Pull complete|Digest:|Status:|Unable to find image)/i
// [...]  Matrix: {"os": ...}
const _ACT_MATRIX_EXPAND_RE = /^\[.*\]\s+Matrix:/

// ---------------------------------------------------------------------------
// GenericCIFilter regexes
// ---------------------------------------------------------------------------

// ANSI escape sequences
// eslint-disable-next-line no-control-regex
const _CI_ANSI_RE = /\x1b(?:\[[0-9;]*[mABCDEFGHJKSTf]|\](?:[^\x07\x1b]|\x1b[^\\])*(?:\x07|\x1b\\))/g
// Heartbeat / ping / health-check
const _CI_HEARTBEAT_RE = /\b(?:heartbeat|ping|health.?check|keepalive|keep.alive)\b/i
// Log level prefixes
const _CI_DEBUG_RE = /^\s*(?:DEBUG|TRACE|VERBOSE)\b[\s:]/i
// Keywords triggering GenericCIFilter
const _CI_COMMAND_KEYWORDS = new Set(['--log', 'logs', 'pipeline', 'workflow'])

// ---------------------------------------------------------------------------
// PreCommitFilter regexes
// ---------------------------------------------------------------------------

// hook_name...(no files to check)Passed   or just hook_name...Passed
const _PRECOMMIT_RESULT_RE =
  /^(?<hook>\S.*?)\.{3,}(?:\([^)]*\))?\s*(?<status>Passed|Failed|Skipped|Pre-commit hook failed)\s*$/
// [INFO] Initializing environment...
const _PRECOMMIT_INFO_RE = /^\[INFO\]\s+(Initializing|Installing|Restored|Cloning)/

// ---------------------------------------------------------------------------
// BanditFilter regexes
// ---------------------------------------------------------------------------

const _BANDIT_RUN_STARTED_RE = /^Run started:/
const _BANDIT_TEST_RESULTS_RE = /^Test results:/
const _BANDIT_ISSUE_SEVERITY_RE = /^>>\s+Issue:\s+\[/i
const _BANDIT_CODE_SCANNED_RE = /^Code scanned:/
const _BANDIT_TOTAL_ISSUES_RE = /^Total issues \(by/
const _BANDIT_STAT_LINE_RE = /^\s+\|?\s*\d/
const _BANDIT_TESTING_RE = /^testing\s/
// The dashed rule bandit prints between findings. It belongs to the block it closes, so when a LOW block is collapsed the rule that follows it is left orphaned next to the previous block's own rule, and the report shows two dashed rules in a row with nothing between them.
const _BANDIT_SEPARATOR_RE = /^-{10,}\s*$/

// ---------------------------------------------------------------------------
// TrivyFilter regexes
// ---------------------------------------------------------------------------

// Timestamped INFO/WARN/DEBUG log lines
const _TRIVY_LOG_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*\s+(?:INFO|WARN|DEBUG|ERROR)\s/
// Table separator: all dashes/plus
const _TRIVY_TABLE_SEP_RE = /^[+|-]+$/
// Table data row starts with |
const _TRIVY_TABLE_ROW_RE = /^\|/
// "Total: N (CRITICAL: X, ...)" summary
const _TRIVY_TOTAL_RE = /^Total:\s*\d+/i
// "No vulnerabilities found"
const _TRIVY_NO_VULN_RE = /no\s+vulnerabilit/i
// Target / library header
const _TRIVY_TARGET_RE =
  /^(?:[-=]+\s+)?(?:Python|Ruby|Node\.js|Go|Java|PHP|Rust|OS Packages|Alpine|Debian|Ubuntu|RHEL|CentOS|npm|pip|gem|cargo|pom\.xml|Gemfile\.lock|requirements|package-lock|yarn\.lock|composer\.lock|go\.sum|Cargo\.lock|\S+\s+\()/i

// ---------------------------------------------------------------------------
// SnykFilter regexes
// ---------------------------------------------------------------------------

const _SNYK_TESTING_RE = /^Testing\s/i
// Dependency tree box-drawing characters. A bare indent is deliberately NOT a tree line: snyk indents vulnerability details ("Description:", "Fixed in:") and the "Issues to fix by upgrading:" remediation lines by two spaces, and counting those against the tree budget silently discarded the actionable half of the report.
const _SNYK_TREE_LINE_RE = /^\s*(?:[├└│]|[|\\`][-\s])/
// Vuln block opener: "✗ High severity vulnerability found in foo"
const _SNYK_VULN_HEADER_RE = /(?:✗|x|X)?\s*(?:Critical|High|Medium|Low|Info)\s+severity/i
// "More about this vulnerability:" URL-only lines
const _SNYK_MORE_ABOUT_RE = /^\s*(?:More about this vulnerability|https?:\/\/\S+)/i
// Summary line
const _SNYK_SUMMARY_RE = /(?:✔|✗|Tested\s+\d+|unique vulnerabilities|no vulnerable paths|issues found)/i
// License issue lines
const _SNYK_LICENSE_RE = /license/i

// ---------------------------------------------------------------------------
// SemgrepFilter regexes
// ---------------------------------------------------------------------------

const _SEMGREP_SCANNING_RE = /^(?:Scanning\s+\d+|Running\s+\d+)/i
const _SEMGREP_RULE_HEADER_RE = /^\s*(ERROR|WARNING|INFO|HIGH|MEDIUM|LOW|CRITICAL)\s+\S|^[^\s/][^/\s]*\.[a-zA-Z0-9_-]+\s*$/i
const _SEMGREP_DETAILS_RE = /^\s*Details:\s*https?:\/\//i
const _SEMGREP_SUMMARY_RE = /^(?:Ran\s+\d+|Findings?:|✔|✘|\d+\s+finding)/i
const _SEMGREP_ANNOTATION_RE = /^\s*(?:run|fix|autofix|rule):\s*https?:\/\//i

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Recursively strip boilerplate *_url and noise fields from a GitHub API JSON object.
 * Returns [cleaned, removedCount]. Preserves html_url, avatar_url, clone_url, ssh_url. */
function stripGhApiUrlFields(obj: unknown): [unknown, number] {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>
    const cleaned: Record<string, unknown> = {}
    let removed = 0
    for (const [key, value] of Object.entries(record)) {
      if ((key.endsWith(_GH_API_URL_SUFFIX) && !_GH_API_URL_KEEP.has(key)) || _GH_API_NOISE_KEYS.has(key)) {
        removed++
      } else {
        const [childCleaned, childRemoved] = stripGhApiUrlFields(value)
        cleaned[key] = childCleaned
        removed += childRemoved
      }
    }
    return [cleaned, removed]
  }
  if (Array.isArray(obj)) {
    let totalRemoved = 0
    const resultList = obj.map((item) => {
      const [cleaned, n] = stripGhApiUrlFields(item)
      totalRemoved += n
      return cleaned
    })
    return [resultList, totalRemoved]
  }
  return [obj, 0]
}

/** Compress `gh api` JSON: strip *_url boilerplate fields, fall back to squeeze. */
function compressGhApi(text: string): string {
  const stripped = text.trim()
  if (!stripped) return text
  let obj: unknown
  try {
    obj = JSON.parse(stripped)
  } catch {
    return squeezeBlankLines(text)
  }
  const [cleaned, removed] = stripGhApiUrlFields(obj)
  if (removed === 0) return squeezeBlankLines(text)
  const serialized = JSON.stringify(cleaned, null, 2)
  const note = `# [token-goat] stripped ${removed} *_url boilerplate fields from gh api response`
  return `${serialized}\n${note}`
}

/** Collapse passing ✓ step headers and drop action-preamble lines in `gh run view` output. */
function compressGhRunView(text: string): string {
  const lines = text.split('\n')
  const kept: string[] = []
  let passSteps = 0
  let droppedPreamble = 0
  let inPassBlock = false

  for (const line of lines) {
    if (_GH_RUN_PASS_STEP_RE.test(line)) {
      passSteps++
      inPassBlock = true
      continue
    }
    if (_GH_RUN_FAIL_STEP_RE.test(line)) {
      inPassBlock = false
      kept.push(line)
      continue
    }
    if (inPassBlock && (line.startsWith('  ') || line.startsWith('\t'))) {
      droppedPreamble++
      continue
    }
    // A non-indented line closes any open pass block.
    if (line && !/^\s/.test(line)) {
      inPassBlock = false
    }
    kept.push(line)
  }

  const notes: string[] = []
  maybeNote(notes, passSteps, `collapsed ${passSteps} passing step headers`)
  maybeNote(notes, droppedPreamble, `dropped ${droppedPreamble} action-preamble lines`)
  if (notes.length) kept.push(`[token-goat: ${notes.join('; ')}]`)
  return squeezeBlankLines(kept.join('\n'))
}

/** Truncate `gh pr/run/issue list` output to first 30 rows + count. */
function compressGhList(text: string, subcommand: string): string {
  const lines = text.split('\n')
  // `gh pr/run/issue list` emits no header row when piped/non-TTY (exactly how the bash hook
  // captures it -- verified against gh 2.81.0) -- every non-empty line is a data row. Treating
  // the first non-empty line as a header (skipping it when counting/slicing data) silently
  // dropped the true first row from the count and undercounted the reported total by 1.
  let dataStart = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim()) {
      dataStart = i
      break
    }
  }
  let dataEnd = lines.length
  for (let i = dataStart; i < lines.length; i++) {
    if (!lines[i]!.trim()) {
      dataEnd = i
      break
    }
  }
  const totalDataRows = dataEnd - dataStart
  const maxRows = 30
  if (totalDataRows <= maxRows) return squeezeBlankLines(text)

  const keptLines = [
    ...lines.slice(0, dataStart),
    ...lines.slice(dataStart, dataStart + maxRows),
  ]
  keptLines.push(`[token-goat: showing first ${maxRows} of ${totalDataRows} ${subcommand}s]`)
  return squeezeBlankLines(keptLines.join('\n'))
}

/** Redact base64-encoded content fields in GitHub API JSON stdout. */
function redactGhBase64Content(stdout: string): string {
  const stripped = stdout.trim()
  if (!stripped || (stripped[0] !== '{' && stripped[0] !== '[')) return stdout
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return stdout
  }

  function isB64Content(val: unknown): boolean {
    return (
      typeof val === 'string' &&
      val.length > _GH_BASE64_MIN_LEN &&
      _GH_CONTENT_B64_RE.test(val)
    )
  }

  function redactObj(obj: Record<string, unknown>): Record<string, unknown> {
    const raw = obj['content']
    if (!isB64Content(raw)) return obj
    let nBytes = 0
    try {
      nBytes = Buffer.from(raw as string, 'base64').length
    } catch {
      // ignore
    }
    return { ...obj, content: `<base64 content: ${nBytes} bytes decoded>` }
  }

  let changed = false
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const redacted = redactObj(data as Record<string, unknown>)
    if (redacted !== data) {
      changed = true
      data = redacted
    }
  } else if (Array.isArray(data)) {
    const newList = data.map((item) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const newItem = redactObj(item as Record<string, unknown>)
        if (newItem !== item) changed = true
        return newItem
      }
      return item
    })
    if (changed) data = newList
  }

  if (!changed) return stdout
  const pretty = stdout.includes('\n')
  return JSON.stringify(data, null, pretty ? 2 : undefined)
}

// ---------------------------------------------------------------------------
// GhRunLogFilter
// ---------------------------------------------------------------------------

export class GhRunLogFilter extends ToolFilter {
  readonly name = 'gh-run-log'
  override readonly binaries = new Set(['gh'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const first = argv[0]!
    const stem = pathStem(first).toLowerCase()
    const name = pathName(first).toLowerCase()
    if (stem !== 'gh' && name !== 'gh') return false
    const positionals = positionalArgs(argv.slice(1))
    return (
      positionals.length >= 2 &&
      positionals[0] === 'run' &&
      positionals[1] === 'view' &&
      // `--log-failed` is the CI-triage spelling and emits the identical
      // job/step/timestamp column format, so it needs this filter too. A plain
      // `argv.includes('--log')` is a whole-token test and never matches it,
      // which sent it to GhFilter -- whose pass-step regex anchors at line
      // start and so matches nothing while the column prefix is still present.
      (argv.includes('--log') || argv.includes('--log-failed'))
    )
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const rawLines = merged.split('\n')
    // Strip step-name TAB prefix (gh run view --log column format)
    const stepStripped = rawLines.map((ln) => ln.replace(_GH_LOG_STEP_PREFIX_RE, ''))
    // Strip timestamp prefixes
    const lines = stripTimestamps(stepStripped)

    const kept: string[] = []
    const setupActions: string[] = []
    let droppedBoilerplate = 0
    let droppedCleanup = 0
    let droppedCommands = 0
    let collapsedGroups = 0

    // Group-collapse state
    let inGroup = false
    let groupName = ''
    let groupLines: string[] = []
    let groupHasFailure = false
    const GROUP_COLLAPSE_THRESHOLD = 20

    const flushGroup = (): void => {
      if (!groupLines.length) return
      if (groupHasFailure || groupLines.length <= GROUP_COLLAPSE_THRESHOLD) {
        // Keep the step name too. The per-line job/step columns were already stripped above, so this header is the only attribution left: without it a failure inside a kept group cannot be traced to the step that produced it, while a collapsed group (below) keeps its name.
        if (groupName) kept.push(`[group: ${groupName}]`)
        kept.push(...groupLines)
      } else {
        kept.push(`[group: ${groupName} — ${groupLines.length} lines collapsed by token-goat]`)
        collapsedGroups++
      }
    }

    for (const line of lines) {
      // Boilerplate
      if (_GH_LOG_BOILERPLATE_RE.test(line)) {
        droppedBoilerplate++
        continue
      }
      // Post-run cleanup
      if (_GH_LOG_POST_STEP_RE.test(line)) {
        droppedCleanup++
        continue
      }
      // Command-echo lines — drop unless they contain a failure signal
      if (_GH_LOG_COMMAND_RE.test(line) && !_GH_LOG_FAILURE_RE.test(line)) {
        droppedCommands++
        continue
      }
      // Group open
      const mGroup = _GH_LOG_GROUP_RE.exec(line)
      if (mGroup) {
        flushGroup()
        inGroup = true
        groupName = (mGroup[1] ?? '').trim()
        groupLines = []
        groupHasFailure = false
        continue
      }
      // Group close
      if (_GH_LOG_ENDGROUP_RE.test(line)) {
        flushGroup()
        inGroup = false
        groupLines = []
        continue
      }
      // Setup action lines
      if (_GH_LOG_SETUP_ACTION_RE.test(line)) {
        setupActions.push(line)
        continue
      }
      // All other lines
      if (inGroup) {
        if (_GH_LOG_FAILURE_RE.test(line)) groupHasFailure = true
        groupLines.push(line)
      } else {
        kept.push(line)
      }
    }

    // Flush any unclosed group
    flushGroup()

    // Setup actions summary
    if (setupActions.length) {
      kept.push(`[token-goat: Setup: ${setupActions.length} action(s) collapsed]`)
    }

    const notes: string[] = []
    maybeNote(notes, droppedBoilerplate, `dropped ${droppedBoilerplate} boilerplate lines`)
    maybeNote(notes, droppedCommands, `dropped ${droppedCommands} ##[command] echo lines`)
    maybeNote(notes, droppedCleanup, `dropped ${droppedCleanup} cleanup lines`)
    maybeNote(notes, collapsedGroups, `collapsed ${collapsedGroups} log group(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// GhFilter
// ---------------------------------------------------------------------------

export class GhFilter extends ToolFilter {
  readonly name = 'gh'
  override readonly binaries = new Set(['gh'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const redactedStdout = redactGhBase64Content(stdout)
    const positionals = positionalArgs(argv.slice(1), GH_GLOBAL_VALUE_FLAGS)
    const subcommand = positionals[0] ?? ''
    const action = positionals[1] ?? ''
    const merged = this.combineOutput(redactedStdout, stderr)

    if (subcommand === 'run' && action === 'view') {
      return compressGhRunView(merged)
    }
    if ((subcommand === 'pr' || subcommand === 'run' || subcommand === 'issue') && action === 'list') {
      return compressGhList(merged, subcommand)
    }
    if (subcommand === 'api') {
      return compressGhApi(merged)
    }
    // Everything else: blank-line squeeze only
    return squeezeBlankLines(merged)
  }
}

// ---------------------------------------------------------------------------
// ActFilter
// ---------------------------------------------------------------------------

export class ActFilter extends ToolFilter {
  readonly name = 'act'
  override readonly binaries = new Set(['act'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let dockerPullDropped = 0
    const matrixLines: string[] = []

    for (const line of lines) {
      // Status lines (✅ ❌) — keep verbatim with prefix
      if (_ACT_STATUS_RE.test(line)) {
        kept.push(line)
        continue
      }
      // Docker pull progress — collapse
      if (_ACT_DOCKER_PULL_RE.test(line)) {
        dockerPullDropped++
        continue
      }
      // Matrix expansion — collect for summary
      if (_ACT_MATRIX_EXPAND_RE.test(line)) {
        matrixLines.push(line)
        continue
      }
      // Strip [job/step] | prefix from body lines
      const m = _ACT_JOB_PREFIX_RE.exec(line)
      const body = m ? (m.groups?.['body'] ?? line) : line
      kept.push(body)
    }

    const notes: string[] = []
    maybeNote(notes, dockerPullDropped, `collapsed ${dockerPullDropped} docker-pull progress lines`)
    maybeNote(notes, matrixLines.length, `collapsed ${matrixLines.length} matrix expansion lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// GenericCIFilter
// ---------------------------------------------------------------------------

export class GenericCIFilter extends ToolFilter {
  readonly name = 'generic-ci'
  // No binaries — matched via custom matches() only
  override readonly binaries = new Set<string>()

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const cmdStr = argv.join(' ').toLowerCase()
    return [..._CI_COMMAND_KEYWORDS].some((kw) => cmdStr.includes(kw))
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    // Strip timestamp prefixes upfront
    const lines = stripTimestamps(merged.split('\n'))
    const kept: string[] = []
    let debugCount = 0
    let heartbeatCount = 0

    for (let line of lines) {
      // Strip stray ANSI escapes
      line = line.replace(_CI_ANSI_RE, '')

      // Always keep failure lines
      if (ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      // Heartbeat / health-check — collapse
      if (_CI_HEARTBEAT_RE.test(line)) {
        heartbeatCount++
        continue
      }
      // DEBUG / TRACE — collapse to count
      if (_CI_DEBUG_RE.test(line)) {
        debugCount++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, debugCount, `collapsed ${debugCount} DEBUG/TRACE lines`)
    maybeNote(notes, heartbeatCount, `collapsed ${heartbeatCount} heartbeat/health-check lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// PreCommitFilter
// ---------------------------------------------------------------------------

export class PreCommitFilter extends ToolFilter {
  readonly name = 'pre-commit'
  override readonly binaries = new Set(['pre-commit'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let passed = 0
    let skipped = 0
    let infoDropped = 0
    let firstInfoKept = false
    let inFailBlock = false

    for (const line of lines) {
      const m = _PRECOMMIT_RESULT_RE.exec(line)
      if (m) {
        const status = m.groups?.['status'] ?? ''
        if (status === 'Failed' || status === 'Pre-commit hook failed') {
          if (passed || skipped) {
            kept.push(`[token-goat: collapsed ${passed} Passed, ${skipped} Skipped hook(s)]`)
            passed = 0
            skipped = 0
          }
          inFailBlock = true
          kept.push(line)
          continue
        }
        inFailBlock = false
        if (status === 'Passed') passed++
        else if (status === 'Skipped') skipped++
        continue
      }

      if (_PRECOMMIT_INFO_RE.test(line)) {
        if (firstInfoKept) {
          infoDropped++
          continue
        }
        firstInfoKept = true
        kept.push(line)
        continue
      }

      // End of indented failure block: a blank line
      if (inFailBlock && !line.trim()) {
        inFailBlock = false
      }
      kept.push(line)
    }

    if (passed || skipped) {
      kept.push(`[token-goat: collapsed ${passed} Passed, ${skipped} Skipped hook(s)]`)
    }
    if (infoDropped) {
      kept.push(`[token-goat: dropped ${infoDropped} pre-commit [INFO] env-setup lines]`)
    }
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// makeSecurityScannerFilter — shared factory for bandit/trivy/snyk/semgrep (Not used here since their bodies differ significantly; bespoke classes below)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BanditFilter
// ---------------------------------------------------------------------------

export class BanditFilter extends ToolFilter {
  readonly name = 'bandit'
  override readonly binaries = new Set(['bandit'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let lowDropped = 0

    let inIssue = false
    let currentSeverity = ''
    let issueBuf: string[] = []

    // Set when the block just collapsed took its own dashed rule with it, so the rule that immediately follows is dropped too rather than doubling up with the previous kept block's rule. Only the very next line is eligible: anything else clears the flag untouched.
    let dropTrailingSeparator = false

    const flushIssue = (): void => {
      const sev = currentSeverity.toUpperCase()
      if (sev === 'HIGH' || sev === 'MEDIUM') {
        kept.push(...issueBuf)
      } else {
        lowDropped++
        dropTrailingSeparator = true
      }
    }

    let inStatsBlock = false

    for (const line of lines) {
      if (dropTrailingSeparator) {
        dropTrailingSeparator = false
        if (_BANDIT_SEPARATOR_RE.test(line)) continue
      }

      // Drop per-file progress lines
      if (_BANDIT_TESTING_RE.test(line)) continue

      // Stats block openers — flush pending issue first
      if (_BANDIT_CODE_SCANNED_RE.test(line) || _BANDIT_TOTAL_ISSUES_RE.test(line)) {
        if (inIssue) {
          flushIssue()
          inIssue = false
          issueBuf = []
          currentSeverity = ''
        }
        inStatsBlock = true
        kept.push(line)
        continue
      }

      // Inside stats block: keep numeric stat lines and blank delimiters
      if (inStatsBlock) {
        if (_BANDIT_STAT_LINE_RE.test(line) || !line.trim()) {
          kept.push(line)
        } else {
          // Non-blank non-stat line closes the stats block
          inStatsBlock = false
          // Fall through to normal processing
        }
      }
      if (inStatsBlock) continue

      // Issue block opener
      if (_BANDIT_ISSUE_SEVERITY_RE.test(line)) {
        if (inIssue) {
          flushIssue()
          issueBuf = []
          currentSeverity = ''
        }
        inIssue = true
        issueBuf.push(line)
        continue
      }

      // Inside an issue block — buffer every line unconditionally (including
      // numbered source-context lines) until the closing separator/blank
      // line decides keep-vs-drop.
      if (inIssue) {
        issueBuf.push(line)
        if (line.trim() === '' || line.trim().startsWith('--')) {
          // flushIssue() already emits this closing line via issueBuf (for HIGH/MEDIUM);
          // pushing it again here would duplicate it, and for LOW severity (fully dropped)
          // it would leak the separator despite the whole issue being collapsed.
          flushIssue()
          inIssue = false
          issueBuf = []
          currentSeverity = ''
        } else {
          const sevM = /Severity:\s*(\w+)/i.exec(line)
          if (sevM) currentSeverity = sevM[1] ?? ''
        }
        continue
      }

      // Always keep: run banner, section headers, other lines
      if (_BANDIT_RUN_STARTED_RE.test(line) || _BANDIT_TEST_RESULTS_RE.test(line)) {
        kept.push(line)
        continue
      }
      kept.push(line)
    }

    // Flush trailing open issue block
    if (inIssue) flushIssue()

    const notes: string[] = []
    maybeNote(notes, lowDropped, `collapsed ${lowDropped} LOW severity issue block(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// TrivyFilter
// ---------------------------------------------------------------------------

export class TrivyFilter extends ToolFilter {
  readonly name = 'trivy'
  override readonly binaries = new Set(['trivy'])

  private readonly _highSeps = new Set(['CRITICAL', 'HIGH'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    // Strip log-noise from stderr first
    const cleanErrLines = stderr
      ? stderr.split('\n').filter((ln) => !_TRIVY_LOG_RE.test(ln))
      : []
    const logDropped = stderr.trim()
      ? stderr.split('\n').length - cleanErrLines.length
      : 0
    const cleanErr = cleanErrLines.join('\n').trim()

    const outLines = stdout.split('\n')
    const kept: string[] = []
    // Per-library MEDIUM/LOW/UNKNOWN collapsed counts
    const lowMedCounts = new Map<string, Map<string, number>>()
    let inTable = false
    let sevColIdx = -1
    let libColIdx = -1

    const parseTableCols = (headerLine: string): void => {
      const cols = headerLine.split('|').map((c) => c.trim())
      for (let i = 0; i < cols.length; i++) {
        const cu = (cols[i] ?? '').toUpperCase()
        if (cu === 'SEVERITY') sevColIdx = i
        if ((cu === 'LIBRARY' || cu === 'PACKAGE' || cu === 'VULNERABILITY ID') && libColIdx === -1) {
          libColIdx = i
        }
      }
    }

    const flushLowMed = (): void => {
      for (const [lib, sevCounts] of [...lowMedCounts.entries()].sort()) {
        const summary = [...sevCounts.entries()]
          .sort()
          .map(([sev, cnt]) => `${sev}: ${cnt}`)
          .join(', ')
        kept.push(`[token-goat: ${lib} — ${summary} (collapsed)]`)
      }
      lowMedCounts.clear()
    }

    for (const line of outLines) {
      // No-vuln messages always preserved
      if (_TRIVY_NO_VULN_RE.test(line)) {
        kept.push(line)
        continue
      }
      // Total summary — always keep
      if (_TRIVY_TOTAL_RE.test(line)) {
        flushLowMed()
        kept.push(line)
        continue
      }
      // Table separator
      if (_TRIVY_TABLE_SEP_RE.test(line)) {
        kept.push(line)
        inTable = !!line
        continue
      }
      // Table header row — detect column positions
      if (inTable && line.startsWith('|') && line.toUpperCase().includes('SEVERITY')) {
        parseTableCols(line)
        kept.push(line)
        continue
      }
      // Table data row
      if (inTable && _TRIVY_TABLE_ROW_RE.test(line)) {
        const cols = line.split('|').map((c) => c.trim())
        let sev = ''
        if (sevColIdx >= 0 && sevColIdx < cols.length) sev = (cols[sevColIdx] ?? '').toUpperCase()
        if (this._highSeps.has(sev)) {
          kept.push(line)
        } else {
          let lib = 'unknown'
          if (libColIdx >= 0 && libColIdx < cols.length) lib = cols[libColIdx] || 'unknown'
          if (!lowMedCounts.has(lib)) lowMedCounts.set(lib, new Map())
          const sevKey = sev || 'UNKNOWN'
          const libMap = lowMedCounts.get(lib)!
          libMap.set(sevKey, (libMap.get(sevKey) ?? 0) + 1)
        }
        continue
      }
      // Target/library section header
      if (_TRIVY_TARGET_RE.test(line) || line.startsWith('=') || line.startsWith('-')) {
        flushLowMed()
        inTable = false
        sevColIdx = -1
        libColIdx = -1
        kept.push(line)
        continue
      }
      kept.push(line)
    }

    flushLowMed()

    const outText = this.finalize(kept)
    const notes: string[] = []
    maybeNote(notes, logDropped, `dropped ${logDropped} Trivy INFO/WARN/DEBUG log lines`)
    // Append notes as a separate trailing line if needed
    if (notes.length) {
      const withNotes = outText.trimEnd() + `\n[token-goat: ${notes.join('; ')}]`
      if (cleanErr) {
        return withNotes + '\n---\n' + cleanErr
      }
      return withNotes
    }

    if (cleanErr) {
      return outText.trim() ? outText.trimEnd() + '\n---\n' + cleanErr : cleanErr
    }
    return outText
  }
}

// ---------------------------------------------------------------------------
// SnykFilter
// ---------------------------------------------------------------------------

export class SnykFilter extends ToolFilter {
  readonly name = 'snyk'
  override readonly binaries = new Set(['snyk'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []

    let testingSeen = false
    let treeLines = 0
    let treeHidden = 0
    let inMoreAbout = false
    let moreAboutDropped = 0

    for (const line of lines) {
      // Testing progress
      if (_SNYK_TESTING_RE.test(line)) {
        if (!testingSeen) {
          kept.push(line)
          testingSeen = true
        }
        continue
      }

      // Summary lines always kept
      if (_SNYK_SUMMARY_RE.test(line)) {
        if (treeHidden) {
          kept.push(`[token-goat: +${treeHidden} dependency tree lines collapsed]`)
          treeHidden = 0
        }
        kept.push(line)
        continue
      }

      // License issue lines always kept
      if (_SNYK_LICENSE_RE.test(line) && !_SNYK_TREE_LINE_RE.test(line)) {
        if (inMoreAbout) {
          if (moreAboutDropped) {
            kept.push(`[token-goat: collapsed ${moreAboutDropped} 'More about' URL line(s)]`)
            moreAboutDropped = 0
          }
          inMoreAbout = false
        }
        kept.push(line)
        continue
      }

      // "More about..." / URL-only lines
      if (_SNYK_MORE_ABOUT_RE.test(line)) {
        inMoreAbout = true
        moreAboutDropped++
        continue
      }
      if (inMoreAbout) {
        if (line.trim() && !line.trim().startsWith('http')) {
          inMoreAbout = false
          if (moreAboutDropped) {
            kept.push(`[token-goat: collapsed ${moreAboutDropped} 'More about' URL line(s)]`)
            moreAboutDropped = 0
          }
          // Fall through to normal handling
        } else {
          moreAboutDropped++
          continue
        }
      }

      // Vulnerability block headers
      if (_SNYK_VULN_HEADER_RE.test(line)) {
        if (treeHidden) {
          kept.push(`[token-goat: +${treeHidden} dependency tree lines collapsed]`)
          treeHidden = 0
        }
        kept.push(line)
        continue
      }

      // Dependency tree lines
      if (_SNYK_TREE_LINE_RE.test(line) && line.trim()) {
        treeLines++
        if (treeLines <= 10) {
          kept.push(line)
        } else {
          treeHidden++
        }
        continue
      }

      // All other lines
      if (treeHidden && !_SNYK_TREE_LINE_RE.test(line)) {
        kept.push(`[token-goat: +${treeHidden} dependency tree lines collapsed]`)
        treeHidden = 0
      }
      if (moreAboutDropped) {
        kept.push(`[token-goat: collapsed ${moreAboutDropped} 'More about' URL line(s)]`)
        moreAboutDropped = 0
      }
      kept.push(line)
    }

    // Flush trailing counts
    if (treeHidden) kept.push(`[token-goat: +${treeHidden} dependency tree lines collapsed]`)
    if (moreAboutDropped) {
      kept.push(`[token-goat: collapsed ${moreAboutDropped} 'More about' URL line(s)]`)
    }
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// SemgrepFilter
// ---------------------------------------------------------------------------

export class SemgrepFilter extends ToolFilter {
  readonly name = 'semgrep'
  override readonly binaries = new Set(['semgrep'])

  // Max instances of the same rule to keep before collapsing
  private readonly _maxPerRule = 3

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []

    let scanningSeen = false
    // rule_id → count of instances already emitted
    const ruleCounts = new Map<string, number>()
    // rule_id → count of instances suppressed
    const ruleSuppressed = new Map<string, number>()

    let currentRule: string | null = null
    let currentBlock: string[] = []

    const flushBlock = (): void => {
      if (currentRule === null) {
        kept.push(...currentBlock)
        return
      }
      const count = ruleCounts.get(currentRule) ?? 0
      if (count < this._maxPerRule) {
        // Emit block, stripping Details: lines
        const blockOut: string[] = []
        let localDropped = 0
        for (const bl of currentBlock) {
          if (_SEMGREP_DETAILS_RE.test(bl) || _SEMGREP_ANNOTATION_RE.test(bl)) {
            localDropped++
          } else {
            blockOut.push(bl)
          }
        }
        if (localDropped) {
          blockOut.push(`  [token-goat: collapsed ${localDropped} Details/annotation URL line(s)]`)
          }
        kept.push(...blockOut)
        ruleCounts.set(currentRule, count + 1)
      } else {
        ruleSuppressed.set(currentRule, (ruleSuppressed.get(currentRule) ?? 0) + 1)
      }
    }

    for (const line of lines) {
      // Scanning banner — keep first only
      if (_SEMGREP_SCANNING_RE.test(line)) {
        if (!scanningSeen) {
          flushBlock()
          currentRule = null
          currentBlock = []
          kept.push(line)
          scanningSeen = true
        }
        continue
      }

      // Summary line — flush and always keep
      if (_SEMGREP_SUMMARY_RE.test(line)) {
        flushBlock()
        currentRule = null
        currentBlock = []
        // Emit suppression notes before summary
        for (const [ruleId, supCnt] of [...ruleSuppressed.entries()].sort()) {
          kept.push(
            `[token-goat: ${ruleId} — ${supCnt} additional match(es) collapsed (kept first ${this._maxPerRule})]`,
          )
        }
        ruleSuppressed.clear()
        kept.push(line)
        continue
      }

      // Rule match header — non-indented rule id or severity+rule line
      const isRuleHeader =
        line &&
        !/^\s/.test(line) &&
        (_SEMGREP_RULE_HEADER_RE.test(line) ||
          (line.split('/').pop() ?? '').includes('.') ||
          /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(line)) &&
        !_SEMGREP_SUMMARY_RE.test(line) &&
        !_SEMGREP_SCANNING_RE.test(line)

      if (isRuleHeader) {
        flushBlock()
        currentRule = line.trim()
        currentBlock = [line]
        continue
      }

      // Everything else goes into the current block
      currentBlock.push(line)
    }

    // Flush trailing block
    flushBlock()
    // Emit any unseen suppression notes at end
    for (const [ruleId, supCnt] of [...ruleSuppressed.entries()].sort()) {
      kept.push(
        `[token-goat: ${ruleId} — ${supCnt} additional match(es) collapsed (kept first ${this._maxPerRule})]`,
      )
    }

    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// Singleton instances
// ---------------------------------------------------------------------------

export const ghRunLogFilter = new GhRunLogFilter()
export const ghFilter = new GhFilter()
export const actFilter = new ActFilter()
export const genericCIFilter = new GenericCIFilter()
export const preCommitFilter = new PreCommitFilter()
export const banditFilter = new BanditFilter()
export const trivyFilter = new TrivyFilter()
export const snykFilter = new SnykFilter()
export const semgrepFilter = new SemgrepFilter()

// ---------------------------------------------------------------------------
// CI_FILTERS — ordered: GhRunLogFilter before GhFilter (both match `gh`). GenericCIFilter is last since it only fires on keyword match, not binary.
// ---------------------------------------------------------------------------

export const CI_FILTERS: ToolFilter[] = [
  // gh run view --log — specific handler must precede generic GhFilter
  ghRunLogFilter,
  ghFilter,
  // local CI runner
  actFilter,
  // pre-commit hooks runner
  preCommitFilter,
  // security scanners
  banditFilter,
  trivyFilter,
  snykFilter,
  semgrepFilter,
  // catch-all keyword-based CI log filter — must be last so it doesn't preempt kubectl logs or other specific filters registered earlier
  genericCIFilter,
]
