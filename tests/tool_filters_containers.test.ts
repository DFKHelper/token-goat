// Tests for the container / kubernetes filter family (Batch F): DockerFilter, DockerComposeFilter, KubectlFilter, KubectlLogsFilter, HelmFilter.
//
// Golden tests ported from the Python TestDockerFilter / TestKubectlFilter test classes, plus additional coverage for DockerComposeFilter, KubectlLogsFilter, and HelmFilter and a dispatch ordering smoke test.

import { describe, expect, it } from 'vitest'
import {
  DockerFilter,
  DockerComposeFilter,
  KubectlFilter,
  KubectlLogsFilter,
  HelmFilter,
  CONTAINER_FILTERS,
} from '../src/tool_filters/containers.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(
  filter: { apply: (...args: unknown[]) => { text: string } },
  stdout: string,
  stderr: string,
  exitCode: number,
  argv: string[],
): string {
  return filter.apply(stdout, stderr, exitCode, argv).text
}

// ---------------------------------------------------------------------------
// Dispatch ordering — KubectlLogsFilter must precede KubectlFilter; DockerComposeFilter must precede DockerFilter.
// ---------------------------------------------------------------------------

describe('CONTAINER_FILTERS dispatch ordering', () => {
  it('KubectlLogsFilter wins for kubectl logs', () => {
    const f = selectFilter(['kubectl', 'logs', 'my-pod'])
    expect(f?.name).toBe('kubectl-logs')
  })

  it('KubectlFilter wins for kubectl get (not logs)', () => {
    const f = selectFilter(['kubectl', 'get', 'pods'])
    expect(f?.name).toBe('kubectl')
  })

  it('KubectlFilter wins for kubectl describe', () => {
    const f = selectFilter(['kubectl', 'describe', 'pod', 'my-pod'])
    expect(f?.name).toBe('kubectl')
  })

  it('DockerComposeFilter wins for docker compose up', () => {
    const f = selectFilter(['docker', 'compose', 'up'])
    expect(f?.name).toBe('docker-compose')
  })

  it('DockerFilter wins for docker build', () => {
    const f = selectFilter(['docker', 'build', '.'])
    expect(f?.name).toBe('docker')
  })

  it('DockerFilter wins for docker push', () => {
    const f = selectFilter(['docker', 'push', 'myimage:latest'])
    expect(f?.name).toBe('docker')
  })

  it('HelmFilter wins for helm install', () => {
    const f = selectFilter(['helm', 'install', 'my-release', './chart'])
    expect(f?.name).toBe('helm')
  })

  it('CONTAINER_FILTERS array has correct ordering (kubectl-logs before kubectl)', () => {
    const names = CONTAINER_FILTERS.map((f) => f.name)
    expect(names.indexOf('kubectl-logs')).toBeLessThan(names.indexOf('kubectl'))
  })

  it('CONTAINER_FILTERS array has correct ordering (docker-compose before docker)', () => {
    const names = CONTAINER_FILTERS.map((f) => f.name)
    expect(names.indexOf('docker-compose')).toBeLessThan(names.indexOf('docker'))
  })
})

// ---------------------------------------------------------------------------
// DockerFilter — ported from Python TestDockerFilter
// ---------------------------------------------------------------------------

