import { describe, it, expect } from 'vitest'
import { truncateTableRows } from '../src/tool_filters/helpers.js'
import { filterByName } from '../src/tool_filters/index.js'

/**
 * Four caps that chose what to keep by position, on outputs where position says nothing about
 * where the answer is. Companion to `filter_input_cap_keeps_ends.test.ts`, which covers the
 * pipeline-wide caps; these are the per-family ones.
 *
 * Fixture provenance: FORMAT-DERIVED for the table rows, whose columns and status vocabulary are
 * read off the kubectl and AWS CLI output formats those two call sites parse (`kubectl get pods`
 * wide output: NAME READY STATUS RESTARTS AGE; CloudFormation stack states such as
 * `ROLLBACK_COMPLETE`). HAND-DERIVED for the diff and match-group cases, whose shapes are computed
 * from the input independently of the code under test.
 *
 * No case asserts a ratio or a saved-byte floor. Every one of these truncations gets a *better*
 * ratio by dropping more, so a ratio assertion would pass hardest on the failure. Each case names
 * the content that must survive instead.
 */
describe('per-family truncation keeps the part that carries the answer', () => {
  it('keeps a not-ready table row that sorts past the row budget', () => {
    // A resource table is ordered by whatever the API returned, so the unhealthy row lands wherever it lands. Here it is row 40 of 60 against a 10-row budget, which a head trim drops every time.
    const header = 'NAME                        READY   STATUS      RESTARTS   AGE'
    const rows = Array.from({ length: 60 }, (_, i) => `web-${String(i).padStart(3, '0')}-abcde        1/1     Running     0          4d`)
    rows[39] = 'payments-7f9c4-xk2mq        0/1     CrashLoopBackOff   14         6m'
    const out = truncateTableRows([header, ...rows].join('\n'), 10, 'use -l to select')

    expect(out).toContain('CrashLoopBackOff')
    expect(out).toContain('payments-7f9c4-xk2mq')
    // The header is what makes the surviving rows readable at all.
    expect(out).toContain('NAME')
    // The reader is told the selection was not positional, or the kept row looks like an accident of ordering.
    expect(out).toContain('kept for a not-ready status')
    // The budget is still honoured: header plus at most 10 rows plus the note.
    expect(out.split('\n').length).toBeLessThanOrEqual(12)
    // Rows come back in table order, not with the anomaly hoisted to the front.
    const lines = out.split('\n')
    expect(lines.indexOf('NAME                        READY   STATUS      RESTARTS   AGE')).toBe(0)
    const keptWeb = lines.filter((l) => l.startsWith('web-')).map((l) => l.slice(4, 7))
    expect([...keptWeb]).toEqual([...keptWeb].sort())
  })

  it('says nothing about anomalies when every row is healthy, so the note does not cry wolf', () => {
    const header = 'NAME   READY   STATUS    RESTARTS   AGE'
    const rows = Array.from({ length: 40 }, (_, i) => `web-${i}   1/1     Running   0          4d`)
    const out = truncateTableRows([header, ...rows].join('\n'), 10, 'use -l to select')
    expect(out).not.toContain('kept for a not-ready status')
    expect(out).toContain('30 more rows')
  })

  it('does not promote a healthy row whose name merely contains an error word', () => {
    // ERROR_SIGNAL_RE matches `error` as a substring, so a resource named `error-handler` would have been hoisted above genuinely broken ones. The status vocabulary is word-bounded to keep names out of it.
    const header = 'NAME   READY   STATUS    RESTARTS   AGE'
    const rows = Array.from({ length: 40 }, (_, i) => `svc-${i}   1/1     Running   0          4d`)
    rows[0] = 'error-handler-api   1/1     Running   0          4d'
    rows[35] = 'billing-worker      0/1     Evicted   0          2m'
    const out = truncateTableRows([header, ...rows].join('\n'), 5, 'use -l to select')
    expect(out).toContain('billing-worker')
    expect(out).toContain('1 row(s) kept for a not-ready status')
  })

  it('keeps the end of a kubectl diff, not only its first resource', () => {
    // `kubectl diff` walks the manifests in the order given, so the changed resource is as likely to be last as first. The tail used to be hard-coded to zero.
    const filter = filterByName('kubectl')
    expect(filter).not.toBeNull()
    const body = [
      'diff -u -N /tmp/LIVE/v1.ConfigMap.default.first /tmp/MERGED/v1.ConfigMap.default.first',
      ...Array.from({ length: 200 }, (_, i) => `   unchanged config line ${i}`),
      'diff -u -N /tmp/LIVE/v1.Secret.default.LAST-RESOURCE /tmp/MERGED/v1.Secret.default.LAST-RESOURCE',
      '-  replicas: 2',
      '+  replicas: 9',
    ].join('\n')
    const out = filter?.apply(body, '', 0, ['kubectl', 'diff', '-f', 'manifests/']).text as string
    expect(out).toContain('LAST-RESOURCE')
    expect(out).toContain('+  replicas: 9')
    expect(out).toContain('first')
  })

  it('keeps the end of a git log patch, not only its first file', () => {
    // A commit's patch runs file by file. A head-only cap showed the alphabetically first file and dropped the rest outright.
    const filter = filterByName('git-log')
    expect(filter).not.toBeNull()
    const body = [
      'commit 0123456789abcdef0123456789abcdef01234567',
      'Author: Someone <someone@example.com>',
      'Date:   Sun Sep 6 12:00:00 2026 +0000',
      '',
      '    touch a lot of files',
      '',
      'diff --git a/src/aaa.ts b/src/aaa.ts',
      ...Array.from({ length: 300 }, (_, i) => `+  const filler${i} = ${i}`),
      'diff --git a/src/zzz.ts b/src/zzz.ts',
      '+  const LAST_FILE_SENTINEL = true',
    ].join('\n')
    const out = filter?.apply(body, '', 0, ['git', 'log', '-p']).text as string
    expect(out).toContain('LAST_FILE_SENTINEL')
    expect(out).toContain('src/aaa.ts')
    expect(out).toContain('lines omitted by token-goat')
  })

  it('admits when suppressed rg match groups were tied with the ones it kept', () => {
    // Ranking is by match count and the sort is stable, so equal-scoring groups are kept in ripgrep's own output order, which is alphabetical by path. When every group has one match the five survivors were chosen by filename; the note used to imply they were the densest.
    const filter = filterByName('rg')
    expect(filter).not.toBeNull()
    const group = (name: string): string => [`${name}:12:  const value = lookup()`, `${name}-13-  return value`].join('\n')
    const names = Array.from({ length: 12 }, (_, i) => `src/mod_${String.fromCharCode(97 + i)}.ts`)
    const tiedOut = filter?.apply(names.map(group).join('\n--\n'), '', 0, ['rg', '-C', '1', 'value']).text as string
    expect(tiedOut).toContain('tied on match count')

    // A search where the kept groups really are denser must not carry the tie wording, or it means nothing.
    const ranked = names.map((n, i) => (i < 5 ? [group(n), `${n}:20:  const value = other()`, `${n}:21:  const value = third()`].join('\n') : group(n)))
    const rankedOut = filter?.apply(ranked.join('\n--\n'), '', 0, ['rg', '-C', '1', 'value']).text as string
    expect(rankedOut).toContain('each with fewer matches than those kept')
    expect(rankedOut).not.toContain('tied on match count')
  })
})
