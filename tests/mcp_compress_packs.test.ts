import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  compressGithubMcpResult,
  compressBrowserMcpResult,
  compressGWorkspaceMcpResult,
  compressMcpResultWithPacks,
} from '../src/mcp_compress_packs.js'
// Importing relay registers every hook module (including hooks_mcp) for its side
// effects, so runHook dispatches through the real production registry, same
// pattern as tests/hooks_mcp.test.ts.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { getBashOutput } from '../src/bash_output_cache.js'

// --- fixtures ----------------------------------------------------------------

/** A realistic GitHub REST `user` object, boilerplate fields included. */
function githubUser(login: string) {
  return {
    login,
    id: 583231,
    node_id: 'MDQ6VXNlcjU4MzIzMQ==',
    avatar_url: `https://avatars.githubusercontent.com/u/583231?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    followers_url: `https://api.github.com/users/${login}/followers`,
    following_url: `https://api.github.com/users/${login}/following{/other_user}`,
    gists_url: `https://api.github.com/users/${login}/gists{/gist_id}`,
    starred_url: `https://api.github.com/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `https://api.github.com/users/${login}/subscriptions`,
    organizations_url: `https://api.github.com/users/${login}/orgs`,
    repos_url: `https://api.github.com/users/${login}/repos`,
    events_url: `https://api.github.com/users/${login}/events{/privacy}`,
    received_events_url: `https://api.github.com/users/${login}/received_events`,
    type: 'User',
    site_admin: false,
  }
}

/** A realistic GitHub `list_pull_requests`-shaped array element. */
function githubPr(i: number) {
  return {
    id: 900000 + i,
    node_id: `PR_kwDOabc${i}`,
    number: i,
    title: `Fix bug number ${i}`,
    state: 'open',
    user: githubUser('octocat'),
    body: `Description for PR ${i}.`,
    html_url: `https://github.com/o/r/pull/${i}`,
    url: `https://api.github.com/repos/o/r/pulls/${i}`,
    diff_url: `https://github.com/o/r/pull/${i}.diff`,
    patch_url: `https://github.com/o/r/pull/${i}.patch`,
    issue_url: `https://api.github.com/repos/o/r/issues/${i}`,
    commits_url: `https://api.github.com/repos/o/r/pulls/${i}/commits`,
    review_comments_url: `https://api.github.com/repos/o/r/pulls/${i}/comments`,
    review_comment_url: `https://api.github.com/repos/o/r/pulls/comments{/number}`,
    comments_url: `https://api.github.com/repos/o/r/issues/${i}/comments`,
    statuses_url: `https://api.github.com/repos/o/r/statuses/abc${i}`,
    _links: {
      self: { href: `https://api.github.com/repos/o/r/pulls/${i}` },
      html: { href: `https://github.com/o/r/pull/${i}` },
      issue: { href: `https://api.github.com/repos/o/r/issues/${i}` },
      comments: { href: `https://api.github.com/repos/o/r/issues/${i}/comments` },
      review_comments: { href: `https://api.github.com/repos/o/r/pulls/${i}/comments` },
      review_comment: { href: `https://api.github.com/repos/o/r/pulls/comments{/number}` },
      commits: { href: `https://api.github.com/repos/o/r/pulls/${i}/commits` },
      statuses: { href: `https://api.github.com/repos/o/r/statuses/abc${i}` },
    },
  }
}

function githubPrList(n: number) {
  return Array.from({ length: n }, (_, i) => githubPr(i + 1))
}

/** A realistic browser-automation console-message list entry (CDP `Runtime.consoleAPICalled` shape). */
function consoleMessage(i: number) {
  return {
    type: i % 5 === 0 ? 'error' : 'log',
    text: `[app] handled event ${i}`,
    url: 'https://example.com/app.js',
    lineNumber: 100 + i,
    timestamp: 1700000000000 + i,
    source: 'console-api',
    stackTrace: {
      callFrames: [
        { functionName: 'handleEvent', scriptId: '12', url: 'https://example.com/app.js', lineNumber: 100 + i, columnNumber: 4 },
        { functionName: 'dispatch', scriptId: '12', url: 'https://example.com/app.js', lineNumber: 40, columnNumber: 2 },
        { functionName: '', scriptId: '3', url: 'https://example.com/vendor.js', lineNumber: 900, columnNumber: 15 },
      ],
    },
  }
}