describe('DockerFilter', () => {
  const f = new DockerFilter()

  it('matches docker', () => expect(f.matches(['docker', 'build', '.'])).toBe(true))
  it('matches buildah', () => expect(f.matches(['buildah', 'bud', '.'])).toBe(true))
  it('matches podman', () => expect(f.matches(['podman', 'build', '.'])).toBe(true))
  it('does not match kubectl', () => expect(f.matches(['kubectl', 'get', 'pods'])).toBe(false))

  it('drops digest and progress lines, keeps step header', () => {
    // Ported from Python test_drops_digest_and_progress
    const text = [
      '#1 [internal] load build context',
      '#2 sha256:abc123def456789',
      '#3 12.3MB / 50.0MB 0.5s',
      '#4 [1/3] FROM alpine',
    ].join('\n')
    const result = apply(f, text, '', 0, ['docker', 'build'])
    expect(result).not.toContain('sha256:')
    expect(result).not.toContain('12.3MB / 50.0MB')
    expect(result).toContain('[1/3] FROM alpine')
  })

  it('drops BuildKit CACHED lines and emits a count', () => {
    // Ported from Python test_drops_buildkit_cached_lines
    const text = [
      '#1 [internal] load build context',
      '#2 CACHED',
      '#3 CACHED',
      '#4 CACHED',
      '#5 [1/2] RUN apt-get install -y curl',
      '#6 DONE 2.1s',
    ].join('\n')
    const result = apply(f, text, '', 0, ['docker', 'build'])
    const contentLines = result.split('\n').filter((ln) => !ln.startsWith('[token-goat:'))
    expect(contentLines.every((ln) => !ln.includes('CACHED'))).toBe(true)
    expect(result).toContain('3 CACHED')
  })

  it('drops push layer noise lines, keeps digest summary', () => {
    // Ported from Python test_drops_push_layer_noise
    const stderr = [
      'The push refers to repository [docker.io/myimage]',
      'abc123: Layer already exists',
      'def456: Layer already exists',
      'ghi789: Mounted from library/ubuntu',
      'latest: digest: sha256:abc123 size: 1234',
    ].join('\n')
    const result = apply(f, '', stderr, 0, ['docker', 'push'])
    expect(result).not.toContain('Layer already exists')
    expect(result).not.toContain('Mounted from')
    expect(result).toContain('digest')
  })

  it('drops docker pull per-layer status lines, keeps Status line', () => {
    // Ported from Python test_drops_pull_layer_status_lines
    const stderr = [
      'latest: Pulling from library/ubuntu',
      'a1b2c3d4e5f6: Pull complete',
      'b2c3d4e5f6a1: Verifying Checksum',
      'c3d4e5f6a1b2: Download complete',
      'd4e5f6a1b2c3: Already exists',
      'Status: Downloaded newer image for ubuntu:latest',
    ].join('\n')
    const result = apply(f, '', stderr, 0, ['docker', 'pull'])
    expect(result).not.toContain('Pull complete')
    expect(result).not.toContain('Verifying Checksum')
    expect(result).not.toContain('Already exists')
    expect(result).toContain('Downloaded newer image')
  })

  it('keeps ERROR lines in step body', () => {
    const text = [
      '#5 [2/3] RUN npm install',
      '#5 0.342 npm ERR! ERROR something went wrong',
      '#5 DONE 1.2s',
    ].join('\n')
    const result = apply(f, text, '', 1, ['docker', 'build'])
    expect(result).toContain('ERROR something went wrong')
  })

  it('emits a note marker when lines are dropped', () => {
    const text = [
      '#1 sha256:abc123def456789',
      '#2 12.3MB / 50.0MB 0.5s',
      '#3 CACHED',
    ].join('\n')
    const result = apply(f, text, '', 0, ['docker', 'build'])
    expect(result).toContain('[token-goat: dropped')
  })

  it('collapses legacy (non-BuildKit) "---> <hex>" intermediate-layer lines', () => {
    // Classic `DOCKER_BUILDKIT=0 docker build` output prints a bare 12-char-hex intermediate
    // layer hash per step (` ---> a1b2c3d4e5f6`), with no `sha256:` label -- that labeled form
    // is specific to the *different*, already-handled BuildKit `#N ... sha256:...` lines
    // covered by the tests above.
    const text = [
      'Step 1/4 : FROM node:18',
      ' ---> aaaaaaaaaaaa',
      'Step 2/4 : RUN npm install',
      ' ---> Using cache',
      ' ---> bbbbbbbbbbbb',
      'Step 3/4 : COPY . .',
      ' ---> cccccccccccc',
      'Step 4/4 : CMD ["node", "index.js"]',
      'Removing intermediate container dddddddddddd',
      ' ---> eeeeeeeeeeee',
      'Successfully built ffffffffffff',
    ].join('\n')
    const result = apply(f, text, '', 0, ['docker', 'build'])
    expect(result).not.toContain('aaaaaaaaaaaa')
    expect(result).not.toContain('bbbbbbbbbbbb')
    expect(result).not.toContain('cccccccccccc')
    expect(result).not.toContain('eeeeeeeeeeee')
    expect(result).toContain('building 4 layers, 1 cached')
    expect(result).toContain('Successfully built ffffffffffff')
  })

  it('keeps the failing step header for a legacy (non-BuildKit) RUN failure whose error text never spells out "error"', () => {
    // npm's real-world failure marker is "npm ERR!", not the literal substring "error" -- and
    // the docker-emitted failure line ("returned a non-zero code") doesn't say "error" either.
    // A failing RUN step must still keep its "Step N/M :" header so the agent knows *which*
    // command failed, not just see an orphaned npm ERR! line with no context.
    const text = [
      'Step 1/4 : FROM node:18',
      ' ---> aaaaaaaaaaaa',
      'Step 2/4 : RUN npm install',
      ' ---> Running in bbbbbbbbbbbb',
      'npm ERR! code E404',
      'npm ERR! 404 Not Found - GET https://registry.npmjs.org/nonexistent-package',
      "The command '/bin/sh -c npm install' returned a non-zero code: 1",
    ].join('\n')
    const result = apply(f, text, '', 1, ['docker', 'build'])
    expect(result).toContain('Step 2/4 : RUN npm install')
    expect(result).toContain('npm ERR! code E404')
  })
})

