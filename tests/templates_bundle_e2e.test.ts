/**
 * Built-bundle check for the six template adapters (Jinja2, Handlebars, ERB, EJS, Nunjucks,
 * Twig): the shipped dist/token-goat.mjs, not source, indexes a small project with one file per
 * dialect and answers `outline`, `symbol` and `read` from it. This is the only test that proves
 * the delimiter-masking-then-HTML-handoff adapter survived bundling and is reached from the real
 * CLI path, matching tests/vhdl_bundle_e2e.test.ts's shape for the tree-sitter-free adapters.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-templates-bundle-'))
  project = path.join(root, 'project')
  const home = path.join(root, 'home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  env = {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(root, 'tg-home'),
    LOCALAPPDATA: path.join(root, 'data'),
    XDG_DATA_HOME: path.join(root, 'data'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
  }
  // HAND-DERIVED: minimal Jinja2 template mixing {{ }}/{%  %}/{# #} per https://jinja.palletsprojects.com/en/stable/templates/
  fs.writeFileSync(
    project + '/Page.j2',
    '<html>\n<body>\n<h1 id="hero-heading">{{ heading }}</h1>\n{# a comment #}\n<ul class="hero-list">\n{% for item in items %}\n<li class="hero-item">{{ item }}</li>\n{% endfor %}\n</ul>\n</body>\n</html>\n',
  )
  // HAND-DERIVED: minimal Handlebars template covering {{{ }}}, {{! }} and {{ }} per https://handlebarsjs.com/guide/
  fs.writeFileSync(
    project + '/Card.hbs',
    '<div id="card-root" class="card">\n{{! a comment }}\n<h1 id="card-title">{{title}}</h1>\n<div class="card-body">{{{body}}}</div>\n</div>\n',
  )
  // HAND-DERIVED: minimal ERB covering <%= %> and <%# %> per https://docs.ruby-lang.org/en/master/ERB.html
  fs.writeFileSync(
    project + '/View.erb',
    '<h1 id="erb-heading">Hi, <%= @user.name %></h1>\n<ul class="erb-list">\n<%# a comment %>\n<li class="erb-item"><%= 1 %></li>\n</ul>\n',
  )
  // HAND-DERIVED: minimal EJS covering <%= %>, <%- %> and <%# %> per https://ejs.co/#docs
  fs.writeFileSync(
    project + '/Page.ejs',
    '<h1 id="ejs-heading"><%= title %></h1>\n<ul class="ejs-list">\n<%# a comment %>\n<li class="ejs-item"><%- item %></li>\n</ul>\n',
  )
  // HAND-DERIVED: minimal Nunjucks covering {{ }}, {% %} and {# #} per https://mozilla.github.io/nunjucks/templating.html
  fs.writeFileSync(
    project + '/Page.njk',
    '<h1 id="njk-heading">{{ title }}</h1>\n{# a comment #}\n<ul class="njk-list">\n{% for x in xs %}\n<li class="njk-item">{{ x }}</li>\n{% endfor %}\n</ul>\n',
  )
  // HAND-DERIVED: minimal Twig covering {{ }}, {% %} and {# #} per https://twig.symfony.com/doc/3.x/templates.html
  fs.writeFileSync(
    project + '/Page.twig',
    '<h1 id="twig-heading">{{ article.title }}</h1>\n{# a comment #}\n<ul class="twig-list">\n{% for tag in tags %}\n<li class="twig-item">{{ tag }}</li>\n{% endfor %}\n</ul>\n',
  )
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes the six template dialects', () => {
  it('Jinja2: outlines id/class/heading and reads a class-scoped symbol with the {{ }} masked', () => {
    const outline = tg(['outline', 'Page.j2'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('hero-heading')
    expect(outline.stdout).toContain('hero-list')
    expect(outline.stdout).toContain('hero-item')

    const read = tg(['read', 'Page.j2::hero-item'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('<li class="hero-item">{{ item }}</li>')
  })

  it('Handlebars: masks {{! }} and {{{ }}} while keeping id/class reachable', () => {
    const outline = tg(['outline', 'Card.hbs'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('card-root')
    expect(outline.stdout).toContain('card-title')
    expect(outline.stdout).toContain('card-body')

    const read = tg(['read', 'Card.hbs::card-body'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('{{{body}}}')
  })

  it('ERB: masks <%= %> and <%# %> while keeping id/class reachable', () => {
    const outline = tg(['outline', 'View.erb'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('erb-heading')
    expect(outline.stdout).toContain('erb-list')
    expect(outline.stdout).toContain('erb-item')

    const read = tg(['read', 'View.erb::erb-item'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('<%= 1 %>')
  })

  it('EJS: masks <%= %>, <%- %> and <%# %> while keeping id/class reachable', () => {
    const outline = tg(['outline', 'Page.ejs'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('ejs-heading')
    expect(outline.stdout).toContain('ejs-list')
    expect(outline.stdout).toContain('ejs-item')

    const read = tg(['read', 'Page.ejs::ejs-item'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('<%- item %>')
  })

  it('Nunjucks: masks {{ }}, {% %} and {# #} while keeping id/class reachable', () => {
    const outline = tg(['outline', 'Page.njk'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('njk-heading')
    expect(outline.stdout).toContain('njk-list')
    expect(outline.stdout).toContain('njk-item')

    const read = tg(['read', 'Page.njk::njk-item'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('<li class="njk-item">{{ x }}</li>')
  })

  it('Twig: masks {{ }}, {% %} and {# #} while keeping id/class reachable', () => {
    const outline = tg(['outline', 'Page.twig'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('twig-heading')
    expect(outline.stdout).toContain('twig-list')
    expect(outline.stdout).toContain('twig-item')

    const read = tg(['read', 'Page.twig::twig-item'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('<li class="twig-item">{{ tag }}</li>')
  })

  it('resolves a symbol shared across dialects to the right file via symbol', () => {
    const sym = tg(['symbol', 'card-title'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('Card.hbs')
  })
})