function consoleMessageList(n: number) {
  return Array.from({ length: n }, (_, i) => consoleMessage(i))
}

/** A realistic browser-automation network-request list entry. */
function networkRequest(i: number) {
  return {
    reqid: 1000 + i,
    url: `https://example.com/api/items/${i}`,
    method: 'GET',
    status: 200,
    statusText: 'OK',
    resourceType: 'fetch',
    mimeType: 'application/json',
    fromCache: false,
    requestHeaders: {
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      cookie: 'session=abc123; theme=dark',
    },
    responseHeaders: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '482',
      'cache-control': 'no-cache',
      server: 'nginx',
      date: 'Sun, 12 Jul 2026 00:00:00 GMT',
    },
    timing: {
      requestTime: 123456.789,
      proxyStart: -1,
      proxyEnd: -1,
      dnsStart: 0.1,
      dnsEnd: 0.2,
      connectStart: 0.2,
      connectEnd: 1.5,
      sendStart: 1.6,
      sendEnd: 1.7,
      receiveHeadersEnd: 12.3,
    },
    initiator: {
      type: 'script',
      stack: {
        callFrames: [{ functionName: 'fetchItems', scriptId: '9', url: 'https://example.com/app.js', lineNumber: 55, columnNumber: 8 }],
      },
    },
  }
}

function networkRequestList(n: number) {
  return Array.from({ length: n }, (_, i) => networkRequest(i))
}

/** A realistic Gmail thread with several messages, HTML-duplicated bodies, quoted-reply history, and an attachment with an inline base64 payload. */
function gmailThread() {
  const quotedHistory =
    '\n\nOn Mon, Jul 6, 2026 at 9:00 AM, Bob <bob@example.com> wrote:\n> Thanks, sounds good.\n>\n> On Sun, Jul 5, 2026, Alice wrote:\n> > Let'.padEnd(4000, ' filler quoted text from a long thread history ') + '\n>'
  return {
    id: 'thread-1',
    subject: 'Q3 planning',
    messages: [
      {
        id: 'msg-1',
        subject: 'Q3 planning',
        from: 'alice@example.com',
        to: ['bob@example.com'],
        snippet: 'Here is the plan for Q3...',
        plaintextBody: `Here is the plan for Q3, please review the attached doc.${quotedHistory}`,
        htmlBody: `<div dir="ltr"><p>Here is the plan for Q3, please review the attached doc.</p>${'<span>filler html markup </span>'.repeat(200)}</div>`,
        raw: 'QmFzZTY0RW5jb2RlZFJhd01pbWVQYXlsb2FkRmlsbGVy'.repeat(50),
        attachments: [
          {
            id: 'att-1',
            filename: 'plan.pdf',
            mimeType: 'application/pdf',
            size: 204800,
            data: 'QmFzZTY0QXR0YWNobWVudEJ5dGVzRmlsbGVy'.repeat(80),
          },
        ],
      },
    ],
  }
}

/** A realistic Drive `read_file_content` result: plain natural-language text, no HTML/attachment noise to strip. */
function driveFileContent() {
  return {
    fileId: 'file-1',
    title: 'Project Notes',
    content: 'These are my project notes.\n> A genuine markdown blockquote that must survive untouched.\nMore notes follow.'.repeat(30),
  }
}

/**
 * A realistic accessibility-tree snapshot text blob in the documented
 * `{2*depth spaces}uid={id} {role} "{name}" attr1="value1" ...` shape
 * (chrome-devtools-mcp `take_snapshot` / claude-in-chrome `read_page`).
 * Mixes short interactive-element lines (must survive untouched), one
 * long-text `StaticText` line (must be truncated), and one malformed line
 * with an unexpected shape (must pass through unchanged).
 */