// ---------------------------------------------------------------------------
// DockerComposeFilter
// ---------------------------------------------------------------------------

describe('DockerComposeFilter', () => {
  const f = new DockerComposeFilter()

  it('matches docker-compose binary', () =>
    expect(f.matches(['docker-compose', 'up'])).toBe(true))

  it('matches docker compose subcommand', () =>
    expect(f.matches(['docker', 'compose', 'up', '-d'])).toBe(true))

  it('does not match plain docker build', () =>
    expect(f.matches(['docker', 'build', '.'])).toBe(false))

  it('collapses repeated Pulling lines, keeps first', () => {
    const text = [
      'Pulling db (postgres:15)...',
      'Pulling web (nginx:latest)...',
      'Pulling cache (redis:7)...',
    ].join('\n')
    const result = apply(f, text, '', 0, ['docker', 'compose', 'up'])
    // First Pulling line kept; rest elided
    expect(result).toContain('Pulling db')
    expect(result).toContain('2 more Pulling lines elided')
    expect(result).not.toContain('Pulling web')
    expect(result).not.toContain('Pulling cache')
  })

  it('collapses streaming service logs when >50 lines per service', () => {
    const lines: string[] = []
    for (let i = 0; i < 60; i++) lines.push(`web | log line ${i}`)
    const result = apply(f, lines.join('\n'), '', 0, ['docker', 'compose', 'up'])
    expect(result).toContain('lines from web elided')
    expect(result).toContain('log line 59')
  })

  it('passes through short service logs unchanged', () => {
    const lines: string[] = []
    for (let i = 0; i < 10; i++) lines.push(`web | log line ${i}`)
    const result = apply(f, lines.join('\n'), '', 0, ['docker', 'compose', 'up'])
    expect(result).not.toContain('elided')
    expect(result).toContain('log line 9')
  })

  it('collapses health-check retries per container', () => {
    const lines = [
      'Container myapp-db-1  Waiting',
      'Container myapp-db-1  Waiting',
      'Container myapp-db-1  health: starting',
      'Container myapp-db-1  Waiting',
    ]
    const result = apply(f, lines.join('\n'), '', 0, ['docker', 'compose', 'up'])
    // First occurrence kept; rest elided with a count
    expect(result).toContain('health-check wait lines for myapp-db-1')
  })

  it('passes through error output when exit code is non-zero', () => {
    const stderr = 'Error: Cannot connect to the Docker daemon'
    const result = apply(f, '', stderr, 1, ['docker', 'compose', 'up'])
    expect(result).toContain('Cannot connect to the Docker daemon')
  })
})

// ---------------------------------------------------------------------------
// KubectlFilter — ported from Python TestKubectlFilter
// ---------------------------------------------------------------------------

