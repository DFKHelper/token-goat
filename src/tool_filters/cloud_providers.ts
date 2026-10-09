// Cloud provider CLI filters (Batch G): aws/aws2, gcloud and az. Each is a faithful TypeScript port of its Python counterpart in bash_compress.py, and CLOUD_FILTERS in cloud.ts sets its dispatch position: AwsCliFilter, which owns the CloudFormation and S3 routing, must precede AwsFilter, the simpler JSON-array fallback, since both match `aws`/`aws2`.

import { ToolFilter } from './base.js'
import { clipWideLines, maybeNote, positionalArgs, truncateTableRows } from './helpers.js'
import { countNoun } from '../util.js'

// --------------------------------------------------------------------------- JSON array helpers shared by AwsCliFilter and AzureCliFilter ---------------------------------------------------------------------------

function _tryCompressJsonArray(text: string, threshold: number, keep: number): string | null {
  const stripped = text.trim()
  if (!stripped || (stripped[0] !== '{' && stripped[0] !== '[')) return null
  let data: unknown
  try {
    data = JSON.parse(stripped)
  } catch {
    return null
  }
  let changed = false
  // Nested arrays count too: `aws ec2 describe-instances` puts every instance of one launch under `Reservations[0].Instances`, so a top-level-only pass left an Auto Scaling group's hundreds of instances whole. The depth bound keeps a pathological document from recursing without end.
  const shrink = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== 'object' || depth > _JSON_ARRAY_MAX_DEPTH) return value
    if (Array.isArray(value)) {
      const kept = value.length > threshold ? value.slice(0, keep) : value
      const out = kept.map((item) => shrink(item, depth + 1))
      if (kept === value) return out
      changed = true
      return [...out, { __token_goat__: `${value.length} items (showing first ${keep})` }]
    }
    const obj = value as Record<string, unknown>
    for (const key of Object.keys(obj)) obj[key] = shrink(obj[key], depth + 1)
    return obj
  }
  data = shrink(data, 0)
  if (!changed) return null
  return JSON.stringify(data, null, 2)
}

const _JSON_ARRAY_MAX_DEPTH = 6

// --------------------------------------------------------------------------- AwsFilter  (simpler JSON list truncation — registered AFTER AwsCliFilter) ---------------------------------------------------------------------------

export class AwsFilter extends ToolFilter {
  readonly name = 'aws'
  override readonly binaries = new Set(['aws', 'aws2'])
  override readonly errorPassthrough = true

  // `--filter aws` selects this filter by name, so it parses the same indented documents AwsCliFilter does and needs the same exemption from the input clip.
  protected override consumesWholeJson(argv: string[]): boolean {
    return awsConsumesWholeJson(argv)
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    let text = stdout
    const compressed = _tryCompressJsonArray(text, 20, 20)
    if (compressed !== null) {
      text = compressed
    } else if (text.includes('\n') && text.includes('|')) {
      // A JSON document skips the input clip (consumesWholeJson), so bound its lines before the table pass sees them; table output uses kubectl-style row truncation.
      text = clipWideLines(text)
      text = _compressTable(text, 25)
    }
    if (stderr.trim()) {
      text = text.trim()
        ? `${text.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}`
        : stderr
    }
    return text
  }
}

export const awsFilter = new AwsFilter()

// --------------------------------------------------------------------------- AWS S3 transfer regexes ---------------------------------------------------------------------------

const _AWS_UPLOAD_RE = /^upload:\s+\S+\s+to\s+s3:\/\//i
const _AWS_DOWNLOAD_RE = /^download:\s+s3:\/\//i
// Every transfer type aws-cli can report, not just the two the progress regex used to swallow: its ResultPrinter renders one FAILURE_FORMAT of `{transfer_type} failed: ...`, so `aws s3 cp` between two buckets reports `copy failed:` and `rm`/`mv` report `delete failed:`/`move failed:`. Each of those four subcommands is routed to _compressS3Transfer (see isS3Transfer) -- a type matched here but not routed there would be an unreachable alternative, which is what `delete` was until `rm` was added.
const _AWS_S3_TRANSFER_FAILED_RE = /^(?:upload|download|copy|delete|move)\s+failed:/i
const _AWS_S3_PROGRESS_RE = /^(?:Completed\s+\d|\d+(?:\.\d+)?\s*(?:KiB|MiB|GiB|B)\/s|Calculating)/i