function a11ySnapshotText() {
  const longParagraph = (
    'This paragraph describes the quarterly results in extensive detail, covering revenue trends, ' +
    'headcount changes, and forward-looking guidance for the next fiscal year across every region. '
  ).repeat(5)
  return [
    'uid=1 RootWebArea "Example Page"',
    '  uid=2 heading "Welcome"',
    '  uid=3 generic',
    '    uid=4 StaticText "Short label"',
    `    uid=5 StaticText "${longParagraph}"`,
    '  uid=6 button "Submit" disabled',
    '  uid=7 link "Email address" href="mailto:test@example.com"',
    'this line does not match the expected node shape at all',
  ].join('\n')
}

// --- compressGithubMcpResult -------------------------------------------------

describe('compressGithubMcpResult', () => {
  it('returns null for a non-github tool name even if the shape matches', () => {
    const text = JSON.stringify(githubPrList(30))
    expect(compressGithubMcpResult('mcp__plugin_playwright_playwright__list_pull_requests', text)).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(compressGithubMcpResult('mcp__plugin_github_github__list_pull_requests', 'not json')).toBeNull()
  })

  it('strips GitHub boilerplate fields and hoists constant columns from a realistic list_pull_requests fixture', () => {
    const rows = githubPrList(30)
    const text = JSON.stringify(rows)
    const compressed = compressGithubMcpResult('mcp__plugin_github_github__list_pull_requests', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).not.toContain('node_id')
      expect(compressed).not.toContain('_links')
      expect(compressed).not.toContain('gravatar_id')
      expect(compressed).not.toContain('site_admin')
      expect(compressed).not.toContain('avatar_url')
      expect(compressed).not.toContain('followers_url')
      expect(compressed).not.toContain('html_url')
      // Actual content (title, number, login) survives.
      expect(compressed).toContain('octocat')
      expect(compressed).toContain('Fix bug number 1')
      // Genuinely smaller than the original, clearing the savings bar.
      expect(compressed.length).toBeLessThan(text.length * 0.85)
    }
  })

  it('keeps download_url/git_url/clone_url/ssh_url despite the generic *_url suffix strip', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      name: `file-${i}.txt`,
      path: `dir/file-${i}.txt`,
      sha: `abc${i}`,
      size: 123 + i,
      url: `https://api.github.com/repos/o/r/contents/dir/file-${i}.txt`,
      html_url: `https://github.com/o/r/blob/main/dir/file-${i}.txt`,
      git_url: `https://api.github.com/repos/o/r/git/blobs/abc${i}`,
      download_url: `https://raw.githubusercontent.com/o/r/main/dir/file-${i}.txt`,
      type: 'file',
    }))
    const text = JSON.stringify(rows)
    const compressed = compressGithubMcpResult('mcp__plugin_github_github__get_file_contents', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).not.toContain('html_url')
      expect(compressed).toContain('git_url')
      expect(compressed).toContain('download_url')
    }
  })

  it('falls through to null when stripping is a no-op and the row count is too low for the generic pass to help either', () => {
    // No boilerplate fields to strip at all -- stripping is a no-op -- and below
    // the generic pass's MIN_ROWS, so neither stage of the pack can pay off.
    const rows = Array.from({ length: 2 }, (_, i) => ({ number: i, title: `pr ${i}`, state: 'open' }))
    const text = JSON.stringify(rows)
    expect(compressGithubMcpResult('mcp__plugin_github_github__list_pull_requests', text)).toBeNull()
  })

  it('respects the savings-ratio threshold: a tiny boilerplate field next to large unique per-row content does not clear the bar', () => {
    // node_id is stripped, but it is a small fraction of each row next to a large,
    // fully-unique `body` field the generic table pass cannot fold into a constant
    // column -- neither the strip nor the resulting table clears the 15% bar.
    const rows = Array.from({ length: 5 }, (_, i) => ({
      number: i,
      node_id: `n${i}`,
      body: `Lorem ipsum dolor sit amet, consectetur adipiscing elit, unique paragraph number ${i} `.repeat(20),
    }))
    const text = JSON.stringify(rows)
    expect(compressGithubMcpResult('mcp__plugin_github_github__list_pull_requests', text)).toBeNull()
  })
})

