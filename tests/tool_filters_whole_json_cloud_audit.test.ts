// Regression guard: aws, az and `npm audit --json` print one indented JSON document, and the input clip cut any line past INPUT_MAX_LINE_CHARS, so a wide string value full of escaped quotes (a policy document, JSON carried inside a string) was cut inside its escape sequences, which left the document unparseable and the array truncation never ran.
// Provenance: FORMAT-DERIVED. aws-cli's JSONFormatter dumps with indent=4 (awscli/formatter.py), az's knack JSON output uses indent=2 and `-o jsonc` colours it with pygments' TerminalFormatter (knack/output.py format_json_color), and npm's audit JSON reporter is `JSON.stringify(data, null, indent)` (npm-audit-report lib/reporters/json.js), chosen when `--json` is set (npm lib/commands/audit.js); the `vulnerabilities` keys and fields follow that reporter's v2 shape.
import { describe, expect, it, vi } from 'vitest'

import { AwsCliFilter, AzureCliFilter } from '../src/tool_filters/cloud_providers.js'
import { filterByName, selectFilter } from '../src/tool_filters/dispatch.js'
import { clipWideLines, INPUT_MAX_LINE_CHARS, TABLE_ROW_ANOMALY_RE } from '../src/tool_filters/helpers.js'

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g
const WIDE = 'x'.repeat(INPUT_MAX_LINE_CHARS + 500)
// Every character of this value serialises as an escaped quote, so the clip cuts inside an escape sequence; whether that breaks the parse depends on where the escapes start and end on the line, which is why each test first asserts the clipped document fails to parse.
const QUOTED = '"'.repeat(INPUT_MAX_LINE_CHARS + 500)

function parsesAfterClip(doc: string): boolean {
  try {
    JSON.parse(clipWideLines(doc))
    return true
  } catch {
    return false
  }
}

function items(n: number): Array<Record<string, string>> {
  return Array.from({ length: n }, (_, i) => ({ Id: `item-${i}`, Message: i === 1 ? QUOTED : `short ${i}` }))
}

function maxLineLength(text: string): number {
  return Math.max(...text.split('\n').map((l) => l.length))
}

