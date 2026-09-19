import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { runRead, runSymbol } from '../src/read_commands.js'
import { runSection } from '../src/read_section.js'

// HAND-DERIVED: shape of a classic dashboard template, from a user report. `chart1-panel` is a
// plain `<section id="...">`, not a heading, so it exercises the html_id (not heading) lookup path.
const TEMPLATE = [
  '<!doctype html>',
  '<html>',
  '<body>',
  '  <section id="chart1-panel" class="panel">',
  '    <h2>Chart 1</h2>',
  '    <canvas id="chart1"></canvas>',
  '  </section>',
  '</body>',
  '</html>',
].join('\n')

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-html-id-lookup-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('html_id lookup boundary (#id spelling, and section falling back to it)', () => {
  it('resolves a real (non-heading) html_id element by its bare name and by its "#id" spelling, in read/section/symbol alike', () => {
    const file = path.join(TMP, 'dashboard_template.html')
    fs.writeFileSync(file, TEMPLATE)
    indexFileSync(file)

    const bareRead = runRead({ spec: `${file}::chart1-panel` })
    expect(bareRead.code).toBe(0)
    expect(bareRead.text).toContain('<section id="chart1-panel"')
    expect(bareRead.text).toContain('</section>')

    const hashRead = runRead({ spec: `${file}::#chart1-panel` })
    expect(hashRead.code).toBe(0)
    expect(hashRead.text).toBe(bareRead.text)

    const hashSymbol = runSymbol({ name: '#chart1-panel', file })
    expect(hashSymbol.code).toBe(0)
    expect(hashSymbol.text).toContain('chart1-panel')

    const bareSection = runSection({ spec: `${file}::chart1-panel` })
    expect(bareSection.code).toBe(0)
    expect(bareSection.text).toContain('<section id="chart1-panel"')
    expect(bareSection.text).toContain('</section>')

    const hashSection = runSection({ spec: `${file}::#chart1-panel` })
    expect(hashSection.code).toBe(0)
    expect(hashSection.text).toBe(bareSection.text)
  })
})