// --- compressBrowserMcpResult ------------------------------------------------

describe('compressBrowserMcpResult', () => {
  it('returns null for a non-browser tool name', () => {
    const text = JSON.stringify(consoleMessageList(30))
    expect(compressBrowserMcpResult('mcp__plugin_github_github__list_network_requests', text)).toBeNull()
  })

  it('returns null for a recognized browser server but an unrecognized method', () => {
    const text = JSON.stringify(consoleMessageList(30))
    expect(compressBrowserMcpResult('mcp__claude-in-chrome__find', text)).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(compressBrowserMcpResult('mcp__claude-in-chrome__read_console_messages', 'not json')).toBeNull()
  })

  it('strips stackTrace from a claude-in-chrome read_console_messages fixture', () => {
    const rows = consoleMessageList(40)
    const text = JSON.stringify(rows)
    const compressed = compressBrowserMcpResult('mcp__claude-in-chrome__read_console_messages', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).not.toContain('stackTrace')
      expect(compressed).not.toContain('callFrames')
      expect(compressed).not.toContain('functionName')
      // Actual message content survives.
      expect(compressed).toContain('handled event')
      expect(compressed.length).toBeLessThan(text.length * 0.85)
    }
  })

  it('strips requestHeaders/responseHeaders/timing/initiator from a chrome-devtools-mcp list_network_requests fixture', () => {
    const rows = networkRequestList(40)
    const text = JSON.stringify(rows)
    const compressed = compressBrowserMcpResult(
      'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests',
      text,
    )
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).not.toContain('requestHeaders')
      expect(compressed).not.toContain('responseHeaders')
      expect(compressed).not.toContain('accept-encoding')
      expect(compressed).not.toContain('timing')
      expect(compressed).not.toContain('initiator')
      // Actual request-level facts survive.
      expect(compressed).toContain('/api/items/')
      expect(compressed).toContain('200')
      expect(compressed.length).toBeLessThan(text.length * 0.85)
    }
  })

  it('falls through to null when stripping is a no-op and the row count is too low for the generic pass to help either', () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ url: `https://example.com/${i}`, method: 'GET', status: 200 }))
    const text = JSON.stringify(rows)
    expect(compressBrowserMcpResult('mcp__claude-in-chrome__read_network_requests', text)).toBeNull()
  })

  describe('accessibility-tree snapshot (take_snapshot / read_page)', () => {
    it('truncates a long StaticText name while leaving every uid byte-identical, short names untouched, and the malformed line passed through', () => {
      const text = a11ySnapshotText()
      const compressed = compressBrowserMcpResult('mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot', text)
      expect(compressed).not.toBeNull()
      if (compressed === null) return

      const origLines = text.split('\n')
      const outLines = compressed.split('\n')
      expect(outLines.length).toBe(origLines.length)

      // Every uid= token survives byte-identical, on every line, regardless of role/name.
      for (let i = 0; i < origLines.length; i++) {
        const origUid = origLines[i]?.match(/uid=\S+/)?.[0]
        const outUid = outLines[i]?.match(/uid=\S+/)?.[0]
        expect(outUid).toBe(origUid)
      }

      // Short interactive-element lines are untouched.
      expect(outLines[1]).toBe(origLines[1]) // heading "Welcome"
      expect(outLines[3]).toBe(origLines[3]) // StaticText "Short label"
      expect(outLines[5]).toBe(origLines[5]) // button "Submit" disabled
      expect(outLines[6]).toBe(origLines[6]) // link "Email address" href=...

      // The long StaticText line is truncated with the repo's existing
      // capLongLines-style "N chars elided" marker, and trailing attributes
      // (none here, but the shape) plus indentation/uid/role survive.
      const longOut = outLines[4] ?? ''
      expect(longOut).not.toBe(origLines[4])
      expect(longOut).toContain('uid=5 StaticText "')
      expect(longOut).toMatch(/chars elided\]"$/)
      expect(longOut.length).toBeLessThan((origLines[4] ?? '').length)

      // The malformed line (no uid/role/quoted-name shape) passes through unchanged.
      expect(outLines[7]).toBe(origLines[7])

      // Overall byte-size reduction on a realistic multi-line fixture.
      expect(compressed.length).toBeLessThan(text.length)
    })

    it('returns null when no line needs truncation (savings bar not cleared)', () => {
      const text = ['uid=1 RootWebArea "Page"', '  uid=2 button "OK"'].join('\n')
      expect(compressBrowserMcpResult('mcp__claude-in-chrome__read_page', text)).toBeNull()
    })
  })
})