describe('aws and az keep a JSON document with a wide string value parseable', () => {
  it('aws truncates an indent-4 array that carries one value wider than the clip', () => {
    const stdout = JSON.stringify({ Reservations: items(30) }, null, 4) + '\n'
    expect(parsesAfterClip(stdout)).toBe(false)
    const out = new AwsCliFilter().apply(stdout, '', 0, ['aws', 'ec2', 'describe-instances'])
    expect(out.text).toContain('__token_goat__')
    expect(out.text).toContain('30 items (showing first')
    expect(out.text).not.toContain('item-29')
    expect(maxLineLength(out.text)).toBeLessThanOrEqual(INPUT_MAX_LINE_CHARS)
  })

  it('az truncates an indent-2 array that carries one value wider than the clip', () => {
    const stdout = JSON.stringify(items(30), null, 2) + '\n'
    expect(parsesAfterClip(stdout)).toBe(false)
    const out = new AzureCliFilter().apply(stdout, '', 0, ['az', 'vm', 'list'])
    expect(out.text).toContain('__token_goat__')
    expect(out.text).toContain('30 items (showing first 3)')
    expect(out.text).not.toContain('item-29')
    expect(maxLineLength(out.text)).toBeLessThanOrEqual(INPUT_MAX_LINE_CHARS)
  })

  it('aws text output that is not JSON still has its wide lines clipped', () => {
    const stdout = ['RESERVATIONS\t123', `INSTANCES\t${WIDE}`, 'TAGS\tName\tweb'].join('\n') + '\n'
    const out = new AwsCliFilter().apply(stdout, '', 0, ['aws', 'ec2', 'describe-instances', '--output', 'text'])
    expect(out.notes).toContain(`clipped line(s) wider than ${INPUT_MAX_LINE_CHARS} chars`)
  })

  it('az text that is not JSON still has its wide lines clipped', () => {
    const stdout = ['Name    State', `vm1     ${WIDE}`].join('\n') + '\n'
    const out = new AzureCliFilter().apply(stdout, '', 0, ['az', 'vm', 'list', '-o', 'table'])
    expect(out.notes).toContain(`clipped line(s) wider than ${INPUT_MAX_LINE_CHARS} chars`)
  })

  it('`--filter aws` picks the plain aws filter, which truncates the same wide document', () => {
    const stdout = JSON.stringify({ Reservations: items(30) }, null, 4) + '\n'
    const filter = filterByName('aws')
    expect(filter?.name).toBe('aws')
    const out = filter!.apply(stdout, '', 0, ['aws', 'ec2', 'describe-instances'])
    expect(out.text).toContain('__token_goat__')
    expect(out.text).not.toContain('item-29')
    expect(maxLineLength(out.text)).toBeLessThanOrEqual(INPUT_MAX_LINE_CHARS)
  })

  it('`--filter aws` still clips a wide line in table output', () => {
    const stdout = ['|  DescribeInstances  |', `|  ${WIDE}  |`, '|  i-123  |'].join('\n') + '\n'
    const out = filterByName('aws')!.apply(stdout, '', 0, ['aws', 'ec2', 'describe-instances', '--output', 'table'])
    expect(maxLineLength(out.text)).toBeLessThanOrEqual(INPUT_MAX_LINE_CHARS)
  })

  it('az truncates a colored jsonc array that carries one value wider than the clip', () => {
    // knack's format_json_color runs the indent-2 document through pygments' TerminalFormatter, which wraps each string token in an SGR colour and a `39;49;00` reset.
    const color = (s: string): string => s.replace(/"(?:[^"\\]|\\.)*"/g, (tok) => `\u001b[94m${tok}\u001b[39;49;00m`)
    const stdout = color(JSON.stringify(items(30), null, 2)) + '\n'
    expect(parsesAfterClip(stdout.replace(ANSI_RE, ''))).toBe(false)
    const out = new AzureCliFilter().apply(stdout, '', 0, ['az', 'vm', 'list', '-o', 'jsonc'])
    expect(out.text).toContain('30 items (showing first 3)')
    expect(out.text).not.toContain('item-29')
    expect(maxLineLength(out.text)).toBeLessThanOrEqual(INPUT_MAX_LINE_CHARS)
  })

  it('the JSON documents skip the input clip', () => {
    const out = new AzureCliFilter().apply(JSON.stringify(items(30), null, 2), '', 0, ['az', 'vm', 'list'])
    expect(out.notes).not.toContain(`clipped line(s) wider than ${INPUT_MAX_LINE_CHARS} chars`)
  })
})