// AWS CLI's documented global options that take a separate value token (as opposed to a no-value boolean like --debug/--no-verify-ssl, or a `--flag=value` form already handled by positionalArgs' own `-`-prefix filter). These are valid anywhere in the argv, including before the subcommand (`aws --profile prod s3 cp ...`), so positionalArgs must skip both the flag and its value token to keep positions[0]/[1] pointing at the real subcommand/action.
const AWS_GLOBAL_VALUE_FLAGS = new Set([
  '--profile',
  '--region',
  '--endpoint-url',
  '--output',
  '--query',
  '--color',
  '--ca-bundle',
  '--cli-read-timeout',
  '--cli-connect-timeout',
  '--cli-binary-format',
  '--cli-pager',
])

function isS3Transfer(positionals: string[]): boolean {
  return (
    positionals.length >= 2 &&
    positionals[0] === 's3' &&
    // `rm` belongs here for the failure path, not the volume one: `aws s3 rm --recursive` reports `delete failed:` per object, and routing it anywhere else meant those lines were never counted. Its `delete:` success lines are not folded into a count -- only `upload:`/`download:` are -- so adding it drops nothing that used to survive.
    (positionals[1] === 'cp' || positionals[1] === 'sync' || positionals[1] === 'mv' || positionals[1] === 'rm')
  )
}

// aws prints indented JSON, so one string value past the clip width (a log message, a policy document, base64 UserData) left the document unparseable once clipped and the array was never truncated.
function awsConsumesWholeJson(argv: string[]): boolean {
  return !isS3Transfer(positionalArgs(argv.slice(1), AWS_GLOBAL_VALUE_FLAGS))
}

// --------------------------------------------------------------------------- AwsCliFilter  (enhanced — registered BEFORE AwsFilter) ---------------------------------------------------------------------------

export class AwsCliFilter extends ToolFilter {
  readonly name = 'aws-cli'
  override readonly binaries = new Set(['aws', 'aws2'])
  override readonly errorPassthrough = true

  private readonly _JSON_ARRAY_THRESHOLD = 10
  private readonly _JSON_ARRAY_KEEP = 3

  protected override consumesWholeJson(argv: string[]): boolean {
    return awsConsumesWholeJson(argv)
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    argv: string[],
  ): string {
    const positionals = positionalArgs(argv.slice(1), AWS_GLOBAL_VALUE_FLAGS)
    const isCfnEvents =
      positionals.length >= 2 &&
      positionals[0] === 'cloudformation' &&
      positionals[1] === 'describe-stack-events'

    let text = stdout
    if (isS3Transfer(positionals)) {
      text = this._compressS3Transfer(text)
    } else if (isCfnEvents) {
      const compressed = this._compressCfnStackEvents(text)
      if (compressed !== null) text = compressed
    } else {
      const compressed = _tryCompressJsonArray(
        text,
        this._JSON_ARRAY_THRESHOLD,
        this._JSON_ARRAY_KEEP,
      )
      if (compressed !== null) {
        text = compressed
      } else if (text.includes('\n') && text.includes('|')) {
        // A JSON document skips the input clip (consumesWholeJson), so bound its lines before the line-oriented table pass sees them.
        text = clipWideLines(text)
        // `--output table` results (e.g. `aws ec2 describe-instances --output table`) are not JSON, so _tryCompressJsonArray never fires. AwsCliFilter always wins dispatch over AwsFilter for real aws commands (see CLOUD_FILTERS ordering), so this fallback must live here; AwsFilter keeps its own copy for `--filter aws`, which selects it by name.
        text = _compressTable(text, 25)
      }
    }

    if (stderr.trim()) {
      text = text.trim()
        ? `${text.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}`
        : stderr
    }
    return text
  }