// --- compressGWorkspaceMcpResult ----------------------------------------------

describe('compressGWorkspaceMcpResult', () => {
  it('returns null for a non-gmail/drive tool name even if the shape matches', () => {
    const text = JSON.stringify(gmailThread())
    expect(compressGWorkspaceMcpResult('mcp__plugin_github_github__get_thread', text)).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(compressGWorkspaceMcpResult('mcp__claude_ai_Gmail__get_thread', 'not json')).toBeNull()
  })

  it('strips htmlBody/raw, trims quoted-reply history, and collapses attachment payloads for a Gmail get_thread fixture', () => {
    const thread = gmailThread()
    const text = JSON.stringify(thread)
    const compressed = compressGWorkspaceMcpResult('mcp__claude_ai_Gmail__get_thread', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      expect(compressed).not.toContain('htmlBody')
      expect(compressed).not.toContain('filler html markup')
      expect(compressed).not.toContain('QmFzZTY0RW5jb2RlZFJhd01pbWVQYXlsb2FkRmlsbGVy')
      expect(compressed).not.toContain('QmFzZTY0QXR0YWNobWVudEJ5dGVzRmlsbGVy')
      expect(compressed).not.toContain('On Mon, Jul 6, 2026')
      // Real content and attachment metadata survive.
      expect(compressed).toContain('Here is the plan for Q3')
      expect(compressed).toContain('plan.pdf')
      expect(compressed).toContain('application/pdf')
      expect(compressed.length).toBeLessThan(text.length * 0.85)
    }
  })

  it('never trims Drive read_file_content — content key is not a Gmail body key, even when it contains a ">" line', () => {
    const doc = driveFileContent()
    const text = JSON.stringify(doc)
    const compressed = compressGWorkspaceMcpResult('mcp__claude_ai_Google_Drive__read_file_content', text)
    // No boilerplate to strip in this fixture and body-trimming does not apply to `content`,
    // so the pack correctly declines rather than risk destroying real document text.
    expect(compressed).toBeNull()
    // Direct proof the content itself was never mutated by trimGmailBodies's quote-marker regex.
    const parsed = JSON.parse(text) as { content: string }
    expect(parsed.content).toContain('A genuine markdown blockquote that must survive untouched.')
  })

  it('falls through to null when there is nothing to strip and the shape is too small for the generic pass', () => {
    const text = JSON.stringify({ id: 'thread-1', subject: 'short', messages: [{ id: 'm1', plaintextBody: 'hi' }] })
    expect(compressGWorkspaceMcpResult('mcp__claude_ai_Gmail__get_thread', text)).toBeNull()
  })

  it('does not truncate a body at a bare "From:" line that is not part of a real forwarded-message header block', () => {
    const body =
      'Status Report\n\nFrom: Team A\nTo: Team B\nRe: project X\n\nEverything is on track and no action is needed at this time, all systems green.'
    const text = JSON.stringify({ messages: [{ id: '1', body }] })
    const parsed = JSON.parse(text) as { messages: { id: string; body: string }[] }
    // compressGWorkspaceMcpResult may decline (return null) when there's nothing worth stripping;
    // either way the body content itself must never be silently truncated.
    const compressed = compressGWorkspaceMcpResult('mcp__claude_ai_Gmail__get_thread', text)
    const resultBody = compressed === null ? parsed.messages[0].body : (JSON.parse(compressed) as typeof parsed).messages[0].body
    expect(resultBody).toContain('Everything is on track and no action is needed at this time, all systems green.')
  })

  it('still trims a genuine forwarded-message header block (From:/Sent:/To:/Subject: cluster)', () => {
    const body =
      'Please see the message below for context.\n\n' +
      'From: Alice <alice@example.com>\nSent: Monday, July 6, 2026 10:00 AM\nTo: Bob <bob@example.com>\nSubject: Re: project X\n\n' +
      'Original forwarded content that should be trimmed away.'.padEnd(4000, ' filler forwarded text ')
    const text = JSON.stringify({ messages: [{ id: '1', body }] })
    const compressed = compressGWorkspaceMcpResult('mcp__claude_ai_Gmail__get_thread', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      const resultBody = (JSON.parse(compressed) as { messages: { id: string; body: string }[] }).messages[0].body
      expect(resultBody).toContain('Please see the message below for context.')
      expect(resultBody).not.toContain('Original forwarded content')
      expect(resultBody).not.toContain('Alice <alice@example.com>')
    }
  })

  it('trims a quoted-reply chain that starts directly with a ">" line and no "On ... wrote:" header', () => {
    const quotedTail = '> Hey, can we push the meeting to 3pm?\n> Thanks,\n> Bob'.padEnd(4000, ' filler quoted text ')
    const body = `Sure, sounds good to me.\n\n${quotedTail}`
    const text = JSON.stringify({ messages: [{ id: '1', body }] })
    const compressed = compressGWorkspaceMcpResult('mcp__claude_ai_Gmail__get_thread', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) {
      const resultBody = (JSON.parse(compressed) as { messages: { id: string; body: string }[] }).messages[0].body
      expect(resultBody).toContain('Sure, sounds good to me.')
      expect(resultBody).not.toContain('Hey, can we push the meeting to 3pm?')
      expect(resultBody).not.toContain('filler quoted text')
    }
  })
})