describe('KubectlFilter', () => {
  const f = new KubectlFilter()

  it('matches kubectl', () => expect(f.matches(['kubectl', 'get', 'pods'])).toBe(true))
  it('matches k alias', () => expect(f.matches(['k', 'get', 'pods'])).toBe(true))
  it('matches k9s alias', () => expect(f.matches(['k9s', 'get', 'pods'])).toBe(true))
  it('matches oc alias', () => expect(f.matches(['oc', 'get', 'pods'])).toBe(true))
  it('does not match helm', () => expect(f.matches(['helm', 'list'])).toBe(false))

  it('get truncates long table to header + 10 rows', () => {
    // Ported from Python test_get_truncates_long_table
    const rows = ['NAME READY STATUS RESTARTS AGE']
    for (let i = 0; i < 50; i++) rows.push(`pod-${i} 1/1 Running 0 5m`)
    const text = rows.join('\n')
    const result = apply(f, text, '', 0, ['kubectl', 'get', 'pods'])
    expect(result).toContain('NAME READY STATUS')
    expect(result).toContain('more rows')
    expect(result).toContain('pod-0')
    expect(result).toContain('pod-9')
  })

  it('get keeps short table unchanged', () => {
    // Ported from Python test_get_keeps_short_table
    const rows = ['NAME READY STATUS RESTARTS AGE']
    for (let i = 0; i < 5; i++) rows.push(`pod-${i} 1/1 Running 0 5m`)
    const text = rows.join('\n')
    const result = apply(f, text, '', 0, ['kubectl', 'get', 'pods'])
    expect(result).not.toContain('more rows')
    expect(result).toBe(text)
  })

  it('top truncates long table', () => {
    // Ported from Python test_top_truncates_long_table
    const rows = ['NAME CPU(cores) MEMORY(bytes)']
    for (let i = 0; i < 30; i++) rows.push(`pod-${i} 100m 256Mi`)
    const result = apply(f, rows.join('\n'), '', 0, ['kubectl', 'top', 'pods'])
    expect(result).toContain('more rows')
    expect(result).toContain('NAME CPU')
  })

  it('describe extracts key fields (Name, Namespace, Status)', () => {
    // Ported from Python test_describe_extracts_key_fields
    const text = [
      'Name:         my-pod',
      'Namespace:    default',
      'Status:       Running',
      'State:        Running',
      'Some other field: value',
      'Another field: data',
    ].join('\n')
    const result = apply(f, text, '', 0, ['kubectl', 'describe', 'pod', 'my-pod'])
    expect(result).toContain('Name:         my-pod')
    expect(result).toContain('Namespace:    default')
    expect(result).toContain('Status:       Running')
    expect(result).not.toContain('Some other field')
  })

  it('describe preserves Events section, elides older events', () => {
    // Ported from Python test_describe_preserves_events
    let text = [
      'Name:         my-pod',
      'Namespace:    default',
      'Events:',
      '  Type    Reason   Age  From  Message',
      '  ----    ------   ---  ----  -------',
    ].join('\n')
    const eventLines = Array.from({ length: 15 }, (_, i) => `  Normal  Created  ${i}s  ...  Event ${i}`)
    text += '\n' + eventLines.join('\n') + '\n'
    const result = apply(f, text, '', 0, ['kubectl', 'describe', 'pod', 'my-pod'])
    expect(result).toContain('Events:')
    expect(result).toContain('earlier events elided')
    // Last 10 events should be present; Event 14 or Event 13 is among them
    expect(result).toMatch(/Event 1[34]/)
  })

  it('logs uses head+tail compression for >50 lines', () => {
    // Ported from Python test_logs_compresses_large_output
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: log message`)
    const text = lines.join('\n')
    const result = apply(f, text, '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).toContain('log lines')
    expect(result).toContain('Line 0')
    expect(result).toContain('Line 99')
  })

  it('logs keeps short output unchanged', () => {
    // Ported from Python test_logs_keeps_short_output
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}: log message`)
    const text = lines.join('\n')
    const result = apply(f, text, '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).not.toContain('elided')
    expect(result).toBe(text)
  })

  it('apply passes through short output', () => {
    // Ported from Python test_apply_passes_through
    const text = 'pod/my-pod created'
    const result = apply(f, text, '', 0, ['kubectl', 'apply', '-f', 'manifest.yaml'])
    expect(result).toBe(text)
  })

  it('delete passes through short output', () => {
    // Ported from Python test_delete_passes_through
    const text = 'pod/my-pod deleted'
    const result = apply(f, text, '', 0, ['kubectl', 'delete', 'pod', 'my-pod'])
    expect(result).toBe(text)
  })

  it('diff truncates large diffs to first 50 lines', () => {
    // Ported from Python test_diff_truncates_large_diff
    const lines = Array.from({ length: 100 }, (_, i) => `diff line ${i}`)
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'diff', '-f', 'manifest.yaml'])
    expect(result).toContain('diff lines')
    expect(result).toContain('diff line 0')
  })

  it('error exit preserves stderr combined with stdout', () => {
    // Ported from Python test_error_preserves_stderr
    const result = apply(f, 'Some output', 'Error: something failed', 1, ['kubectl', 'get', 'pods'])
    expect(result).toContain('Error: something failed')
    expect(result).toContain('---')
  })
})