  private _compressS3Transfer(text: string): string {
    const lines = text.split('\n')
    const kept: string[] = []
    let uploadCount = 0
    let downloadCount = 0
    let failedCount = 0
    let progressDropped = 0
    for (const line of lines) {
      if (_AWS_UPLOAD_RE.test(line)) { uploadCount++; continue }
      if (_AWS_DOWNLOAD_RE.test(line)) { downloadCount++; continue }
      if (_AWS_S3_TRANSFER_FAILED_RE.test(line)) { failedCount++; kept.push(line); continue } // a failed transfer is always kept in full, never folded into the progress-line count, and counted in its own note -- the success counts alone read as a clean run, which is what made a dropped `upload failed:` line report the opposite of what happened
      if (_AWS_S3_PROGRESS_RE.test(line)) { progressDropped++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, uploadCount, `uploaded ${countNoun(uploadCount, 'file')}`)
    maybeNote(notes, downloadCount, `downloaded ${countNoun(downloadCount, 'file')}`)
    maybeNote(notes, failedCount, `${countNoun(failedCount, 'transfer')} failed`)
    maybeNote(notes, progressDropped, `dropped ${countNoun(progressDropped, 'progress line')}`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressCfnStackEvents(text: string): string | null {
    const stripped = text.trim()
    if (!stripped || stripped[0] !== '{') return null
    let data: Record<string, unknown>
    try {
      data = JSON.parse(stripped) as Record<string, unknown>
    } catch {
      return null
    }
    const events = data['StackEvents']
    if (!Array.isArray(events)) return null
    if (events.length <= this._JSON_ARRAY_THRESHOLD) return null

    const keptEvents: unknown[] = []
    const inProgressRun = new Map<string, number>()
    const lastResourceStatus = new Map<string, string>()

    for (const event of events) {
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        keptEvents.push(event)
        continue
      }
      const ev = event as Record<string, unknown>
      const resourceId = String(ev['LogicalResourceId'] ?? '')
      const status = String(ev['ResourceStatus'] ?? '')
      const isInProgress = status.endsWith('_IN_PROGRESS')

      if (isInProgress) {
        const prevStatus = lastResourceStatus.get(resourceId) ?? ''
        if (prevStatus.endsWith('_IN_PROGRESS') && prevStatus === status) {
          inProgressRun.set(resourceId, (inProgressRun.get(resourceId) ?? 0) + 1)
          continue
        }
        const prevCount = inProgressRun.get(resourceId) ?? 0
        inProgressRun.delete(resourceId)
        if (prevCount) {
          keptEvents.push({
            __token_goat__: `${prevCount} repeated ${prevStatus} ${prevCount === 1 ? 'event' : 'events'} for ${resourceId} collapsed`,
          })
        }
        keptEvents.push(event)
      } else {
        const prevCount = inProgressRun.get(resourceId) ?? 0
        inProgressRun.delete(resourceId)
        if (prevCount) {
          const prevStatus = lastResourceStatus.get(resourceId) ?? 'IN_PROGRESS'
          keptEvents.push({
            __token_goat__: `${prevCount} repeated ${prevStatus} ${prevCount === 1 ? 'event' : 'events'} for ${resourceId} collapsed`,
          })
        }
        keptEvents.push(event)
      }
      lastResourceStatus.set(resourceId, status)
    }

    // Flush remaining in-progress runs
    for (const [resourceId, count] of inProgressRun.entries()) {
      if (count) {
        const prevStatus = lastResourceStatus.get(resourceId) ?? 'IN_PROGRESS'
        keptEvents.push({
          __token_goat__: `${count} repeated ${prevStatus} ${count === 1 ? 'event' : 'events'} for ${resourceId} collapsed`,
        })
      }
    }

    data['StackEvents'] = keptEvents
    return JSON.stringify(data, null, 2)
  }
}

export const awsCliFilter = new AwsCliFilter()

// --------------------------------------------------------------------------- `--output table` row-truncation helper, used by both AwsCliFilter and AwsFilter below. ---------------------------------------------------------------------------

/** Truncate an `--output table`-shaped result to `maxRows` rows, with an AWS-specific narrowing hint (`--query`/`--max-items`, not kubectl's `--selector`/`-l` -- see {@link truncateTableRows}'s doc comment for why that distinction is load-bearing here). */
function _compressTable(text: string, maxRows = 10): string {
  return truncateTableRows(text, maxRows, 'use --query or --max-items to narrow')
}

// --------------------------------------------------------------------------- GcloudFilter ---------------------------------------------------------------------------

const _GCLOUD_SPINNER_RE = /^[⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/
const _GCLOUD_STATUS_RE = /^(?:Updated|Created|Deleted)\s+\[https?:\/\//i
const _GCLOUD_API_ENABLE_RE =
  /^(?:Enabling service|Waiting for async operation|Operation \[operation-)/i
const _GCLOUD_CONTINUE_RE = /Do you want to continue/i
const _GCLOUD_STRUCTURED_THRESHOLD = 20
const _GCLOUD_STRUCTURED_CHARS = new Set(['{', ':', '[', ']', '-', '}'])
// `gcloud ... list --format=yaml` prints one `---`-prefixed YAML document per resource (real, documented gcloud printer behaviour), so 2+ separator lines reliably means "multiple repeated resource blocks" -- the only shape this filter should ever collapse. A single `describe`'s YAML document has none: it's one coherent answer (status/zone/networkInterfaces/etc.), not noise.
const _GCLOUD_DOC_SEPARATOR_RE = /^---\s*$/
const _GCLOUD_MIN_REPEATED_BLOCKS = 2

export class GcloudFilter extends ToolFilter {
  readonly name = 'gcloud'
  override readonly binaries = new Set(['gcloud'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    let text = this._compressGcloud(stdout)
    if (stderr.trim()) {
      text = text.trim()
        ? `${text.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}`
        : stderr
    }
    return text
  }

  private _compressGcloud(text: string): string {
    const lines = text.split('\n')
    let kept: string[] = []
    let spinnersDropped = 0
    let apiEnableDropped = 0

    for (const line of lines) {
      if (_GCLOUD_SPINNER_RE.test(line)) { spinnersDropped++; continue }
      if (_GCLOUD_API_ENABLE_RE.test(line)) { apiEnableDropped++; continue }
      kept.push(line)
    }

    kept = this._maybeCollapseStructured(kept)

    const notes: string[] = []
    maybeNote(notes, spinnersDropped, `dropped ${countNoun(spinnersDropped, 'spinner line')}`)
    maybeNote(notes, apiEnableDropped, `collapsed ${countNoun(apiEnableDropped, 'API enablement line')}`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _maybeCollapseStructured(lines: string[]): string[] {
    const nonEmpty = lines.filter((ln) => ln.trim())
    if (nonEmpty.length <= _GCLOUD_STRUCTURED_THRESHOLD) return lines

    // Never collapse a single coherent YAML document (e.g. one `describe`'s status/zone/networkInterfaces/etc. -- the actual answer the command was run to retrieve). Only collapse genuinely repeated resource blocks, as produced by `gcloud ... list --format=yaml` for multiple resources.
    const separatorCount = lines.filter((ln) => _GCLOUD_DOC_SEPARATOR_RE.test(ln)).length
    if (separatorCount < _GCLOUD_MIN_REPEATED_BLOCKS) return lines

    let structuredCount = 0
    for (const ln of nonEmpty) {
      if (
        [...ln].some((ch) => _GCLOUD_STRUCTURED_CHARS.has(ch)) &&
        !_GCLOUD_STATUS_RE.test(ln) &&
        !_GCLOUD_CONTINUE_RE.test(ln)
      ) {
        structuredCount++
      }
    }
    const ratio = nonEmpty.length > 0 ? structuredCount / nonEmpty.length : 0
    if (ratio >= 0.7) {
      return [
        `[Resource description: ${nonEmpty.length} lines across ${separatorCount} resources (use --format=json to see full output)]`,
      ]
    }
    return lines
  }
}

export const gcloudFilter = new GcloudFilter()

// --------------------------------------------------------------------------- AzureCliFilter ---------------------------------------------------------------------------

const _AZ_PREVIEW_RE =
  /^(?:Command group|The command|This command).*\bis in preview/i
const _AZ_PROGRESS_JSON_RE =
  /^\s*\{[^}]*"(?:status|percentComplete|provisioningState)"[^}]*\}\s*$/

const _AZ_JSON_ARRAY_THRESHOLD = 10
const _AZ_JSON_ARRAY_KEEP = 3

export class AzureCliFilter extends ToolFilter {
  readonly name = 'azure-cli'
  override readonly binaries = new Set(['az'])
  override readonly errorPassthrough = true

  // az prints indented JSON too, with the same failure: a wide string value made the clipped document unparseable.
  protected override consumesWholeJson(_argv: string[]): boolean {
    return true
  }

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    let text = this._compressAz(stdout)
    if (stderr.trim()) {
      text = text.trim()
        ? `${text.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}`
        : stderr
    }
    return text
  }

  private _compressAz(text: string): string {
    // Try JSON array compression first (whole document).
    const compressed = _tryCompressJsonArray(text, _AZ_JSON_ARRAY_THRESHOLD, _AZ_JSON_ARRAY_KEEP)
    if (compressed !== null) return compressed

    // A JSON document skips the input clip (consumesWholeJson), so bound its lines before the line regexes below see them.
    const lines = clipWideLines(text).split('\n')
    const kept: string[] = []
    let previewDropped = 0
    let lastProgressStatus: string | null = null
    let inProgressRun = false

    for (const line of lines) {
      if (_AZ_PREVIEW_RE.test(line)) { previewDropped++; continue }
      if (_AZ_PROGRESS_JSON_RE.test(line)) {
        lastProgressStatus = line.trim()
        inProgressRun = true
        continue
      }
      // Flush on exit from progress run
      if (inProgressRun) {
        if (lastProgressStatus) kept.push(lastProgressStatus)
        inProgressRun = false
        lastProgressStatus = null
      }
      kept.push(line)
    }
    if (inProgressRun && lastProgressStatus) kept.push(lastProgressStatus)

    const notes: string[] = []
    maybeNote(notes, previewDropped, `collapsed ${countNoun(previewDropped, 'preview warning')}`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const azureCliFilter = new AzureCliFilter()
