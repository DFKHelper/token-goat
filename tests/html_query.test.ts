import { describe, expect, it } from 'vitest'
import {
  parseHtml,
  queryHtml,
  outlineHtml,
  formatHtmlOutline,
  lintHtml,
  serializeHtmlNode,
  extractNodeText,
} from '../src/html_query.js'

describe('HTML5 Parser (parseHtml)', () => {
  it('parses basic nested tags, attributes, and text nodes', () => {
    const html = '<div id="container" class="main-wrap"><p>Hello <strong>World</strong></p></div>'
    const { root, issues } = parseHtml(html)
    expect(issues).toHaveLength(0)
    expect(root.children).toHaveLength(1)

    const div = root.children[0]!
    expect(div.tag).toBe('div')
    expect(div.attributes['id']).toBe('container')
    expect(div.attributes['class']).toBe('main-wrap')
    expect(div.children).toHaveLength(1)

    const p = div.children[0]!
    expect(p.tag).toBe('p')
    expect(p.children).toHaveLength(1)
    expect(p.children[0]!.tag).toBe('strong')
    expect(p.children[0]!.text).toBe('World')
  })

  it('handles HTML5 void tags without breaking nesting hierarchy', () => {
    const html = `
      <form action="/login" method="POST">
        <label>Email</label>
        <input type="email" name="email" required>
        <br>
        <label>Password</label>
        <input type="password" name="password">
        <hr>
        <button type="submit">Log in</button>
      </form>
    `
    const { root, issues } = parseHtml(html)
    expect(issues).toHaveLength(0)
    const form = root.children[0]!
    expect(form.tag).toBe('form')
    // Children of form should contain input, br, hr, button, etc., directly as siblings
    const tags = form.children.map((c) => c.tag)
    expect(tags).toEqual(['label', 'input', 'br', 'label', 'input', 'hr', 'button'])
  })

  it('treats script and style contents as raw text even with angle brackets', () => {
    const html = `
      <div>
        <script>
          if (x < 10 && y > 20) {
            console.log("<div>not a tag</div>");
          }
        </script>
        <p>After script</p>
      </div>
    `
    const { root, issues } = parseHtml(html)
    expect(issues).toHaveLength(0)
    const div = root.children[0]!
    expect(div.children).toHaveLength(2)
    const script = div.children[0]!
    expect(script.tag).toBe('script')
    expect(script.text).toContain('if (x < 10 && y > 20)')
    expect(script.children).toHaveLength(0) // does not parse inner <div> as child

    const p = div.children[1]!
    expect(p.tag).toBe('p')
    expect(p.text).toBe('After script')
  })

  it('ignores comments and DOCTYPE declarations', () => {
    const html = `
      <!DOCTYPE html>
      <!-- This is a comment with <div>inner</div> -->
      <html><body><h1>Title</h1></body></html>
    `
    const { root, issues } = parseHtml(html)
    expect(issues).toHaveLength(0)
    expect(root.children).toHaveLength(1)
    expect(root.children[0]!.tag).toBe('html')
  })
})