// ---------------------------------------------------------------------------
// KubectlLogsFilter
// ---------------------------------------------------------------------------

describe('KubectlLogsFilter', () => {
  const f = new KubectlLogsFilter()

  it('matches kubectl logs', () => expect(f.matches(['kubectl', 'logs', 'my-pod'])).toBe(true))
  it('matches k alias with logs', () => expect(f.matches(['k', 'logs', 'my-pod'])).toBe(true))
  it('does not match kubectl get', () => expect(f.matches(['kubectl', 'get', 'pods'])).toBe(false))
  it('does not match kubectl with no subcommand', () => expect(f.matches(['kubectl'])).toBe(false))

  it('passes through short log output unchanged', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `2024-01-01T00:00:${String(i).padStart(2,'0')}Z INFO message ${i}`)
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).not.toContain('elided')
  })

  it('collapses HTTP access logs when >20 lines (with >50 total to pass the early-exit)', () => {
    // KubectlLogsFilter only fires when nonEmpty.length > 50 (faithful to Python). Use 60 access-log lines to exercise _collapseAccessLogs.
    const accessLine = (i: number) =>
      `10.0.0.1 - - [01/Jan/2024:00:00:${String(i % 60).toString().padStart(2,'0')} +0000] "GET /health HTTP/1.1" 200 5 req=${i}`
    const lines = Array.from({ length: 60 }, (_, i) => accessLine(i))
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).toContain('HTTP access log lines collapsed')
    expect(result).toContain('2xx')
  })

  it('collapses stack trace frames beyond 5 (with >50 total to pass the early-exit)', () => {
    // KubectlLogsFilter only fires when nonEmpty.length > 50 (faithful to Python). Pad with unique log lines before the stack trace to exceed the threshold.
    const preamble = Array.from({ length: 50 }, (_, i) => `2024-01-01T00:00:00Z INFO log msg ${i}`)
    const traceLines = [
      'Error: something went wrong',
      '    at com.example.Foo.bar(Foo.java:42)',
      '    at com.example.Baz.qux(Baz.java:17)',
      '    at com.example.Main.run(Main.java:100)',
      '    at com.example.App.start(App.java:55)',
      '    at com.example.Server.handle(Server.java:88)',
      '    at com.example.Router.dispatch(Router.java:33)',
      '    at com.example.Handler.call(Handler.java:10)',
      'Next exception here',
    ]
    const lines = [...preamble, ...traceLines]
    // 7 frame lines → keep 5, show "... 2 more frames"
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).toContain('more frames')
    expect(result).toContain('2 more frames')
    // First 5 frames kept
    expect(result).toContain('Foo.bar')
    expect(result).toContain('Server.handle')
    // 6th and 7th frames collapsed
    expect(result).not.toContain('Router.dispatch')
    expect(result).not.toContain('Handler.call')
  })

  it('collapses Python-style 2-line traceback frames beyond 5, keeping each File line paired with its source line', () => {
    // KubectlLogsFilter only fires when nonEmpty.length > 50 (faithful to Python). Pad with unique log lines before the traceback to exceed the threshold.
    const preamble = Array.from({ length: 50 }, (_, i) => `2024-01-01T00:00:00Z INFO log msg ${i}`)
    const traceLines = [
      'Traceback (most recent call last):',
      '  File "app.py", line 1, in foo1',
      '    bar()',
      '  File "app.py", line 2, in foo2',
      '    bar()',
      '  File "app.py", line 3, in foo3',
      '    bar()',
      '  File "app.py", line 4, in foo4',
      '    bar()',
      '  File "app.py", line 5, in foo5',
      '    bar()',
      '  File "app.py", line 6, in foo6',
      '    bar()',
      '  File "app.py", line 7, in foo7',
      '    bar()',
      'ValueError: boom',
    ]
    const lines = [...preamble, ...traceLines]
    // 7 logical frames (2 physical lines each) → keep 5 frames, collapse 2.
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).toContain('more frames')
    expect(result).toContain('2 more frames')
    // First 5 frames kept, each File line paired with its own source line.
    expect(result).toContain('foo1')
    expect(result).toContain('foo5')
    // 6th and 7th frames collapsed entirely (both File line and its source line).
    expect(result).not.toContain('foo6')
    expect(result).not.toContain('foo7')
    // The final exception summary line must never be swallowed as a "source line".
    expect(result).toContain('ValueError: boom')
  })

  it('deduplicates repetitive log lines, keeps first 3 (with >50 total to pass the early-exit)', () => {
    // KubectlLogsFilter only fires when nonEmpty.length > 50 (faithful to Python). 45 unique lines + 10 repetitions = 55 lines total.
    const unique = Array.from({ length: 45 }, (_, i) => `2024-01-01T00:00:00Z INFO unique event ${i}`)
    const repeated = Array.from({ length: 10 }, (_, i) =>
      `2024-01-01T00:00:${String(i).padStart(2,'0')}Z INFO health check ok`)
    const lines = [...unique, ...repeated]
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'logs', 'my-pod'])
    const keptHealthLines = result.split('\n').filter((l) => l.includes('health check ok'))
    expect(keptHealthLines.length).toBe(3)
    expect(result).toContain('more similar lines omitted')
  })

  it('applies head+tail cap when output exceeds 200 lines after all steps', () => {
    // Create 250 distinct lines (to avoid dedup collapsing them)
    const lines = Array.from({ length: 250 }, (_, i) => `2024-01-01T00:00:00Z INFO unique event ${i}`)
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).toContain('log lines')
    expect(result).toContain('unique event 0')
    expect(result).toContain('unique event 249')
  })

  it('collapses multi-line JSON blobs >5 lines', () => {
    const blob = [
      '{',
      '  "message": "request started",',
      '  "level": "info",',
      '  "service": "api",',
      '  "trace": "abc123",',
      '  "extra": "data"',
      '}',
    ]
    const lines = Array.from({ length: 60 }, (_, i) => `2024-01-01T00:00:00Z INFO msg ${i}`)
    // Insert a JSON blob
    lines.splice(30, 0, ...blob)
    const result = apply(f, lines.join('\n'), '', 0, ['kubectl', 'logs', 'my-pod'])
    expect(result).toContain('JSON blob')
    expect(result).toContain('lines collapsed')
  })
})

