// Sinks that no shell reads keep their own quoting with displaySafeText inside; echoedValue is shell quoting and would put an apostrophe-escape or a placeholder where the harness, a traceback reader, a JSON parser or markup expects the plain form.
// Provenance: HAND-DERIVED. The expected strings are the layouts the consumers define: the harness Read tool takes a double-quoted file_path, a Python traceback prints File "<path>", line N, in <fn>, markup quotes an attribute with ", and Node's EISDIR error prints open '<path>'.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { commentFoldNotice } from '../src/fold_delivery.js'
import { formatHtmlOutline, outlineHtml } from '../src/html_query.js'
import { formatXmlOutline, outlineXml } from '../src/xml_query.js'
import { runSemantic } from '../src/read_semantic.js'
import { cmdTrace } from '../src/text_commands.js'
import { PACKAGE_MANAGER_FILTERS, TOOL_FILTERS } from '../src/tool_filters/index.js'

const PATH = "app/routes/o'brien.$id.tsx"

describe('non-shell sinks keep their own quoting', () => {
  it('the comment fold pointer is a double-quoted Read path, not a shell-quoted one', () => {
    const notice = commentFoldNotice(10, 20, PATH)
    expect(notice).toContain(`Read "${PATH}" with offset=10, limit=11`)
    expect(notice).not.toContain("'\\''")
  })

  it('a DepListFilter trailer fences a real command and leaves the prose label bare', () => {
    const filter = [...TOOL_FILTERS, ...PACKAGE_MANAGER_FILTERS].find((f) => f.name === 'dep-list')!
    const out = Array.from({ length: 50 }, (_, i) => `pkg${i}==1.0`).join('\n')
    expect(filter.apply(out, '', 0, ['pip', 'freeze']).text).toContain('use `pip freeze` to see full output')
    expect(filter.apply(out, '', 0, []).text).toContain('use the original command to see full output')
    expect(filter.apply(out, '', 0, []).text).not.toContain('"the original command"')
  })

  it('the --json error of semantic holds plain text that the JSON writer escapes, not shell quotes', async () => {
    const json = await runSemantic('q', { limit: 0, json: true })
    expect(JSON.parse(json.text).error).toBe('--limit must be a positive number, got: 0')
    const human = await runSemantic('q', { limit: 0 })
    expect(human.text).toBe('--limit must be a positive number, got: "0"')
    const bad = await runSemantic('q', { projectRoot: "rel'ative", json: true })
    expect(JSON.parse(bad.text).error).toBe("projectRoot must be an absolute, existing directory, got rel'ative")
  })

  it('an XML outline writes an attribute as name="value" and the HTML outline quotes a form attribute the same way', () => {
    const xml = formatXmlOutline(outlineXml(`<r><item id="o'brien $1"/></r>`))
    expect(xml).toContain('id="o&apos;brien $1"')
    const html = formatHtmlOutline(outlineHtml(`<form method="post" action="/it's$x"><input name="a"></form>`))
    expect(html).toContain(`method="post" action="/it's$x"`)
  })
})

describe('a traceback frame keeps the Python layout', () => {
  let root: string
  let origCwd: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-nonshell-'))
    origCwd = process.cwd()
    process.chdir(root)
  })
  afterEach(() => {
    process.chdir(origCwd)
    rmSync(root, { recursive: true, force: true })
  })

  it('prints File "<path>", line N, in <fn> with the path as it is', () => {
    const dir = join(root, "o'brien$app")
    mkdirSync(dir)
    const mod = join(dir, 'm.py')
    writeFileSync(mod, 'def f():\n    return 1\n')
    const tb = join(root, 'tb.txt')
    writeFileSync(tb, ['Traceback (most recent call last):', `  File "${mod}", line 2, in f`, '    return 1', 'ValueError: x', ''].join('\n'))
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    let out: string
    try {
      cmdTrace(tb, {})
      out = spy.mock.calls.map((c) => String(c[0])).join('')
    } finally {
      spy.mockRestore()
    }
    expect(out).toContain(`File "${mod}", line 2, in f`)
  })
})

describe('write-file into a directory', () => {
  it("names the directory quoted, so an apostrophe in it cannot end the quotes", async () => {
    const { cmdWriteFile } = await import('../src/cli_file_ops.js')
    const root = mkdtempSync(join(tmpdir(), 'tg-nonshell-wf-'))
    try {
      const dir = join(root, "d'ir")
      mkdirSync(dir)
      let message = ''
      try {
        await cmdWriteFile(dir, { b64: 'aGk=' })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).toContain('destination is a directory, not a file: "')
      expect(message).toContain("d'ir")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