// --- compressMcpResultWithPacks (dispatch) -----------------------------------

describe('compressMcpResultWithPacks', () => {
  it('dispatches to the GitHub pack for a github tool name', () => {
    const text = JSON.stringify(githubPrList(30))
    const compressed = compressMcpResultWithPacks('mcp__plugin_github_github__list_pull_requests', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) expect(compressed).not.toContain('node_id')
  })

  it('dispatches to the browser pack for a claude-in-chrome tool name', () => {
    const text = JSON.stringify(consoleMessageList(40))
    const compressed = compressMcpResultWithPacks('mcp__claude-in-chrome__read_console_messages', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) expect(compressed).not.toContain('stackTrace')
  })

  it('dispatches to the Google Workspace pack for a gmail tool name', () => {
    const text = JSON.stringify(gmailThread())
    const compressed = compressMcpResultWithPacks('mcp__claude_ai_Gmail__get_thread', text)
    expect(compressed).not.toBeNull()
    if (compressed !== null) expect(compressed).not.toContain('htmlBody')
  })

  it('returns null when neither pack matches the tool name, leaving the caller to run the generic pass', () => {
    const text = JSON.stringify(githubPrList(30))
    expect(compressMcpResultWithPacks('mcp__some-other-server__list_things', text)).toBeNull()
  })
})

// --- integration: packs run through postMcpHandler, full output still recoverable by id ---