describe('CSS Selector Engine (queryHtml)', () => {
  const sample = `
    <!DOCTYPE html>
    <html>
      <head><title>Test Page</title></head>
      <body>
        <div id="main" class="container dark">
          <header>
            <h1 class="heading">Enterprise Title</h1>
            <nav id="nav-bar">
              <a href="/home" class="nav-link active">Home</a>
              <a href="/docs" class="nav-link">Docs</a>
              <a href="https://github.com" target="_blank" class="nav-link external">GitHub</a>
            </nav>
          </header>
          <main>
            <section id="sec-1" class="panel" data-role="admin">
              <h2>Section 1</h2>
              <p class="desc">First paragraph text</p>
            </section>
            <section id="sec-2" class="panel" data-role="user">
              <h2>Section 2</h2>
              <p class="desc">Second paragraph text</p>
            </section>
          </main>
        </div>
      </body>
    </html>
  `

  it('matches by ID selector (#id)', () => {
    const res = queryHtml(sample, '#sec-1')
    expect(res.elements).toHaveLength(1)
    expect(res.elements[0]!.tag).toBe('section')
    expect(res.elements[0]!.attributes['id']).toBe('sec-1')
  })

  it('matches by class selector (.class)', () => {
    const res = queryHtml(sample, '.panel')
    expect(res.elements).toHaveLength(2)
    expect(res.elements[0]!.attributes['id']).toBe('sec-1')
    expect(res.elements[1]!.attributes['id']).toBe('sec-2')
  })

  it('matches compound selectors (tag#id, tag.class)', () => {
    const res1 = queryHtml(sample, 'div#main')
    expect(res1.elements).toHaveLength(1)

    const res2 = queryHtml(sample, 'a.external')
    expect(res2.elements).toHaveLength(1)
    expect(res2.elements[0]!.text).toBe('GitHub')
  })

  it('matches descendant combinators (ancestor descendant)', () => {
    const res = queryHtml(sample, '#main h2')
    expect(res.elements).toHaveLength(2)
    expect(res.elements[0]!.text).toBe('Section 1')
    expect(res.elements[1]!.text).toBe('Section 2')
  })

  it('matches child combinators (parent > child)', () => {
    const res = queryHtml(sample, 'nav > a')
    expect(res.elements).toHaveLength(3)
  })

  it('matches attribute selectors ([attr], [attr=val], [attr^=val])', () => {
    const res1 = queryHtml(sample, '[data-role="admin"]')
    expect(res1.elements).toHaveLength(1)
    expect(res1.elements[0]!.attributes['id']).toBe('sec-1')

    const res2 = queryHtml(sample, 'a[href^="https"]')
    expect(res2.elements).toHaveLength(1)
    expect(res2.elements[0]!.text).toBe('GitHub')

    const res3 = queryHtml(sample, 'a[target]')
    expect(res3.elements).toHaveLength(1)
  })

  it('supports comma-separated union selectors', () => {
    const res = queryHtml(sample, 'h1, h2')
    expect(res.elements).toHaveLength(3)
  })

  it('projects attribute values directly via @attr syntax', () => {
    const res = queryHtml(sample, 'nav a@href')
    expect(res.attributeValues).toEqual(['/home', '/docs', 'https://github.com'])
  })

  it('serializes matched node back to clean HTML markup', () => {
    const res = queryHtml(sample, '#sec-1')
    const markup = serializeHtmlNode(res.elements[0]!)
    expect(markup).toContain('<section id="sec-1" class="panel" data-role="admin">')
    expect(markup).toContain('<h2>Section 1</h2>')
    expect(markup).toContain('</section>')
  })

  it('matches attribute selectors with spaces in values', () => {
    const html = `
      <div id="wrap">
        <button title="Click to submit form" data-action="save draft">Save</button>
        <button title="Cancel action" data-action="cancel">Cancel</button>
      </div>
    `
    const res1 = queryHtml(html, '[title="Click to submit form"]')
    expect(res1.elements).toHaveLength(1)
    expect(res1.elements[0]!.attributes['data-action']).toBe('save draft')

    const res2 = queryHtml(html, 'button[data-action="save draft"]')
    expect(res2.elements).toHaveLength(1)
  })

  it('matches compound selectors with chained classes, ids, and multiple attributes', () => {
    const html = `
      <div class="card premium highlight" id="card-1">First</div>
      <div class="card standard" id="card-2">Second</div>
      <input type="text" name="user" class="input primary" required disabled>
    `
    const res1 = queryHtml(html, 'div.card.premium.highlight#card-1')
    expect(res1.elements).toHaveLength(1)
    expect(res1.elements[0]!.attributes['id']).toBe('card-1')

    const res2 = queryHtml(html, '.card.highlight')
    expect(res2.elements).toHaveLength(1)

    const res3 = queryHtml(html, 'input[type="text"][required][disabled]')
    expect(res3.elements).toHaveLength(1)
    expect(res3.elements[0]!.attributes['name']).toBe('user')
  })

  it('preserves mixed content and extracts in-order readable text', () => {
    const html = '<div id="post"><p>Hello <b>bold</b> and <i>italic</i> world! &amp; welcome.</p></div>'
    const res = queryHtml(html, 'p')
    expect(res.elements).toHaveLength(1)
    const p = res.elements[0]!

    // Exact verbatim markup slice from sourceHtml
    const markup = serializeHtmlNode(p, 0, res.sourceHtml)
    expect(markup).toBe('<p>Hello <b>bold</b> and <i>italic</i> world! &amp; welcome.</p>')

    // Readable in-order extracted text
    const text = extractNodeText(p, res.sourceHtml)
    expect(text).toBe('Hello bold and italic world! & welcome.')
  })

  it('scans raw text tags case-insensitively and without allocation overhead', () => {
    const html = `
      <div id="app">
        <SCRIPT type="text/javascript">
          const code = "<p>not a real tag</p>";
        </Script>
        <style>
          .foo > .bar { color: red; }
        </STYLE>
        <span>Content</span>
      </div>
    `
    const { root, issues } = parseHtml(html)
    expect(issues).toHaveLength(0)
    const app = root.children[0]!
    expect(app.children).toHaveLength(3)
    expect(app.children[0]!.tag).toBe('script')
    expect(app.children[1]!.tag).toBe('style')
    expect(app.children[2]!.tag).toBe('span')
    expect(app.children[2]!.text).toBe('Content')
  })
})