// ---------------------------------------------------------------------------
// HelmFilter
// ---------------------------------------------------------------------------

describe('HelmFilter', () => {
  const f = new HelmFilter()

  it('matches helm', () => expect(f.matches(['helm', 'install', 'my-release', './chart'])).toBe(true))
  it('does not match kubectl', () => expect(f.matches(['kubectl', 'get', 'pods'])).toBe(false))

  it('install collapses boilerplate and keeps STATUS line', () => {
    const text = [
      'NAME: my-release',
      'LAST DEPLOYED: Mon Jan  1 00:00:00 2024',
      'NAMESPACE: default',
      'STATUS: deployed',
      'REVISION: 1',
      'NOTES:',
      'Thank you for installing the chart.',
      'To get started, run:',
    ].join('\n')
    const result = apply(f, text, '', 0, ['helm', 'install', 'my-release', './chart'])
    expect(result).toContain('STATUS: deployed')
    expect(result).toContain('helm release description lines elided')
    expect(result).not.toContain('LAST DEPLOYED')
    expect(result).not.toContain('Thank you for installing')
  })

  it('install preserves error signal lines', () => {
    const text = [
      'NAME: my-release',
      'STATUS: failed',
      'Error: INSTALLATION FAILED: unable to build kubernetes objects',
    ].join('\n')
    const result = apply(f, text, '', 1, ['helm', 'install', 'my-release', './chart'])
    expect(result).toContain('Error: INSTALLATION FAILED')
  })

  it('list caps at 10 data rows with a count', () => {
    const rows = ['NAME\tNAMESPACE\tREVISION\tSTATUS\tCHART']
    for (let i = 0; i < 25; i++) rows.push(`release-${i}\tdefault\t1\tdeployed\tmy-chart-1.0.0`)
    const result = apply(f, rows.join('\n'), '', 0, ['helm', 'list'])
    expect(result).toContain('more helm releases elided')
    expect(result).toContain('release-0')
    expect(result).toContain('release-9')
    expect(result).not.toContain('release-10')
  })

  it('list keeps short output unchanged', () => {
    const rows = ['NAME\tNAMESPACE\tREVISION\tSTATUS\tCHART']
    for (let i = 0; i < 5; i++) rows.push(`release-${i}\tdefault\t1\tdeployed\tmy-chart-1.0.0`)
    const text = rows.join('\n')
    const result = apply(f, text, '', 0, ['helm', 'list'])
    expect(result).not.toContain('elided')
  })

  it('template emits only document separators when >200 lines', () => {
    const lines: string[] = []
    lines.push('---')
    lines.push('# Source: my-chart/templates/deployment.yaml')
    for (let i = 0; i < 50; i++) lines.push(`  field${i}: value`)
    lines.push('---')
    lines.push('# Source: my-chart/templates/service.yaml')
    for (let i = 0; i < 160; i++) lines.push(`  port${i}: 80`)
    const result = apply(f, lines.join('\n'), '', 0, ['helm', 'template', './chart'])
    expect(result).toContain('document headers only')
    expect(result).toContain('---')
  })

  it('template passes through short output unchanged', () => {
    const lines: string[] = []
    lines.push('---')
    lines.push('# Source: my-chart/templates/deployment.yaml')
    for (let i = 0; i < 10; i++) lines.push(`  field${i}: value`)
    const text = lines.join('\n')
    const result = apply(f, text, '', 0, ['helm', 'template', './chart'])
    expect(result).not.toContain('document headers only')
  })

  it('other subcommands pass through', () => {
    const text = 'Release "my-release" has been rolled back.'
    const result = apply(f, text, '', 0, ['helm', 'rollback', 'my-release'])
    expect(result).toBe(text)
  })

  it('error exit passes stderr through', () => {
    const stderr = 'Error: release: not found'
    const result = apply(f, '', stderr, 1, ['helm', 'status', 'my-release'])
    expect(result).toContain('release: not found')
  })
})

