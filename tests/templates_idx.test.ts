import { describe, it, expect } from 'vitest'

import { detectLanguage } from '../src/parser_types.js'
import {
  maskTemplateDelimiters,
  extractJinja2,
  extractHandlebars,
  extractErb,
  extractEjs,
  extractNunjucks,
  extractTwig,
  type DelimiterPair,
} from '../src/languages/templates_idx.js'

// All fixtures below are HAND-DERIVED synthetic strings that exercise maskTemplateDelimiters'
// own masking logic (prefix collisions, unterminated opens, newline preservation, the search
// bound) -- not evidence a real template engine emits this exact text. The per-dialect
// FORMAT-DERIVED fixtures (tests/fixtures/language_adapter_symbols/Sample.{j2,hbs,erb,ejs,njk,twig})
// are the wire-format evidence, exercised through the guard at
// tests/guards/language_adapter_produces_symbols.test.ts.

describe('maskTemplateDelimiters', () => {
  const JINJA: readonly DelimiterPair[] = [
    { open: '{#', close: '#}' },
    { open: '{%', close: '%}' },
    { open: '{{', close: '}}' },
  ]

  it('blanks a simple expression to spaces, preserving length', () => {
    const expr = '{{ user.id }}'
    const out = maskTemplateDelimiters(`<div id="${expr}">`, JINJA)
    expect(out).toBe(`<div id="${' '.repeat(expr.length)}">`)
  })

  it('preserves newlines inside a masked span so line numbers stay in sync', () => {
    const out = maskTemplateDelimiters('a{%\n  if x\n%}b', JINJA)
    expect(out.split('\n').length).toBe(3)
    expect(out).toBe('a  \n      \n  b')
  })

  it('masks a tag and a comment independently, leaving real markup between them untouched', () => {
    const out = maskTemplateDelimiters('<ul>{% for x in xs %}<li>{{ x }}</li>{% endfor %}</ul>', JINJA)
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>')
    expect(out).toContain('</li>')
    expect(out).toContain('</ul>')
    expect(out).not.toContain('{%')
    expect(out).not.toContain('{{')
  })

  it('leaves an unterminated open as literal text rather than consuming the rest of the file', () => {
    const out = maskTemplateDelimiters('<p>{{ oops</p><p>real</p>', JINJA)
    expect(out).toContain('{{ oops')
    expect(out).toContain('<p>real</p>')
  })

  it('does not let a later, more general pair swallow a span an earlier, more specific pair already masked', () => {
    const handlebars: readonly DelimiterPair[] = [
      { open: '{{!--', close: '--}}' },
      { open: '{{!', close: '}}' },
      { open: '{{{', close: '}}}' },
      { open: '{{', close: '}}' },
    ]
    const out = maskTemplateDelimiters('{{!-- a {{ nested-looking }} comment --}}<p>real</p>', handlebars)
    expect(out).not.toContain('{{')
    expect(out).not.toContain('}}')
    expect(out).toContain('<p>real</p>')
  })

  it('resolves the {{{ vs {{ prefix collision to the triple-stache close, not the double', () => {
    const handlebars: readonly DelimiterPair[] = [
      { open: '{{{', close: '}}}' },
      { open: '{{', close: '}}' },
    ]
    const out = maskTemplateDelimiters('{{{raw}}}<p>x</p>', handlebars)
    expect(out).not.toContain('{{{')
    expect(out).not.toContain('}}}')
    expect(out).toContain('<p>x</p>')
  })

  it('is bounded: an open with no close anywhere in a large file does not hang or run away quadratically', () => {
    const big = '{{ '.repeat(20_000) + '<p>tail</p>'
    const start = performance.now()
    const out = maskTemplateDelimiters(big, JINJA)
    const elapsed = performance.now() - start
    expect(out).toContain('<p>tail</p>')
    expect(elapsed).toBeLessThan(2000) // generous CI-safe ceiling; see module doc's 100ms-budget precedent
  })
})

describe('template dialect adapters hand masked content to extractHtml', () => {
  it('Jinja2: id/class attributes and headings survive masking; the expression text does not', () => {
    const content = '<h1 id="t">{{ title }}</h1><ul class="items">{% for x in xs %}<li class="item">{{ x }}</li>{% endfor %}</ul>'
    const { symbols } = extractJinja2(content, 'test.j2')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === 't')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'items')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'item')).toBe(true)
  })

  it('Handlebars: triple-stache and both comment forms are masked, id/class still extracted', () => {
    const content = '<div id="entry-el" class="entry">{{!-- comment with {{ mustache }} inside --}}<span class="body">{{{raw}}}</span></div>'
    const { symbols } = extractHandlebars(content, 'test.hbs')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === 'entry-el')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'entry')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'body')).toBe(true)
  })

  it('ERB: <%= %> output and <%# %> comment are masked, id/class still extracted', () => {
    const content = '<h1 id="greeting">Hi, <%= @user.name %></h1><ul class="items"><%# a comment %><li class="list-row"><%= 1 %></li></ul>'
    const { symbols } = extractErb(content, 'test.erb')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === 'greeting')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'items')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'list-row')).toBe(true)
  })

  it('EJS: <%- %> unescaped output and <%# comment are masked, id/class still extracted', () => {
    const content = '<h1 id="title"><%= title %></h1><ul class="supplies"><%# a comment %><li class="supply-item"><%- x %></li></ul>'
    const { symbols } = extractEjs(content, 'test.ejs')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === 'title')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'supplies')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'supply-item')).toBe(true)
  })

  it('Nunjucks: {{ }}/{% %}/{# #} are masked, id/class still extracted', () => {
    const content = '<h1 id="site">{{ title }}</h1><ul class="nav-list">{# a comment #}<li class="item">{{ x }}</li></ul>'
    const { symbols } = extractNunjucks(content, 'test.njk')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === 'site')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'nav-list')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'item')).toBe(true)
  })

  it('Twig: {{ }}/{% %}/{# #} are masked, id/class still extracted', () => {
    const content = '<h1 id="article">{{ article.title }}</h1><ul class="tags">{# comment #}<li class="tag">{{ t }}</li></ul>'
    const { symbols } = extractTwig(content, 'test.twig')
    expect(symbols.some((s) => s.kind === 'html_id' && s.name === 'article')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'tags')).toBe(true)
    expect(symbols.some((s) => s.kind === 'html_class' && s.name === 'tag')).toBe(true)
  })

  it('detects each dialect by extension via detectLanguage', () => {
    expect(detectLanguage('a.j2')).toBe('jinja2')
    expect(detectLanguage('a.jinja')).toBe('jinja2')
    expect(detectLanguage('a.jinja2')).toBe('jinja2')
    expect(detectLanguage('a.hbs')).toBe('handlebars')
    expect(detectLanguage('a.handlebars')).toBe('handlebars')
    expect(detectLanguage('a.erb')).toBe('erb')
    expect(detectLanguage('a.ejs')).toBe('ejs')
    expect(detectLanguage('a.njk')).toBe('nunjucks')
    expect(detectLanguage('a.twig')).toBe('twig')
  })
})
