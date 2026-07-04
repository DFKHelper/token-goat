// Cloud / IaC filter family (Batch G): terraform/tofu/terragrunt, aws/aws-cli, gcloud, az, ansible, pulumi, cdk, vault, packer, nix, wrangler, hardhat, serverless/sls, fly/flyctl, forge, hardhat.
//
// Ported faithfully from the Python bash_compress.py cloud family. Dispatch ordering note: AwsCliFilter must precede AwsFilter in CLOUD_FILTERS — both match `aws`/`aws2`, but AwsCliFilter is the more specific handler with CFN/S3 routing; AwsFilter is the simpler JSON-array fallback. Listing specific-before-generic preserves the Python registry order exactly.

import { ToolFilter } from './base.js'
import {
  ERROR_SIGNAL_RE,
  headTailCompress,
  maybeNote,
  pathName,
  positionalArgs,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Terraform regexes
// ---------------------------------------------------------------------------

const _TF_REFRESH_RE =
  /^[a-z0-9_.[\]"-]+: (Refreshing state|Reading|Read complete|Still |Modifications complete)/

const _TF_PLAN_SUMMARY_RE = /^Plan: \d+ to (add|change|destroy|import)/

const _TF_NO_CHANGES_RE = /^No changes\.|^(?:This plan does nothing|Nothing to do\.)/i

const _TF_STILL_RE =
  /^[a-z0-9_.[\]"-]+: Still (?:creating|modifying|destroying)\.\.\./i

const _TF_APPLY_COMPLETE_RE = /^Apply complete! Resources:/

const _TF_RESOURCE_COMPLETE_RE =
  /^[a-z0-9_.[\]"-]+: (?:Creation|Destruction|Modifications?) complete/i

const _TF_PLAN_ATTR_DIFF_RE = /^\s+[~+-]\s+\S/

const _TF_KNOWN_AFTER_APPLY_RE = /\(known after apply\)/

const _TF_INIT_PROVIDER_RE =
  /^\s*-\s+(?:Finding|Installing|Installed|Downloading|Locking)\s+\S+/i

const _TF_SHOW_RESOURCE_HDR_RE =
  /^# (?:(?:module\.\S+\.)?[a-z][a-z0-9_]+\.[a-zA-Z0-9_.[\]-]+):$/

const _TF_SHOW_KEY_ATTR_RE =
  /^\s+(?:id|arn|name|region|account_id|bucket|type|instance_type|endpoint|address|hostname|dns_name|tags(?:_all)?)\s*=/

// ---------------------------------------------------------------------------
// TerraformFilter
// ---------------------------------------------------------------------------

export class TerraformFilter extends ToolFilter {
  readonly name = 'terraform'
  override readonly binaries = new Set(['terraform', 'tofu', 'terragrunt'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    argv: string[],
  ): string {
    const positionals = positionalArgs(argv.slice(1))
    const subcommand = positionals[0] ?? ''

    let text = stdout
    if (subcommand === 'plan') {
      text = this._compressPlan(text)
    } else if (subcommand === 'apply') {
      return this._compressApply(text, stderr)
    } else if (subcommand === 'init') {
      text = this._compressInit(text)
    } else if (subcommand === 'show' || subcommand === 'state') {
      text = this._compressShow(text)
    } else if (
      subcommand === 'validate' ||
      subcommand === 'validate-config' ||
      subcommand === 'output' ||
      subcommand === 'outputs' ||
      subcommand === 'workspace' ||
      subcommand === 'import'
    ) {
      // pass through — short output
    } else {
      // Unknown subcommand: strip refresh noise
      const lines = text.split('\n')
      const filtered = lines.filter((ln) => !_TF_REFRESH_RE.test(ln))
      if (filtered.length > 30) {
        const nonEmpty = filtered.filter((ln) => ln.trim())
        text = headTailCompress(nonEmpty, 10, 20, 'lines')
      } else if (filtered.length < lines.length) {
        text = filtered.join('\n')
      }
    }

    if (stderr.trim() && subcommand !== 'apply') {
      text = text.trim() ? `${text.replace(/\s+$/, '')}\n---\n${stderr.replace(/\s+$/, '')}` : stderr
    }
    return text
  }

  private _compressPlan(stdout: string): string {
    const lines = stdout.split('\n')
    const kept: string[] = []
    let droppedRefresh = 0
    let droppedNoChange = 0
    let droppedKaa = 0

    let i = 0
    while (i < lines.length) {
      const line = lines[i]!

      if (_TF_REFRESH_RE.test(line)) {
        droppedRefresh++
        i++
        continue
      }

      // "will not be changed" / data-source read blocks — skip entire block
      if (
        line.startsWith('# ') &&
        (line.includes('will not be') ||
          line.includes('is up-to-date') ||
          line.includes('not be created') ||
          line.includes('will be read during apply') ||
          line.includes('is a data resource'))
      ) {
        i++
        while (i < lines.length) {
          const body = lines[i]!
          if (!body.trim()) break
          if (body.startsWith('# ')) break
          if (_TF_PLAN_SUMMARY_RE.test(body) || _TF_APPLY_COMPLETE_RE.test(body)) break
          i++
        }
        droppedNoChange++
        continue
      }

      if (_TF_NO_CHANGES_RE.test(line)) {
        kept.push(line)
        i++
        continue
      }

      // Resource block with (known after apply) attributes
      if (
        ((/^\s+resource\s+"/.test(line)) ||
          (/^\s{2,6}[a-z][a-z0-9_]*\.[a-zA-Z0-9_.[\]-]+\s+\{/.test(line))) &&
        i + 1 < lines.length
      ) {
        kept.push(line)
        i++
        let blockKaa = 0
        let blockNonKaaKept = 0
        const NON_KAA_KEEP_MAX = 8
        while (i < lines.length) {
          const body = lines[i]!
          if (/^\s{0,6}\}\s*$/.test(body)) {
            kept.push(body)
            i++
            break
          }
          if (_TF_PLAN_ATTR_DIFF_RE.test(body)) {
            kept.push(body)
            i++
            continue
          }
          if (_TF_KNOWN_AFTER_APPLY_RE.test(body)) {
            blockKaa++
            i++
            continue
          }
          if (blockNonKaaKept < NON_KAA_KEEP_MAX) {
            kept.push(body)
            blockNonKaaKept++
          } else {
            blockKaa++
          }
          i++
        }
        if (blockKaa) {
          kept.push(
            `    [token-goat: collapsed ${blockKaa} (known after apply) / excess attribute lines]`,
          )
          droppedKaa += blockKaa
        }
        continue
      }

      kept.push(line)
      i++
    }

    // Find plan summary and reorganise
    let summaryLine: string | null = null
    for (const ln of kept) {
      if (_TF_PLAN_SUMMARY_RE.test(ln)) {
        summaryLine = ln
        break
      }
    }

    let finalKept: string[]
    if (summaryLine !== null) {
      const tailLines = kept.filter((ln) => !_TF_REFRESH_RE.test(ln))
      finalKept = [summaryLine]
      const tailStart = Math.max(0, tailLines.length - 20)
      finalKept.push(...tailLines.slice(tailStart).filter((ln) => ln !== summaryLine))
    } else {
      finalKept = kept
    }

    const notes: string[] = []
    maybeNote(notes, droppedRefresh, `dropped ${droppedRefresh} terraform refresh/read lines`)
    maybeNote(notes, droppedNoChange, `collapsed ${droppedNoChange} unchanged/read-only block(s)`)
    maybeNote(notes, droppedKaa, `collapsed ${droppedKaa} (known after apply) attribute lines`)
    this.emitNotes(finalKept, notes)
    return this.finalize(finalKept)
  }

  private _compressApply(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let droppedRefresh = 0
    const stillLast = new Map<string, string>()
    let stillDropped = 0

    for (const line of lines) {
      if (_TF_RESOURCE_COMPLETE_RE.test(line)) {
        const resourceKey = line.split(':')[0]!.trim()
        const lastStill = stillLast.get(resourceKey)
        if (lastStill) {
          kept.push(lastStill)
          stillLast.delete(resourceKey)
        }
        kept.push(line)
        continue
      }
      if (_TF_REFRESH_RE.test(line)) {
        droppedRefresh++
        continue
      }
      if (_TF_STILL_RE.test(line)) {
        const resourceKey = line.split(': Still')[0]!.trim()
        if (stillLast.has(resourceKey)) stillDropped++
        stillLast.set(resourceKey, line)
        continue
      }
      if (_TF_APPLY_COMPLETE_RE.test(line) || ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (line.trim()) kept.push(line)
    }

    // Flush remaining "Still..." lines
    for (const line of stillLast.values()) kept.push(line)

    const notes: string[] = []
    maybeNote(notes, droppedRefresh, `dropped ${droppedRefresh} terraform refresh/read lines`)
    maybeNote(notes, stillDropped, `collapsed ${stillDropped} Still creating/modifying line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressInit(stdout: string): string {
    const lines = stdout.split('\n')
    const kept: string[] = []
    let providerCollapsed = 0
    for (const line of lines) {
      if (_TF_INIT_PROVIDER_RE.test(line)) {
        providerCollapsed++
        continue
      }
      kept.push(line)
    }
    // strip trailing blanks
    while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop()
    const nonEmpty = kept.filter((ln) => ln.trim())
    const notes: string[] = []
    maybeNote(notes, providerCollapsed, `collapsed ${providerCollapsed} provider install/find lines`)
    if (nonEmpty.length > 12) {
      let compressed = headTailCompress(nonEmpty, 5, 5, 'lines')
      if (notes.length) compressed = compressed.replace(/\s+$/, '') + '\n' + notes.join('\n')
      return compressed
    }
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressShow(stdout: string): string {
    const lines = stdout.split('\n')
    const kept: string[] = []
    let collapsedTotal = 0
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (_TF_SHOW_RESOURCE_HDR_RE.test(line)) {
        kept.push(line)
        i++
        let blockCollapsed = 0
        while (i < lines.length) {
          const body = lines[i]!
          if (!body.trim()) {
            kept.push(body)
            i++
            break
          }
          if (_TF_SHOW_RESOURCE_HDR_RE.test(body)) break
          if (/^(?:resource|data)\s+"/.test(body) || body.trim() === '}' || body.trim() === '{') {
            kept.push(body)
            i++
            continue
          }
          if (_TF_SHOW_KEY_ATTR_RE.test(body)) {
            kept.push(body)
            i++
            continue
          }
          blockCollapsed++
          collapsedTotal++
          i++
        }
        if (blockCollapsed) {
          kept.push(`  [token-goat: collapsed ${blockCollapsed} attribute lines]`)
        }
        continue
      }
      kept.push(line)
      i++
    }
    if (collapsedTotal === 0) {
      const nonEmpty = kept.filter((ln) => ln.trim())
      if (nonEmpty.length > 30) {
        return headTailCompress(nonEmpty, 20, 10, 'lines')
      }
    }
    const notes: string[] = []
    maybeNote(
      notes,
      collapsedTotal,
      `collapsed ${collapsedTotal} show/state attribute lines across resource blocks`,
    )
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const terraformFilter = new TerraformFilter()

// ---------------------------------------------------------------------------
// JSON array helpers shared by AwsCliFilter and AzureCliFilter
// ---------------------------------------------------------------------------

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
  if (Array.isArray(data) && data.length > threshold) {
    const original = data.length
    data = [...data.slice(0, keep), { __token_goat__: `${original} items (showing first ${keep})` }]
    changed = true
  } else if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      const value = obj[key]
      if (Array.isArray(value) && value.length > threshold) {
        const original = value.length
        obj[key] = [
          ...value.slice(0, keep),
          { __token_goat__: `${original} items (showing first ${keep})` },
        ]
        changed = true
      }
    }
  }
  if (!changed) return null
  return JSON.stringify(data, null, 2)
}

// ---------------------------------------------------------------------------
// AwsFilter  (simpler JSON list truncation — registered AFTER AwsCliFilter)
// ---------------------------------------------------------------------------

export class AwsFilter extends ToolFilter {
  readonly name = 'aws'
  override readonly binaries = new Set(['aws', 'aws2'])
  override readonly errorPassthrough = true

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
      // table output — use kubectl-style row truncation
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

// ---------------------------------------------------------------------------
// AWS S3 transfer regexes
// ---------------------------------------------------------------------------

const _AWS_UPLOAD_RE = /^upload:\s+\S+\s+to\s+s3:\/\//i
const _AWS_DOWNLOAD_RE = /^download:\s+s3:\/\//i
const _AWS_S3_PROGRESS_RE =
  /^(?:Completed\s+\d|\d+(?:\.\d+)?\s*(?:KiB|MiB|GiB|B)\/s|Calculating|upload\s+failed:|download\s+failed:)/i

// ---------------------------------------------------------------------------
// AwsCliFilter  (enhanced — registered BEFORE AwsFilter)
// ---------------------------------------------------------------------------

export class AwsCliFilter extends ToolFilter {
  readonly name = 'aws-cli'
  override readonly binaries = new Set(['aws', 'aws2'])
  override readonly errorPassthrough = true

  private readonly _JSON_ARRAY_THRESHOLD = 10
  private readonly _JSON_ARRAY_KEEP = 3

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    argv: string[],
  ): string {
    const positionals = positionalArgs(argv.slice(1))
    const isS3Transfer =
      positionals.length >= 2 &&
      positionals[0] === 's3' &&
      (positionals[1] === 'cp' || positionals[1] === 'sync' || positionals[1] === 'mv')
    const isCfnEvents =
      positionals.length >= 2 &&
      positionals[0] === 'cloudformation' &&
      positionals[1] === 'describe-stack-events'

    let text = stdout
    if (isS3Transfer) {
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
      if (compressed !== null) text = compressed
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
    let progressDropped = 0
    for (const line of lines) {
      if (_AWS_UPLOAD_RE.test(line)) { uploadCount++; continue }
      if (_AWS_DOWNLOAD_RE.test(line)) { downloadCount++; continue }
      if (_AWS_S3_PROGRESS_RE.test(line)) { progressDropped++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    maybeNote(notes, uploadCount, `uploaded ${uploadCount} file(s)`)
    maybeNote(notes, downloadCount, `downloaded ${downloadCount} file(s)`)
    maybeNote(notes, progressDropped, `dropped ${progressDropped} progress line(s)`)
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
            __token_goat__: `${prevCount} repeated ${prevStatus} event(s) for ${resourceId} collapsed`,
          })
        }
        keptEvents.push(event)
      } else {
        const prevCount = inProgressRun.get(resourceId) ?? 0
        inProgressRun.delete(resourceId)
        if (prevCount) {
          const prevStatus = lastResourceStatus.get(resourceId) ?? 'IN_PROGRESS'
          keptEvents.push({
            __token_goat__: `${prevCount} repeated ${prevStatus} event(s) for ${resourceId} collapsed`,
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
          __token_goat__: `${count} repeated ${prevStatus} event(s) for ${resourceId} collapsed`,
        })
      }
    }

    data['StackEvents'] = keptEvents
    return JSON.stringify(data, null, 2)
  }
}

export const awsCliFilter = new AwsCliFilter()

// ---------------------------------------------------------------------------
// kubectl table helper (reused by AwsFilter fallback)
// ---------------------------------------------------------------------------

function _compressTable(text: string, maxRows = 10): string {
  const lines = text.split('\n')
  const nonEmpty = lines.filter((l) => l.trim())
  if (nonEmpty.length <= maxRows + 1) return text
  const elided = nonEmpty.length - maxRows - 1
  return (
    nonEmpty.slice(0, maxRows + 1).join('\n') +
    `\n[token-goat: ${elided} more rows; use --selector or -l to narrow]`
  )
}

// ---------------------------------------------------------------------------
// GcloudFilter
// ---------------------------------------------------------------------------

const _GCLOUD_SPINNER_RE = /^[⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/
const _GCLOUD_STATUS_RE = /^(?:Updated|Created|Deleted)\s+\[https?:\/\//i
const _GCLOUD_API_ENABLE_RE =
  /^(?:Enabling service|Waiting for async operation|Operation \[operation-)/i
const _GCLOUD_CONTINUE_RE = /Do you want to continue/i
const _GCLOUD_STRUCTURED_THRESHOLD = 20
const _GCLOUD_STRUCTURED_CHARS = new Set(['{', ':', '[', ']', '-', '}'])
// `gcloud ... list --format=yaml` prints one `---`-prefixed YAML document per
// resource (real, documented gcloud printer behaviour), so 2+ separator lines
// reliably means "multiple repeated resource blocks" -- the only shape this
// filter should ever collapse. A single `describe`'s YAML document has none:
// it's one coherent answer (status/zone/networkInterfaces/etc.), not noise.
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
    maybeNote(notes, spinnersDropped, `dropped ${spinnersDropped} spinner line(s)`)
    maybeNote(notes, apiEnableDropped, `collapsed ${apiEnableDropped} API enablement line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _maybeCollapseStructured(lines: string[]): string[] {
    const nonEmpty = lines.filter((ln) => ln.trim())
    if (nonEmpty.length <= _GCLOUD_STRUCTURED_THRESHOLD) return lines

    // Never collapse a single coherent YAML document (e.g. one `describe`'s
    // status/zone/networkInterfaces/etc. -- the actual answer the command was
    // run to retrieve). Only collapse genuinely repeated resource blocks, as
    // produced by `gcloud ... list --format=yaml` for multiple resources.
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

// ---------------------------------------------------------------------------
// AzureCliFilter
// ---------------------------------------------------------------------------

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

    const lines = text.split('\n')
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
    maybeNote(notes, previewDropped, `collapsed ${previewDropped} preview warning(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const azureCliFilter = new AzureCliFilter()

// ---------------------------------------------------------------------------
// AnsibleFilter
// ---------------------------------------------------------------------------

const _ANSIBLE_STATUS_RE = /^(ok|changed|skipping|skipped|included):\s*\[/
const _ANSIBLE_HEADER_RE = /^(PLAY|TASK|HANDLER|RUNNING HANDLER|META)(?:\s*\[|\s*RECAP)/
const _ANSIBLE_RECAP_RE = /^PLAY RECAP/
const _ANSIBLE_FAIL_RE = /^(fatal|failed|unreachable|FAILED|ERROR|\[WARNING\]):/
const _ANSIBLE_LINT_RULE_RE = /^[a-z0-9][a-z0-9-]*(?:\[[a-z0-9_-]+\])?:\s+/
const _ANSIBLE_LINT_LEGACY_RE =
  /^\.?[^:\s]+\.ya?ml:\d+:\d+:\s+[a-z0-9][a-z0-9-]*(?:\[[a-z0-9_-]+\])?:/

export class AnsibleFilter extends ToolFilter {
  readonly name = 'ansible'
  override readonly binaries = new Set([
    'ansible',
    'ansible-playbook',
    'ansible-pull',
    'ansible-console',
    'ansible-galaxy',
    'ansible-lint',
  ])

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    const binaryName = pathName(argv[0] ?? '').toLowerCase()
    if (binaryName.includes('ansible-lint')) {
      return this._compressAnsibleLint(stdout, stderr)
    }
    if (binaryName.includes('ansible-galaxy')) {
      return this._compressAnsibleGalaxy(stdout, stderr)
    }
    return this._compressAnsiblePlaybook(stdout, stderr, argv)
  }

  private _compressAnsiblePlaybook(stdout: string, stderr: string, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const statusCounts = new Map<string, number>()
    let inRecap = false
    let inFailPayload = false
    let inSuccessPayload = false
    let braceDepth = 0
    let payloadElided = 0

    const flushStatus = (): void => {
      if (statusCounts.size === 0) return
      const parts: string[] = []
      for (const [label, n] of statusCounts.entries()) {
        if (n) parts.push(`${n} ${label}`)
      }
      if (parts.length) {
        let note = parts.join(', ')
        if (payloadElided) {
          note += `, ${payloadElided} verbose payload${payloadElided !== 1 ? 's' : ''} elided`
        }
        kept.push(`[token-goat: ${note}]`)
      }
      statusCounts.clear()
      payloadElided = 0
    }

    if (argv.includes('--check') || argv.includes('-C')) {
      kept.push('[token-goat: ansible-playbook --check (dry run — no actual changes)]')
    }

    for (const line of lines) {
      if (_ANSIBLE_RECAP_RE.test(line)) {
        flushStatus()
        inRecap = true
        inFailPayload = false
        inSuccessPayload = false
        kept.push(line)
        continue
      }
      if (inRecap) {
        kept.push(line)
        if (!line.trim()) inRecap = false
        continue
      }
      if (_ANSIBLE_FAIL_RE.test(line)) {
        flushStatus()
        inFailPayload = true
        inSuccessPayload = false
        kept.push(line)
        continue
      }
      if (inFailPayload) {
        if (!line.trim() || _ANSIBLE_HEADER_RE.test(line)) {
          inFailPayload = false
          if (!line.trim()) { kept.push(line); continue }
        } else {
          kept.push(line)
          continue
        }
      }
      if (inSuccessPayload) {
        if (
          _ANSIBLE_HEADER_RE.test(line) ||
          _ANSIBLE_FAIL_RE.test(line) ||
          _ANSIBLE_RECAP_RE.test(line)
        ) {
          inSuccessPayload = false
          braceDepth = 0
        } else {
          braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
          if (braceDepth <= 0) {
            inSuccessPayload = false
            braceDepth = 0
          }
          continue
        }
      }
      if (_ANSIBLE_HEADER_RE.test(line)) {
        flushStatus()
        inSuccessPayload = false
        kept.push(line)
        continue
      }
      if (_ANSIBLE_STATUS_RE.test(line)) {
        const label = line.split(':', 1)[0]!.trim()
        statusCounts.set(label, (statusCounts.get(label) ?? 0) + 1)
        if (line.trimEnd().endsWith('{')) {
          inSuccessPayload = true
          braceDepth = 1
          payloadElided++
        }
        continue
      }
      kept.push(line)
    }
    flushStatus()
    return this.finalize(kept)
  }

  private _compressAnsibleLint(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')

    const getRuleCode = (line: string): string | null => {
      if (_ANSIBLE_LINT_RULE_RE.test(line)) return line.split(':', 1)[0]!.trim()
      if (_ANSIBLE_LINT_LEGACY_RE.test(line)) {
        const parts = line.split(':', 5)
        if (parts.length >= 4) return parts[3]!.trim()
      }
      return null
    }

    const nonViolations: string[] = []
    const byRule = new Map<string, string[]>()
    const ruleOrder: string[] = []

    for (const line of lines) {
      const code = getRuleCode(line)
      if (code !== null) {
        if (!byRule.has(code)) {
          byRule.set(code, [])
          ruleOrder.push(code)
        }
        byRule.get(code)!.push(line)
      } else {
        nonViolations.push(line)
      }
    }

    if (byRule.size === 0) return this.finalize(lines)

    const kept: string[] = []
    for (const code of ruleOrder) {
      const ruleLines = byRule.get(code)!
      kept.push(...ruleLines.slice(0, 3))
      const extra = ruleLines.length - 3
      if (extra > 0) {
        kept.push(
          `[token-goat: ${extra} more occurrence${extra !== 1 ? 's' : ''} of ${code} elided]`,
        )
      }
    }
    kept.push(...nonViolations)
    return this.finalize(kept)
  }

  private _compressAnsibleGalaxy(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const nonEmpty = merged.split('\n').filter((ln) => ln.trim())
    if (nonEmpty.length > 10) {
      return headTailCompress(nonEmpty, 5, 5, 'galaxy lines')
    }
    return nonEmpty.join('\n')
  }
}

export const ansibleFilter = new AnsibleFilter()

// ---------------------------------------------------------------------------
// PulumiFilter
// ---------------------------------------------------------------------------

const _PULUMI_PROGRESS_RE =
  /^\s+[a-zA-Z0-9_./:-]+\s+\([^)]+\):\s+(?:creating|updating|deleting|replacing|refreshing|reading|configuring|waiting)\b/i
const _PULUMI_STILL_RE = /^\s+[a-zA-Z0-9_./:-]+\s+\([^)]+\):\s+still\s+/i
const _PULUMI_COMPLETE_RE =
  /^\s+[a-zA-Z0-9_./:-]+\s+\([^)]+\):\s+(?:created|updated|deleted|replaced|refreshed|read|configured)\b/i
const _PULUMI_SUMMARY_RE =
  /^\s*(?:Resources:|Duration:|Outputs:|View\s+Live|Permalink:|The resources in the stack have been deleted|Your update was rejected|No changes\.|Previewing\s+(?:update|destroy|refresh)|Updating\s+\(|Destroying\s+\(|Refreshing\s+\(|\d+\s+resource[s]?\s+(?:created|updated|deleted|changed|unchanged|same))/i
const _PULUMI_DIAG_RE = /^\s*(?:error:|warning:|diagnostic:)\s*/i
const _PULUMI_HEADER_RE =
  /^\s*(?:Updating\s+\(|Previewing\s+\(|Destroying\s+\(|Refreshing\s+\(|Stack\s+|pulumi\s+version\s+|warning:\s+A\s+new\s+version)/i

export class PulumiFilter extends ToolFilter {
  readonly name = 'pulumi'
  override readonly binaries = new Set(['pulumi'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let droppedProgress = 0
    let droppedStill = 0

    for (const line of lines) {
      if (
        _PULUMI_SUMMARY_RE.test(line) ||
        _PULUMI_DIAG_RE.test(line) ||
        _PULUMI_HEADER_RE.test(line) ||
        ERROR_SIGNAL_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (_PULUMI_COMPLETE_RE.test(line)) { kept.push(line); continue }
      if (_PULUMI_STILL_RE.test(line)) { droppedStill++; continue }
      if (_PULUMI_PROGRESS_RE.test(line)) { droppedProgress++; continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedProgress, `dropped ${droppedProgress} resource progress lines`)
    maybeNote(notes, droppedStill, `dropped ${droppedStill} 'still ...' heartbeat lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const pulumiFilter = new PulumiFilter()

// ---------------------------------------------------------------------------
// CdkFilter
// ---------------------------------------------------------------------------

const _CDK_ASSET_PROGRESS_RE =
  /^\s*(?:\[\s*\d+%\s*\]|\[asset\s|\[copy\s|\[zip\s|\bAsset\s+\S+\s+uploaded\b)/i
const _CDK_STACK_IN_PROGRESS_RE = /^\s+\w+_IN_PROGRESS\s+/
const _CDK_STACK_COMPLETE_RE =
  /^\s+(?:CREATE|UPDATE|DELETE|REPLACE|ROLLBACK)_COMPLETE\s+/
const _CDK_STACK_FAILED_RE = /^\s+\w+_FAILED\s+/
const _CDK_SUMMARY_RE =
  /^\s*(?:✅|❌|Stack\s+ARN:|Outputs:|CDK Toolkit|cdk\s+version\s+|[A-Za-z0-9_-]+:\s+(?:deploying|destroying|synthesizing|deploy|diff)\b|Successfully\s+deployed|Deployment\s+(?:complete|failed)|There\s+were\s+no\s+differences|Resources:|This deployment\s+will|Bundling\s+asset|Found\s+\d+\s+stack)/i
const _CDK_HOTSWAP_TIME_RE =
  /^\s*(?:✨\s+Synthesis time:|✨\s+Total time:|⏱\s+Total time:|⚠️.*hotswap|Hotswap\s+deployment)/i

export class CdkFilter extends ToolFilter {
  readonly name = 'cdk'
  override readonly binaries = new Set(['cdk'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let droppedAsset = 0
    let droppedInProgress = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || _CDK_STACK_FAILED_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_CDK_SUMMARY_RE.test(line) || _CDK_STACK_COMPLETE_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_CDK_HOTSWAP_TIME_RE.test(line)) { droppedInProgress++; continue }
      if (_CDK_ASSET_PROGRESS_RE.test(line)) { droppedAsset++; continue }
      if (_CDK_STACK_IN_PROGRESS_RE.test(line)) { droppedInProgress++; continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedAsset, `dropped ${droppedAsset} asset build/upload progress lines`)
    maybeNote(
      notes,
      droppedInProgress,
      `dropped ${droppedInProgress} IN_PROGRESS / timing lines`,
    )
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const cdkFilter = new CdkFilter()

// ---------------------------------------------------------------------------
// VaultFilter
// ---------------------------------------------------------------------------

const _VAULT_TABLE_DIVIDER_RE = /^\s*-{3,}\s+-{3,}\s*$/
const _VAULT_LEASE_META_RE =
  /^\s*(?:lease_(?:id|renewable|duration|accessor)|token_(?:policies|accessor|type|ttl|issue_time|expire_time|explicit_max_ttl|num_uses|renewable)|renewable|request_id)\s/i
const _VAULT_SUCCESS_RE = /^\s*Success!\s+/i
const _VAULT_HEADER_RE = /^\s*(?:WARNING|==>|Key\s+Value\s*$)/i
const _VAULT_AUTH_HEADER_RE =
  /^\s*(?:Token\s+information:|The\s+token\s+information|Complete\s+the\s+following|vault\s+(?:kv|secrets|auth|policy|lease|token)\s)/i
const _VAULT_LIST_ITEM_RE = /^\s{1,6}[a-zA-Z0-9_./-]+\/?$/
const _VAULT_LIST_HEADER_RE = /^\s*Keys\s*$/i
const _VAULT_LIST_COLLAPSE_THRESHOLD = 10

export class VaultFilter extends ToolFilter {
  readonly name = 'vault'
  override readonly binaries = new Set(['vault'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let metaCount = 0
    let dividerCount = 0

    const isListCmd =
      argv.length >= 2 &&
      argv[0]!.toLowerCase() === 'vault' &&
      ((argv[1]!.toLowerCase() === 'list') ||
        (argv.length >= 3 &&
          argv[1]!.toLowerCase() === 'kv' &&
          argv[2]!.toLowerCase() === 'list'))

    const listItems: string[] = []
    let inListBody = false

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (
        _VAULT_SUCCESS_RE.test(line) ||
        _VAULT_HEADER_RE.test(line) ||
        _VAULT_AUTH_HEADER_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (_VAULT_TABLE_DIVIDER_RE.test(line)) { dividerCount++; continue }
      if (_VAULT_LEASE_META_RE.test(line)) { metaCount++; continue }
      if (isListCmd) {
        if (_VAULT_LIST_HEADER_RE.test(line)) {
          kept.push(line)
          inListBody = true
          continue
        }
        if (inListBody && _VAULT_LIST_ITEM_RE.test(line)) {
          listItems.push(line)
          continue
        }
        inListBody = false
      }
      kept.push(line)
    }

    if (listItems.length) {
      if (listItems.length <= _VAULT_LIST_COLLAPSE_THRESHOLD) {
        kept.push(...listItems)
      } else {
        kept.push(...listItems.slice(0, 5))
        kept.push(
          `[token-goat: ${listItems.length - 5} more secret path(s) omitted; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
        )
      }
    }

    const notes: string[] = []
    maybeNote(notes, metaCount, `collapsed ${metaCount} Vault lease/token metadata line(s)`)
    maybeNote(notes, dividerCount, `dropped ${dividerCount} table divider line(s)`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

export const vaultFilter = new VaultFilter()

// ---------------------------------------------------------------------------
// PackerFilter
// ---------------------------------------------------------------------------

const _PACKER_WAITING_RE =
  /^\s*(?:==>|)\s*[\w.-]+:\s+(?:Waiting\s+for\s+(?:SSH|WinRM|instance|AMI|connection)|Polling\s+for\s+|Retrying\s+in\s+\d+)/i
const _PACKER_PROVISIONER_RE =
  /^\s*==>?\s*[\w.-]+:\s+(?:Running\s+provisioner:|Provisioning\s+with\s+|Executing\s+script:|Running\s+local\s+shell\s+script:|Uploading\s+\S+\s+=>)/i
const _PACKER_PAUSE_RE = /^\s*==>?\s*[\w.-]+:\s+Pausing\s+\d+\s+seconds/i
const _PACKER_NETWORK_NOISE_RE =
  /^\s*(?:==>?|)?\s*[\w.-]+:\s+\[c\]\s+(?:Received\s+disconnect|Net\s+tcp|SSH|channel\s+close)/i
const _PACKER_BUILD_STEP_RE =
  /^\s*==>?\s*[\w.-]+:\s+(?:Creating|Starting|Stopping|Destroying|Terminating|Registering|Deregistering|Tagging|Setting\s+up|Cleaning\s+up|Deleting|Adding)\s+/i
const _PACKER_ARTIFACT_RE = /^\s*(?:==>?\s*Builds\s+finished|-->\s*[\w.-]+:)/i
const _PACKER_BUILD_FINISHED_RE =
  /^\s*(?:==>?\s*[\w.-]+:\s+Build\s+'\S+'\s+finished|Build\s+'\S+'\s+finished)/i

export class PackerFilter extends ToolFilter {
  readonly name = 'packer'
  override readonly binaries = new Set(['packer'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let waitingCount = 0
    let provisionerCount = 0
    let noiseCount = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (_PACKER_ARTIFACT_RE.test(line) || _PACKER_BUILD_FINISHED_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_PACKER_BUILD_STEP_RE.test(line)) { kept.push(line); continue }
      if (_PACKER_WAITING_RE.test(line)) { waitingCount++; continue }
      if (_PACKER_PROVISIONER_RE.test(line)) { provisionerCount++; continue }
      if (_PACKER_NETWORK_NOISE_RE.test(line) || _PACKER_PAUSE_RE.test(line)) {
        noiseCount++
        continue
      }
      kept.push(line)
    }

    const out: string[] = []
    if (waitingCount) {
      out.push(
        `[token-goat: ${waitingCount} SSH/WinRM connection-wait poll line(s) collapsed; ` +
        `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      )
    }
    if (provisionerCount) {
      out.push(`[token-goat: collapsed ${provisionerCount} provisioner step announcement(s)]`)
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, noiseCount, `dropped ${noiseCount} network/heartbeat/pause noise line(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const packerFilter = new PackerFilter()

// ---------------------------------------------------------------------------
// NixFilter
// ---------------------------------------------------------------------------

const _NIX_BUILDING_RE =
  /^\s*(?:building\s+['"]?\/nix\/store\/|building\s+path\(s\):)/i
const _NIX_FETCHING_RE =
  /^\s*(?:fetching\s+path\s+['"]?\/nix\/store\/|downloading\s+['"]?https?:\/\/|copying\s+path\s+['"]?\/nix\/store\/|querying\s+['"]?https?:\/\/|substituting\s+['"]?\/nix\/store\/)/i
const _NIX_PATHS_SUMMARY_RE =
  /^\s*(?:these\s+\d+\s+paths\s+will\s+be|this\s+path\s+will\s+be|these\s+derivations\s+will\s+be)/i
const _NIX_PROGRESS_RE = /^\s*\[\d+\/\d+(?:\s+\(\d+(?:\.\d+)?\s+(?:MiB|KiB|GiB)\s+DL\))?\]/
const _NIX_FLAKE_UPDATE_RE =
  /^\s*(?:Updated\s+input\s+'|Resolving\s+flake\s+input\s+'|inputs\.\S+\.follows\s*=|warning:\s+Git\s+tree|trace:\s+|Added\s+input\s+'|Removed\s+input\s+'|Locked\s+input\s+'|writing\s+modified\s+lock\s+file|Updating\s+lock\s+file)/i
const _NIX_ERROR_RE =
  /^\s*(?:error:|note:|warning:|nix\s+(?:error|warning):)/i
const _NIX_SUCCESS_STORE_RE = /^\s*\/nix\/store\/\S+$/
const _NIX_SANDBOX_NOISE_RE =
  /^\s*(?:sandbox\s+path\s*:|sandboxed\s+build|setting\s+up\s+build\s+environment|running\s+phase\s+'[a-zA-Z]+'|source\s+\$stdenv\/setup)/i

export class NixFilter extends ToolFilter {
  readonly name = 'nix'
  override readonly binaries = new Set([
    'nix',
    'nix-build',
    'nix-shell',
    'nix-env',
    'nix-store',
    'nixos-rebuild',
  ])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let fetchCount = 0
    let buildCount = 0
    let flakeUpdateCount = 0
    let droppedNoise = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || _NIX_ERROR_RE.test(line)) { kept.push(line); continue }
      if (_NIX_SUCCESS_STORE_RE.test(line)) { kept.push(line); continue }
      if (_NIX_PATHS_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (_NIX_PROGRESS_RE.test(line)) { droppedNoise++; continue }
      if (_NIX_FETCHING_RE.test(line)) { fetchCount++; continue }
      if (_NIX_BUILDING_RE.test(line)) { buildCount++; continue }
      if (_NIX_FLAKE_UPDATE_RE.test(line)) { flakeUpdateCount++; continue }
      if (_NIX_SANDBOX_NOISE_RE.test(line)) { droppedNoise++; continue }
      kept.push(line)
    }

    const out: string[] = []
    if (fetchCount) {
      out.push(
        `[token-goat: fetched/substituted ${fetchCount} store path(s) from binary cache; ` +
        `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      )
    }
    if (buildCount) {
      out.push(`[token-goat: built ${buildCount} Nix derivation(s)]`)
    }
    if (flakeUpdateCount) {
      out.push(`[token-goat: collapsed ${flakeUpdateCount} flake lock update line(s)]`)
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, droppedNoise, `dropped ${droppedNoise} Nix scheduler/sandbox noise line(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const nixFilter = new NixFilter()

// ---------------------------------------------------------------------------
// WranglerFilter
// ---------------------------------------------------------------------------

const _WRANGLER_ASSET_UPLOAD_RE =
  /^\s*(?:\+\s+\/\S+\s+\(\d+\s+bytes?\)|Uploading\s+asset\s+\/\S+|Uploading\s+\d+\s+assets?\s+to\s+\S+|No\s+cached\s+assets\s+found\.\s+Uploading\s+all\s+\d+|Diff\s+result:\s+\d+\s+added|↑\s+\S+\s+\(\d+\s+bytes?\))/i
const _WRANGLER_ASSET_SKIP_RE =
  /^\s*(?:Skipping\s+upload\s+of\s+asset\s+|\d+\s+assets?\s+(?:already\s+(?:up\s+to\s+date|uploaded)|unchanged)|All\s+\d+\s+assets?\s+are\s+already\s+up\s+to\s+date)/i
const _WRANGLER_BUILD_STEP_RE =
  /^\s*(?:Building\.\.\.|Bundling\s+with\s+esbuild|Checking\s+for\s+common\s+issues|Running\s+custom\s+build|Processing\s+dependencies|Minif(?:ying|ied)\s+|Wrote\s+script\s+to\s+\S+\.js\b)/i
const _WRANGLER_SUMMARY_RE =
  /^\s*(?:Published\s+\S+\s+\(|Deployed\s+\S+|Uploaded\s+\S+\s+\(|Total\s+Upload:|Current\s+Deployment\s+ID:|✨\s+Built\s+successfully|Your\s+worker\s+has\s+access|\d+\s+requests?\s+were\s+served|View\s+your\s+(?:worker|pages\s+site)\s+at\b|Success!?\s*$|Deployment\s+(?:complete|ready)|pages\.dev|workers\.dev)/i
const _WRANGLER_DEV_NOISE_RE =
  /^\s*\[(?:wrangler|mf):\w+\]\s+(?:Reloading\b|Worker\s+reloaded!|GET\s+|POST\s+|PUT\s+|PATCH\s+|DELETE\s+|OPTIONS\s+|HEAD\s+)/i
const _WRANGLER_BULK_PROGRESS_RE =
  /^\s*(?:Inserting\s+\d+\s+rows|Processing\s+chunk\s+\d+\/\d+|Writing\s+\d+\s+key[s/])/i

export class WranglerFilter extends ToolFilter {
  readonly name = 'wrangler'
  override readonly binaries = new Set(['wrangler', 'wrangler2'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let uploadCount = 0
    let skipCount = 0
    let droppedBuild = 0
    let droppedDev = 0
    let bulkCount = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || _WRANGLER_SUMMARY_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_WRANGLER_ASSET_UPLOAD_RE.test(line)) { uploadCount++; continue }
      if (_WRANGLER_ASSET_SKIP_RE.test(line)) { skipCount++; continue }
      if (_WRANGLER_BUILD_STEP_RE.test(line)) { droppedBuild++; continue }
      if (_WRANGLER_DEV_NOISE_RE.test(line)) { droppedDev++; continue }
      if (_WRANGLER_BULK_PROGRESS_RE.test(line)) { bulkCount++; continue }
      kept.push(line)
    }

    const out: string[] = []
    if (uploadCount) {
      out.push(
        `[token-goat: ${uploadCount} asset upload line(s) collapsed; ` +
        `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      )
    }
    if (skipCount) {
      out.push(`[token-goat: ${skipCount} asset-skip line(s) collapsed]`)
    }
    if (bulkCount) {
      out.push(`[token-goat: ${bulkCount} bulk-operation progress line(s) collapsed]`)
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, droppedBuild, `dropped ${droppedBuild} build-step noise line(s)`)
    maybeNote(notes, droppedDev, `dropped ${droppedDev} dev-mode noise line(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const wranglerFilter = new WranglerFilter()

// ---------------------------------------------------------------------------
// HardhatFilter
// ---------------------------------------------------------------------------

const _HARDHAT_COMPILING_RE =
  /^\s*Compiling\s+\d+\s+(?:file[s]?\s+with|Solidity\s+file[s]?)/i
const _HARDHAT_SOLC_FINISHED_RE = /^\s*Solc\s+\S+\s+finished\s+in\s+\d/i
const _HARDHAT_TX_NOISE_RE =
  /^\s*(?:deployer:|Deployment\s+transaction:|Gas\s+used:\s+\d|Transaction\s+hash:\s+0x|Block\s+(?:number|hash):|Nonce:\s+\d|Value:\s+\d|From:\s+0x|To:\s+0x|Contract\s+address:\s+0x\w{40}\s*$)/i
const _HARDHAT_PASS_TEST_RE = /^\s+(?:✓|✔|√)\s+/
const _HARDHAT_TEST_SUMMARY_RE = /^\s*\d+\s+(?:passing|failing|pending)\b/i
const _HARDHAT_FAILURE_RE =
  /^\s*(?:\d+\s+failing\b|AssertionError:|Error:|expected\s+)/i
const _HARDHAT_COMPILE_DONE_RE =
  /^\s*(?:Compilation\s+finished\s+successfully|Nothing\s+to\s+compile|Compiled\s+\d+\s+Solidity\s+file|No\s+need\s+to\s+generate\s+any\s+compiler)/i
const _HARDHAT_WARN_RE =
  /^\s*(?:HardhatError:|HardhatWarning:|Warning:|ProviderError:|Duplicate\s+definition\s+of\b)/i
const _HARDHAT_DEPLOY_HEADER_RE =
  /^\s*(?:Deploying\s+\w|\w[\w\s]*\s+deployed\s+to:\s+0x|Running\s+\S+\.(?:ts|js)\b|Network:\s+\w|Deploying\s+contracts\s+with\s+the\s+account)/i

export class HardhatFilter extends ToolFilter {
  readonly name = 'hardhat'
  override readonly binaries = new Set(['hardhat'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let compilingCount = 0
    let solcTimingCount = 0
    let passCount = 0
    let txNoiseCount = 0

    for (const line of lines) {
      if (
        ERROR_SIGNAL_RE.test(line) ||
        _HARDHAT_FAILURE_RE.test(line) ||
        _HARDHAT_WARN_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (
        _HARDHAT_COMPILE_DONE_RE.test(line) ||
        _HARDHAT_DEPLOY_HEADER_RE.test(line) ||
        _HARDHAT_TEST_SUMMARY_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (_HARDHAT_COMPILING_RE.test(line)) { compilingCount++; continue }
      if (_HARDHAT_SOLC_FINISHED_RE.test(line)) { solcTimingCount++; continue }
      if (_HARDHAT_PASS_TEST_RE.test(line)) { passCount++; continue }
      if (_HARDHAT_TX_NOISE_RE.test(line)) { txNoiseCount++; continue }
      kept.push(line)
    }

    const out: string[] = []
    if (compilingCount) {
      out.push(
        `[token-goat: collapsed ${compilingCount} Solidity compilation step line(s); ` +
        `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      )
    }
    if (solcTimingCount) {
      out.push(`[token-goat: collapsed ${solcTimingCount} Solc per-version timing line(s)]`)
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, passCount, `collapsed ${passCount} passing test line(s)`)
    maybeNote(notes, txNoiseCount, `dropped ${txNoiseCount} transaction receipt noise line(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const hardhatFilter = new HardhatFilter()

// ---------------------------------------------------------------------------
// ServerlessFilter
// ---------------------------------------------------------------------------

const _SLS_STEP_PROGRESS_RE =
  /^\s*Serverless:\s+(?:Packaging\s+service|Excluding\s+development\s+dependencies|Creating\s+Stack\.\.\.|Checking\s+Stack\s+create\s+progress|Stack\s+create\s+finished|Uploading\s+CloudFormation\s+file\s+to\s+S3|Uploading\s+artifacts|Uploading\s+service\s+\S+\.zip\s+file\s+to\s+S3|Validating\s+template|Updating\s+Stack\.\.\.|Checking\s+Stack\s+update\s+progress|Stack\s+update\s+finished|Executing\s+Changeset|Removing\s+old\s+service\s+artifacts\s+from\s+S3)/i
const _SLS_CF_IN_PROGRESS_RE =
  /^\s*(?:AWS::|ServerlessDeployment).*_IN_PROGRESS\s*$|^\s+\w+_IN_PROGRESS\s+(?:AWS::|ServerlessDeployment)/
const _SLS_CF_COMPLETE_RE =
  /^\s*(?:AWS::|ServerlessDeployment).*_COMPLETE\s*$|^\s+(?:CREATE|UPDATE|DELETE|REPLACE|ROLLBACK)_COMPLETE\s+/
const _SLS_CF_FAILED_RE = /\w+_FAILED\s+/
const _SLS_SERVICE_INFO_RE =
  /^\s*(?:Service\s+Information|service:\s+\S|stage:\s+\S|region:\s+\S|stack:\s+\S|resources:|api\s+keys:|endpoints:|functions:|layers:|ANY\s+-\s+https:\/\/|GET\s+-\s+https:\/\/|POST\s+-\s+https:\/\/|PUT\s+-\s+https:\/\/|DELETE\s+-\s+https:\/\/|Serverless:\s+Stack\s+Tags|Serverless:\s+Invoke\s+|Serverless:\s+(?:Done!|WARNING:|ERROR:))/i
const _SLS_SUMMARY_RE =
  /^\s*(?:Service\s+deployed\s+to\s+stack\s+|✔\s+Service\s+deployed|Serverless:\s+Run\s+the\s+'serverless|Deployed\s+functions:|Stack\s+Outputs\b)/i
const _SLS_DOT_PROGRESS_RE = /^\s*\.+\s*$/
const _SLS_TICK_RE = /^\s*Serverless:\s+\.+\s*$/

export class ServerlessFilter extends ToolFilter {
  readonly name = 'serverless'
  override readonly binaries = new Set(['serverless', 'sls'])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let stepCount = 0
    let inProgressCount = 0
    let dotCount = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || _SLS_CF_FAILED_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (
        _SLS_SERVICE_INFO_RE.test(line) ||
        _SLS_SUMMARY_RE.test(line) ||
        _SLS_CF_COMPLETE_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (_SLS_STEP_PROGRESS_RE.test(line)) { stepCount++; continue }
      if (_SLS_CF_IN_PROGRESS_RE.test(line)) { inProgressCount++; continue }
      if (_SLS_DOT_PROGRESS_RE.test(line) || _SLS_TICK_RE.test(line)) { dotCount++; continue }
      kept.push(line)
    }

    const out: string[] = []
    if (stepCount) {
      out.push(
        `[token-goat: collapsed ${stepCount} Serverless deploy step line(s); ` +
        `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      )
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, inProgressCount, `dropped ${inProgressCount} CF _IN_PROGRESS event line(s)`)
    maybeNote(notes, dotCount, `dropped ${dotCount} polling dot line(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const serverlessFilter = new ServerlessFilter()

// ---------------------------------------------------------------------------
// FlyFilter
// ---------------------------------------------------------------------------

const _FLY_STEP_HEADER_RE =
  /^==>\s+(?:Releasing|Building|Creating|Validating|Updating|Destroying|Monitoring)/i
const _FLY_MACHINE_WAIT_RE =
  /^(?:-->?\s+Waiting\s+for|\s*Machine\s+[0-9a-zA-Z]+\s+is\s+now\s+in|\s*\[[\s\d]+\]\s+Machine\s+[0-9a-zA-Z]+)/i
const _FLY_BUILD_STEP_RE =
  /^\s*(?:Sending\s+build\s+context|Step\s+\d+\/\d+\s*:|--->\s*\w|Successfully\s+built\s+[0-9a-f]{8,}|Successfully\s+tagged\s+\S+)/i
const _FLY_LAYER_PROGRESS_RE =
  /^\s*#\d+\s+(?:CACHED|DONE|sha256:|transferring)|^\s*CACHED\s+\[/i
const _FLY_SUMMARY_RE =
  /(?:Watch\s+your\s+deployment|Visit\s+your\s+newly\s+deployed|Deployed\s+\S+\s+v\d|v\d+\s+deployed\s+successfully|Release\s+command\s+succeeded|Monitoring\s+deployment\s+\(Ctrl-C\))/i
const _FLY_POLLING_RE =
  /^\s*(?:Checking\s+DNS\s+configuration|Waiting\s+for\s+IPv[46]|The\s+above\s+IP\s+address\s+may\s+need)/i

export class FlyFilter extends ToolFilter {
  readonly name = 'fly'
  override readonly binaries = new Set(['fly', 'flyctl'])
  override readonly subcommands = new Set([
    'deploy',
    'status',
    'apps',
    'machines',
    'logs',
    'scale',
    'secrets',
    'volumes',
    'regions',
    'releases',
    'info',
    'launch',
    'destroy',
    'resume',
    'suspend',
    'open',
  ])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let buildStepCount = 0
    let machineWaitCount = 0
    let droppedNoise = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (_FLY_SUMMARY_RE.test(line) || _FLY_STEP_HEADER_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_FLY_BUILD_STEP_RE.test(line) || _FLY_LAYER_PROGRESS_RE.test(line)) {
        buildStepCount++
        continue
      }
      if (_FLY_MACHINE_WAIT_RE.test(line)) { machineWaitCount++; continue }
      if (_FLY_POLLING_RE.test(line)) { droppedNoise++; continue }
      kept.push(line)
    }

    const out: string[] = []
    if (buildStepCount) {
      out.push(
        `[token-goat: ${buildStepCount} Docker build step line(s) collapsed; ` +
        `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      )
    }
    if (machineWaitCount) {
      out.push(`[token-goat: ${machineWaitCount} per-machine wait line(s) collapsed]`)
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, droppedNoise, `dropped ${droppedNoise} DNS/polling noise line(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const flyFilter = new FlyFilter()

// ---------------------------------------------------------------------------
// ForgeFilter
// ---------------------------------------------------------------------------

const _FORGE_COMPILING_RE =
  /^\s*Compiling\s+\d+\s+(?:file[s]?\s+with|Solidity\s+file[s]?)|^\s*Solc\s+\S+\s+finished\s+in\s+\d/i
const _FORGE_PASS_TEST_RE = /^\s*\[(?:PASS|OK)\]\s+\S+\s+\(gas:/i
const _FORGE_SUITE_HEADER_RE = /^\s*Running\s+\d+\s+test[s]?\s+for\s+\S+/i
const _FORGE_SUMMARY_RE =
  /^\s*(?:Test\s+result|Suite\s+result|Overall\s+result)\s*:/i
const _FORGE_COMPILE_DONE_RE =
  /^\s*(?:Compiler\s+run\s+successful|Nothing\s+to\s+compile|Compiled\s+\d+\s+Solidity\s+file[s]?)/i
const _FORGE_FAILURE_RE = /^\s*\[(?:FAIL|ERROR)\]/i
const _FORGE_GAS_TABLE_RE = /^\s*\|[-\s|]+\|\s*$/
const _FORGE_FOOTER_RE = /^\s*Ran\s+\d+\s+test\s+suite[s]?\s+in\s+\d/i

export class ForgeFilter extends ToolFilter {
  readonly name = 'forge'
  override readonly binaries = new Set(['forge'])
  override readonly subcommands = new Set([
    'build',
    'test',
    'script',
    'verify-contract',
    'flatten',
    'inspect',
    'coverage',
    'snapshot',
    'clean',
    'install',
    'update',
    'remove',
    'init',
    'compile',
  ])
  override readonly errorPassthrough = true

  protected override compressBody(
    stdout: string,
    stderr: string,
    _exitCode: number,
    _argv: string[],
  ): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let compilingCount = 0
    let passCount = 0
    let droppedGasSep = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line) || _FORGE_FAILURE_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (
        _FORGE_COMPILE_DONE_RE.test(line) ||
        _FORGE_SUITE_HEADER_RE.test(line) ||
        _FORGE_SUMMARY_RE.test(line) ||
        _FORGE_FOOTER_RE.test(line)
      ) {
        kept.push(line)
        continue
      }
      if (_FORGE_COMPILING_RE.test(line)) { compilingCount++; continue }
      if (_FORGE_PASS_TEST_RE.test(line)) { passCount++; continue }
      if (_FORGE_GAS_TABLE_RE.test(line)) { droppedGasSep++; continue }
      kept.push(line)
    }

    const out: string[] = []
    if (compilingCount) {
      out.push(
        `[token-goat: ${compilingCount} Solidity compilation step line(s) collapsed; ` +
        `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      )
    }
    out.push(...kept)

    const notes: string[] = []
    maybeNote(notes, passCount, `collapsed ${passCount} passing test line(s)`)
    maybeNote(notes, droppedGasSep, `dropped ${droppedGasSep} gas-report table separator row(s)`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

export const forgeFilter = new ForgeFilter()

// ---------------------------------------------------------------------------
// CLOUD_FILTERS — ordered: AwsCliFilter before AwsFilter (both match aws/aws2; AwsCliFilter is the more specific handler and must win). All others are single-binary so relative order only matters for readability.
// ---------------------------------------------------------------------------

export const CLOUD_FILTERS: ToolFilter[] = [
  // terraform/tofu/terragrunt — must come before any go-related fallback
  terraformFilter,
  // aws — specific CFN/S3 handler first, simple JSON fallback second
  awsCliFilter,
  awsFilter,
  // single-binary cloud CLIs
  gcloudFilter,
  azureCliFilter,
  ansibleFilter,
  pulumiFilter,
  cdkFilter,
  vaultFilter,
  packerFilter,
  nixFilter,
  wranglerFilter,
  hardhatFilter,
  serverlessFilter,
  flyFilter,
  forgeFilter,
]
