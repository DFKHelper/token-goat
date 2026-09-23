/** An inline interpreter file read (`python -c "...open('x')..."`, `node -e "...readFileSync('x')..."`, PowerShell `[IO.File]::ReadAllText('x')`) runs under a token cap through the passthrough filter instead of being refused, and falls back to the refusal wherever the wrapper cannot run. The refusal was measured before this changed: across the Claude Code and Codex transcripts on this machine from 2026-08-08 to 2026-09-23 it fired 217 times, and about 203 of those commands were projections (one key, a count, a slice) against a single whole-file dump. The next call after a refusal was another python or node variant 31% of the time, and one session took 91 consecutive refusals. */
import { afterEach, describe, expect, it } from 'vitest'

import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { preBashHandler } from '../src/hooks_bash.js'
import type { HookOutput } from '../src/types.js'
import { makeHookEvent } from './helpers/hook-event.js'

function bashEvent(command: string) {
  return makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: 'test-session', agentId: undefined, raw: {} })
}

function wrapped(result: HookOutput): string {
  if (result.hookType !== 'rewriteInput') throw new Error(`expected a rewrite, got ${result.hookType}`)
  return String(result.updatedInput['command'])
}

function capHint(command: string): string {
  const m = / --cap-hint-b64 (\S+) /.exec(command)
  if (m === null) throw new Error(`no cap hint in: ${command}`)
  return Buffer.from(m[1] as string, 'base64').toString('utf8')
}

// CAPTURE: two of the 217 refused commands, verbatim from the transcripts (the first a Claude Code session, the second one line of a multi-line one); both project a few fields out of one JSON file.
const PROJECTION_ONE_LINE = `python -c "import json;d=json.load(open('C:/Users/zelys/AppData/Local/Temp/tweet.json',encoding='utf-8'));t=d.get('tweet',d);print(t.get('text') or t.get('raw_text',{}).get('text'))"`
const PROJECTION_MULTI_LINE = `python -c "\nimport json\nd=json.load(open('.selfimprove/targets.json'))\nfor i,t in enumerate(d['targets']): print(i, t['id'], '|', t['title'][:78])\n"`

describe('inline interpreter file reads run capped instead of refused', () => {
  const saved = process.env['TOKEN_GOAT_BASH_COMPRESS']
  afterEach(() => {
    if (saved === undefined) delete process.env['TOKEN_GOAT_BASH_COMPRESS']
    else process.env['TOKEN_GOAT_BASH_COMPRESS'] = saved
  })

  it('wraps a python projection in the passthrough filter under a 2,000-token cap, carrying the JSON query commands as its cap hint', () => {
    const command = wrapped(preBashHandler(bashEvent(PROJECTION_ONE_LINE)))
    expect(command).toMatch(/^token-goat compress -f passthrough --timeout \d+ --max-tokens 2000 --cap-hint-b64 \S+ -c '/)
    expect(command).toContain('tweet.json')
    const hint = capHint(command)
    expect(hint).toContain('token-goat json-outline "C:/Users/zelys/AppData/Local/Temp/tweet.json"')
    // The refusal's lead says the read bypasses the hooks; printed after output that ran, it would be false.
    expect(hint).not.toContain('bypass')
  })

  it('wraps a multi-line python -c projection the same way', () => {
    const command = wrapped(preBashHandler(bashEvent(PROJECTION_MULTI_LINE)))
    expect(command).toContain(' -f passthrough ')
    expect(capHint(command)).toContain('token-goat json-outline ".selfimprove/targets.json"')
  })

  it('wraps node readFileSync and PowerShell ReadAllText reads the same way', () => {
    expect(capHint(wrapped(preBashHandler(bashEvent(`node -e "console.log(require('fs').readFileSync('src/cli.ts','utf8').length)"`))))).toContain('token-goat outline "src/cli.ts"')
    expect(capHint(wrapped(preBashHandler(bashEvent(`powershell -Command "[IO.File]::ReadAllText('README.md')"`))))).toContain('token-goat section "README.md::')
  })

  it('refuses with the full message when compression is off, so the wrapper cannot run', () => {
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    const result = preBashHandler(bashEvent(PROJECTION_ONE_LINE))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Python `open()` file reads bypass read hooks.')
      expect(result.message).toContain('token-goat json-outline "C:/Users/zelys/AppData/Local/Temp/tweet.json"')
    }
  })

  it('wraps a heredoc read too, the shape 81 of the 217 measured refusals arrived in', () => {
    const command = wrapped(preBashHandler(bashEvent(`python - <<'PY'\nimport json\nprint(json.load(open('r.json'))['118615'])\nPY`)))
    expect(command).toContain(' -f passthrough ')
    expect(capHint(command)).toContain('token-goat json-outline "r.json"')
  })

  it('refuses a read sent to the background, which the wrapper would wait on', () => {
    expect(preBashHandler(bashEvent(`python -c "print(open('src/cli.ts').read())" &`)).hookType).toBe('deny')
  })

  // HAND-DERIVED: the relay passes every refusal through stripUnsafeSuggestions, which accepts only double-quoted arguments. A single-quoted key reached a dogfooded refusal as "token-goat (command omitted: ...)" and took the rest of the sentence with it.
  it('names a query command the suggestion guard keeps in its refusal', () => {
    const result = preBashHandler(bashEvent(`python -c "print(open('r.json').read())" &`))
    if (result.hookType !== 'deny') throw new Error(`expected a refusal, got ${result.hookType}`)
    expect(result.message).toContain('token-goat json-query "r.json" "KEY"')
    expect(stripUnsafeSuggestions(result.message)).toBe(result.message)
  })

  it('prints a cap hint the suggestion guard keeps, since it reaches the model as command output rather than through the relay', () => {
    const hint = capHint(wrapped(preBashHandler(bashEvent(`python - <<'PY'\nimport json\nprint(json.load(open('r.json'))['118615'])\nPY`))))
    expect(hint).toContain('token-goat json-query "r.json" "KEY"')
    expect(stripUnsafeSuggestions(hint)).toBe(hint)
  })

  it('drops a cap hint suggestion whose path would expand in the shell', () => {
    // HAND-DERIVED: inside single shell quotes `$x.json` is a literal file name, but pasted into the hint's double-quoted argument it would expand.
    const hint = capHint(wrapped(preBashHandler(bashEvent(`python -c 'print(open("$x.json").read())'`))))
    expect(hint).not.toContain('$x.json')
    expect(hint).toContain('command omitted')
  })

  it('refuses a script too long to wrap under the command-line ceiling', () => {
    const long = `python -c "print(open('src/cli.ts').read()); x='${'a'.repeat(25_000)}'"`
    expect(preBashHandler(bashEvent(long)).hookType).toBe('deny')
  })
})