// ---------------------------------------------------------------------------
// Regression: KubectlLogsFilter dedup flush order Verified fail-pre (without the prevKey flush guard) / pass-post.
// ---------------------------------------------------------------------------

describe('KubectlLogsFilter dedup flush regression', () => {
  it('flushes omit marker when switching to a different message mid-stream (>50 lines)', () => {
    // Without the prevKey guard, the omit marker for the first message would appear at the END of output rather than after the last repeated line. This regression test proves it appears in the right position (before the next distinct message). Pad to >50 lines so the filter actually engages (faithful to Python).
    const filler = Array.from({ length: 44 }, (_, i) => `2024-01-01T00:00:00Z INFO filler ${i}`)
    const repeated = Array.from({ length: 5 }, () => '2024-01-01T00:00:00Z INFO repeated message')
    const different = ['2024-01-01T00:00:01Z INFO different message']
    const lines = [...filler, ...repeated, ...different] // 50 total
    // Add one more to exceed 50
    lines.push('2024-01-01T00:00:02Z INFO extra line')
    const result = apply(new KubectlLogsFilter(), lines.join('\n'), '', 0, ['kubectl', 'logs', 'p'])
    const outputLines = result.split('\n').filter(Boolean)
    const omitIdx = outputLines.findIndex((l) => l.includes('more similar lines omitted'))
    const diffIdx = outputLines.findIndex((l) => l.includes('different message'))
    // The omit marker must appear BEFORE the different message
    expect(omitIdx).toBeGreaterThanOrEqual(0)
    expect(diffIdx).toBeGreaterThanOrEqual(0)
    expect(omitIdx).toBeLessThan(diffIdx)
  })
})