describe('HTML Structural Linter (lintHtml)', () => {
  it('returns valid: true for clean, well-formed HTML', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Valid</title></head>
        <body>
          <div id="wrapper">
            <p>Valid text with <a href="#">link</a>.</p>
            <img src="test.png" alt="img">
          </div>
        </body>
      </html>
    `
    const res = lintHtml(html)
    expect(res.valid).toBe(true)
    expect(res.errors).toHaveLength(0)
    expect(res.warnings).toHaveLength(0)
  })

  it('detects unclosed tags and pinpoint line numbers', () => {
    const html = `
      <div id="outer">
        <p>Unclosed paragraph
        <span>Closed span</span>
      </div>
    `
    const res = lintHtml(html)
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.rule === 'unclosed-tag' && e.message.includes('<p>'))).toBe(true)
  })

  it('detects stray/unexpected closing tags', () => {
    const html = `
      <div>
        <p>Text</p>
        </div>
      </div>
    `
    const res = lintHtml(html)
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.rule === 'stray-closing-tag')).toBe(true)
  })

  it('detects duplicate IDs across elements', () => {
    const html = `
      <div id="duplicate-me">First</div>
      <div id="duplicate-me">Second</div>
    `
    const res = lintHtml(html)
    expect(res.valid).toBe(false)
    expect(res.errors.some((e) => e.rule === 'duplicate-id' && e.message.includes('#duplicate-me'))).toBe(true)
  })

  it('reports tag open vs close balancing counts', () => {
    const html = `
      <div>
        <div>
          <p>Text</p>
        </div>
    `
    const res = lintHtml(html)
    expect(res.tagCounts['div']).toBeDefined()
    expect(res.tagCounts['div']!.open).toBe(2)
    expect(res.tagCounts['div']!.close).toBe(1)
    expect(res.tagCounts['div']!.diff).toBe(1)
  })
})

describe('HTML Outliner (outlineHtml & formatHtmlOutline)', () => {
  it('extracts structural overview including title, landmarks, headings, tables, forms', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Architecture Review</title>
          <style>body { margin: 0; }</style>
        </head>
        <body>
          <header><nav id="main-nav">Navigation</nav></header>
          <main>
            <h1>System Overview</h1>
            <p>Intro</p>
            <h2>Component Details</h2>
            <table id="metrics-table">
              <thead><tr><th>A</th><th>B</th></tr></thead>
              <tbody>
                <tr><td>1</td><td>2</td></tr>
                <tr><td>3</td><td>4</td></tr>
              </tbody>
            </table>
            <form id="contact-form" action="/api/submit" method="POST">
              <input name="email">
            </form>
          </main>
          <script src="bundle.js"></script>
        </body>
      </html>
    `
    const summary = outlineHtml(html)
    expect(summary.title).toBe('Architecture Review')
    expect(summary.doctype).toBe('html')
    expect(summary.headings).toHaveLength(2)
    expect(summary.headings[0]!.text).toBe('System Overview')
    expect(summary.tables).toHaveLength(1)
    expect(summary.tables[0]!.id).toBe('metrics-table')
    expect(summary.tables[0]!.rows).toBe(3)
    expect(summary.forms).toHaveLength(1)
    expect(summary.forms[0]!.id).toBe('contact-form')
    expect(summary.scripts).toBe(1)
    expect(summary.styles).toBe(1)

    const formatted = formatHtmlOutline(summary)
    expect(formatted).toContain('Title: "Architecture Review"')
    expect(formatted).toContain('[h1] System Overview')
    expect(formatted).toContain('[h2] Component Details')
    expect(formatted).toContain('<table#metrics-table>')
    expect(formatted).toContain('<form#contact-form')
  })
})