// The input clip exists so per-line regexes only see short lines (`_AZ_PROGRESS_JSON_RE`'s `[^}]*"…"[^}]*\}` backtracks quadratically on a wide one); a document exempted from it must be clipped before those regexes run. Provenance: HAND-DERIVED, objects (not arrays) so the JSON truncation declines and the line passes run.
describe('a whole JSON document is clipped before the per-line regexes see it', () => {
  function widestLineTested(run: () => void, sees: (re: RegExp) => boolean): number {
    let widest = 0
    const original = RegExp.prototype.test
    const spy = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, s: string) {
      if (sees(this)) widest = Math.max(widest, String(s).length)
      return original.call(this, s)
    })
    try {
      run()
    } finally {
      spy.mockRestore()
    }
    return widest
  }

  // More than the 25 rows the table pass keeps, so it reaches its anomaly regex, and a `|` in a value so the table branch is taken.
  const tableDoc = JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Key${i}`, i === 1 ? `a|b ${WIDE}` : `v ${i}`])), null, 4) + '\n'

  it.each([
    ['aws-cli', () => new AwsCliFilter()],
    ['aws', () => filterByName('aws')!],
  ])('%s table pass', (_name, make) => {
    const filter = make()
    const widest = widestLineTested(() => filter.apply(tableDoc, '', 0, ['aws', 'iam', 'get-policy-version']), (re) => re === TABLE_ROW_ANOMALY_RE)
    expect(widest, 'the anomaly regex never ran; this case proves nothing').toBeGreaterThan(0)
    expect(widest).toBeLessThanOrEqual(INPUT_MAX_LINE_CHARS + 64)
  })

  it('az line pass', () => {
    const doc = JSON.stringify({ id: '/subscriptions/x', properties: { message: `{ ${WIDE}` } }, null, 2) + '\n'
    const widest = widestLineTested(() => new AzureCliFilter().apply(doc, '', 0, ['az', 'resource', 'show']), (re) => re.source.includes('percentComplete'))
    expect(widest, 'the progress regex never ran; this case proves nothing').toBeGreaterThan(0)
    expect(widest).toBeLessThanOrEqual(INPUT_MAX_LINE_CHARS + 64)
  })
})

describe('npm audit --json keeps its document parseable', () => {
  function auditDoc(): string {
    const vulnerabilities: Record<string, unknown> = {}
    for (let i = 0; i < 14; i++) {
      vulnerabilities[`pkg-${i}`] = {
        name: `pkg-${i}`,
        severity: i < 2 ? 'high' : 'low',
        isDirect: false,
        via: [{ source: 1000 + i, name: `pkg-${i}`, title: i === 0 ? `x${QUOTED}` : `advisory ${i}`, url: `https://github.com/advisories/GHSA-${i}`, severity: i < 2 ? 'high' : 'low', range: '<1.0.0' }],
        effects: [],
        range: '<1.0.0',
        nodes: [`node_modules/pkg-${i}`],
        fixAvailable: true,
      }
    }
    return JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 12, moderate: 0, high: 2, critical: 0, total: 14 } } }, null, 2) + '\n'
  }

  it('collapses the vulnerability map when one advisory string is wider than the clip, and keeps stderr', () => {
    const argv = ['npm', 'audit', '--json']
    expect(parsesAfterClip(auditDoc())).toBe(false)
    const filter = selectFilter(argv)
    expect(filter).not.toBeNull()
    const out = filter!.apply(auditDoc(), 'npm warn config production Use `--omit=dev` instead.\n', 1, argv)
    expect(out.text).toContain('__collapsed__')
    expect(out.text).toContain('pkg-0')
    expect(out.text).not.toContain('"pkg-13"')
    expect(out.text).toContain('npm warn config production')
  })
})

describe('clipWideLines', () => {
  it('is idempotent on a line it already clipped', () => {
    const once = clipWideLines(`a\n${WIDE}\nb`)
    expect(clipWideLines(once)).toBe(once)
  })
})

// Provenance: FORMAT-DERIVED. EC2 DescribeInstances returns `Reservations[]`, each holding the `Instances[]` of one launch request (AWS EC2 API reference, DescribeInstances response elements: reservationSet > instancesSet), so an Auto Scaling group launched in one request is one reservation carrying every instance; aws-cli prints it with indent=4 (awscli/formatter.py).
describe('aws shortens an array nested inside another', () => {
  const doc = JSON.stringify({ Reservations: [{ ReservationId: 'r-0abc', Instances: Array.from({ length: 300 }, (_, i) => ({ InstanceId: `i-${String(i).padStart(4, '0')}`, State: { Name: 'running' } })) }] }, null, 4) + '\n'

  it.each([
    ['aws-cli', () => new AwsCliFilter()],
    ['aws', () => filterByName('aws')!],
  ])('%s keeps the reservation and the first instances of a 300-instance launch', (_name, make) => {
    const out = make().apply(doc, '', 0, ['aws', 'ec2', 'describe-instances'])
    expect(out.text).toContain('r-0abc')
    expect(out.text).toContain('i-0000')
    expect(out.text).toContain('300 items (showing first')
    expect(out.text).not.toContain('i-0299')
  })

  it('leaves a nested array at or under the threshold whole', () => {
    const small = JSON.stringify({ Reservations: [{ Instances: Array.from({ length: 5 }, (_, i) => ({ InstanceId: `i-${i}` })) }] }, null, 4)
    const out = new AwsCliFilter().apply(small, '', 0, ['aws', 'ec2', 'describe-instances'])
    expect(out.text).toContain('i-4')
    expect(out.text).not.toContain('__token_goat__')
  })
})