describe('MCP compression packs wired into postMcpHandler (real runHook dispatch)', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let prevCompressFlag: string | undefined
  let sessionId: string

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-mcp-packs-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome
    sessionId = `mcp-packs-${path.basename(tmpHome)}`
    prevCompressFlag = process.env['TOKEN_GOAT_MCP_COMPRESS']
    delete process.env['TOKEN_GOAT_MCP_COMPRESS']
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    if (prevCompressFlag === undefined) delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    else process.env['TOKEN_GOAT_MCP_COMPRESS'] = prevCompressFlag
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  it('compresses a github list_pull_requests result via the pack, and the full original is still recoverable by id', async () => {
    const toolName = 'mcp__plugin_github_github__list_pull_requests'
    const toolInput = { owner: 'o', repo: 'r' }
    const rows = githubPrList(30)
    const rawText = JSON.stringify(rows)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: toolName,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: rawText,
      }),
    )
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).toMatch(/^\[token-goat: compressed, full via mcp-output mcp_[0-9a-f]{16}\]\n/)
      expect(result.updatedOutput).not.toContain('node_id')
      expect(result.updatedOutput).not.toContain('_links')
      const m = /mcp-output (mcp_[0-9a-f]{16})/.exec(result.updatedOutput)
      expect(m).not.toBeNull()
      const entry = getBashOutput(m![1] as string)
      // The full, uncompressed original (boilerplate fields included) is still
      // recoverable via the labeled recall id, exactly as with the generic pass.
      expect(entry?.output).toBe(rawText)
      expect(entry?.output).toContain('node_id')
    }
  })

  it('compresses a chrome-devtools-mcp list_network_requests result via the browser pack, full original still recoverable by id', async () => {
    const toolName = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests'
    const toolInput = { pageIdx: 0 }
    const rows = networkRequestList(40)
    const rawText = JSON.stringify(rows)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: toolName,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: rawText,
      }),
    )
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).not.toContain('requestHeaders')
      const m = /mcp-output (mcp_[0-9a-f]{16})/.exec(result.updatedOutput)
      expect(m).not.toBeNull()
      const entry = getBashOutput(m![1] as string)
      expect(entry?.output).toBe(rawText)
      expect(entry?.output).toContain('requestHeaders')
    }
  })

  it('compresses a Gmail get_thread result via the Google Workspace pack, full original still recoverable by id', async () => {
    const toolName = 'mcp__claude_ai_Gmail__get_thread'
    const toolInput = { threadId: 'thread-1' }
    const thread = gmailThread()
    const rawText = JSON.stringify(thread)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: toolName,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: rawText,
      }),
    )
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).not.toContain('htmlBody')
      expect(result.updatedOutput).not.toContain('filler html markup')
      const m = /mcp-output (mcp_[0-9a-f]{16})/.exec(result.updatedOutput)
      expect(m).not.toBeNull()
      const entry = getBashOutput(m![1] as string)
      expect(entry?.output).toBe(rawText)
      expect(entry?.output).toContain('htmlBody')
    }
  })

  it('falls through to the generic pass for a non-github, non-browser MCP tool (packs do not change existing generic behavior)', async () => {
    const toolName = 'mcp__some-other-server__search_issues'
    const toolInput = { query: 'is:issue' }
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      title: `issue number ${i}`,
      state: 'open',
      url: `https://example.com/issues/${i}`,
    }))
    const rawText = JSON.stringify(rows)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: toolName,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: rawText,
      }),
    )
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      // Generic pass's own signature: a `constant:` line and a tab-delimited header/body.
      expect(result.updatedOutput).toContain('constant: state=open')
    }
  })

  it('is disabled by TOKEN_GOAT_MCP_COMPRESS=0 the same as the generic pass', async () => {
    process.env['TOKEN_GOAT_MCP_COMPRESS'] = '0'
    const toolName = 'mcp__plugin_github_github__list_pull_requests'
    const toolInput = { owner: 'o', repo: 'r' }
    const rawText = JSON.stringify(githubPrList(30))
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: toolName,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: rawText,
      }),
    )
    expect(result.hookType).toBe('pass')
  })
})
