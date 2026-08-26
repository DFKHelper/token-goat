import { describe, it, expect } from 'vitest'

import { detectLanguage } from '../src/parser_types.js'
import { extractVue, extractSvelte, extractAstro } from '../src/languages/sfc_idx.js'

import { parseFixture } from './helpers/parse-fixture.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VUE_CONTENT = `<script setup lang="ts">
import { ref } from 'vue'

// tracks click count
const count = ref(0)

function increment() {
  count.value++
}

class Logger {
  log(msg) {
    console.log(msg)
  }
}
</script>

<template>
  <div class="wrapper">
    <!-- <OldWidget /> should not appear -->
    <MyButton @click="increment">Click {{ count }}</MyButton>
    <my-icon name="star" />
    <button>Plain button</button>
  </div>
</template>

<style scoped>
.wrapper {
  color: red;
}
</style>
`

const SVELTE_CONTENT = `<script context="module">
export const MODULE_CONST = 42
</script>

<script>
  // reactive counter
  let count = 0

  function handleClick() {
    count += 1
  }

  const label = 'clicks: ' + count
</script>

<Header title="Demo" />
<!-- <OldThing /> should not appear -->
<div class="card">
  <sub-widget value={count} />
  <button on:click={handleClick}>Clicks: {count}</button>
</div>

<style>
  .card {
    padding: 1rem;
  }
</style>
`

const ASTRO_CONTENT = `---
import Layout from '../layouts/Layout.astro'

const title = 'Home'

function greet(name) {
  return 'hi ' + name
}
---

<Layout title={title}>
  <!-- <OldHero /> should not appear -->
  <MainHero>{greet('world')}</MainHero>
  <p>Not a component</p>
</Layout>

<style>
  p {
    color: blue;
  }
</style>
`

// A `---` pair that is NOT the file's very first content -- must not be misdetected as
// frontmatter. The leading markup and trailing `<Widget />` prove the file is parsed as plain
// markup throughout, not split at the mid-file `---` lines.
const ASTRO_NOT_FRONTMATTER = `<div>
  text
</div>
---
this is not frontmatter, just markup
---
<Widget />
`

// Frontmatter whose own script contains a multi-line backtick template literal with a
// `---`-only line inside it (line 3), followed by the REAL closing fence (line 5) and a
// declaration + markup ref that only survive if the real fence, not the fake one, is found.
// Regression: detectAstroFrontmatter's naive line-exact `=== '---'` scan had no string/template
// awareness and would misdetect the template literal's inner `---` line as the closing fence,
// truncating the frontmatter parse (and the `title` const, greet declaration) before it ever
// reached the real close.
const ASTRO_TEMPLATE_LITERAL_DASHES = `---
const sep = \`
---
\`
const title = 'Home'
---

<Layout title={title}>
  <MainHero>hi</MainHero>
</Layout>
`

// ---------------------------------------------------------------------------
// detectLanguage / EXTENSION_LANGUAGE wiring
// ---------------------------------------------------------------------------

describe('detectLanguage for SFC extensions', () => {
  it('recognizes .vue, .svelte, and .astro', () => {
    expect(detectLanguage('foo.vue')).toBe('vue')
    expect(detectLanguage('foo.svelte')).toBe('svelte')
    expect(detectLanguage('foo.astro')).toBe('astro')
  })
})

// ---------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------

describe('vue adapter', () => {
  it('extracts the component symbol, top-level script declarations, and template component refs', () => {
    const { symbols, refs } = extractVue(VUE_CONTENT, 'MyButtonPanel.vue')

    const component = symbols.find((s) => s.kind === 'vue_component')
    // 31 is the fixture's real length. The 32 this asserted before counted the
    // empty piece the closing newline leaves behind when the content is split.
    expect(component).toMatchObject({ name: 'MyButtonPanel', lineStart: 1, lineEnd: 31 })

    const byName = (name: string) => symbols.find((s) => s.name === name)
    expect(byName('count')).toMatchObject({ kind: 'sfc_script_const', lineStart: 5, lineEnd: 5 })
    expect(byName('increment')).toMatchObject({ kind: 'sfc_script_function', lineStart: 7, lineEnd: 7 })
    expect(byName('Logger')).toMatchObject({ kind: 'sfc_script_class', lineStart: 11, lineEnd: 11 })

    // `log` is a method nested inside the Logger class body, not a top-level declaration.
    expect(byName('log')).toBeUndefined()

    const refNames = refs.map((r) => r.name)
    expect(refNames).toContain('MyButton')
    expect(refNames).toContain('my-icon')
    // Plain lowercase, no-hyphen HTML tags are never component refs.
    expect(refNames).not.toContain('div')
    expect(refNames).not.toContain('button')
    // Commented-out markup must not produce a ref.
    expect(refNames).not.toContain('OldWidget')

    const myButtonRef = refs.find((r) => r.name === 'MyButton')
    expect(myButtonRef).toMatchObject({ line: 21 })
    const myIconRef = refs.find((r) => r.name === 'my-icon')
    expect(myIconRef).toMatchObject({ line: 22 })
  })

  it('does not leak <style> block content into script or template extraction', () => {
    const { symbols, refs } = extractVue(VUE_CONTENT, 'MyButtonPanel.vue')
    // `.wrapper` (a CSS class selector, not a JS declaration or a component tag) must not
    // appear as either a script-declaration symbol or a template ref.
    expect(symbols.some((s) => s.name === 'wrapper')).toBe(false)
    expect(refs.some((r) => r.name === 'wrapper')).toBe(false)
  })

  it('returns just the component symbol for an empty/minimal file', () => {
    const { symbols, refs } = extractVue('<template><div></div></template>\n', 'Empty.vue')
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ kind: 'vue_component', name: 'Empty' })
    expect(refs).toHaveLength(0)
  })

  it('indexes a real .vue file end-to-end through parseFile', async () => {
    const result = await parseFixture('Widget.vue', VUE_CONTENT)
    expect(result.language).toBe('vue')
    expect(result.symbols.some((s) => s.kind === 'vue_component' && s.name === 'Widget')).toBe(true)
    expect(result.symbols.some((s) => s.name === 'increment' && s.kind === 'sfc_script_function')).toBe(true)
    expect(result.refs.some((r) => r.name === 'MyButton')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Svelte
// ---------------------------------------------------------------------------

describe('svelte adapter', () => {
  it('extracts the component symbol, module + instance script declarations, and template refs', () => {
    const { symbols, refs } = extractSvelte(SVELTE_CONTENT, 'Counter.svelte')

    const component = symbols.find((s) => s.kind === 'svelte_component')
    expect(component).toMatchObject({ name: 'Counter', lineStart: 1, lineEnd: 27 })

    const byName = (name: string) => symbols.find((s) => s.name === name)
    expect(byName('MODULE_CONST')).toMatchObject({ kind: 'sfc_script_const', lineStart: 2 })
    expect(byName('handleClick')).toMatchObject({ kind: 'sfc_script_function', lineStart: 9 })
    expect(byName('label')).toMatchObject({ kind: 'sfc_script_const', lineStart: 13 })

    // `let count = 0` is a `let`, not a `const` -- out of scope per spec, must not be emitted.
    expect(byName('count')).toBeUndefined()

    const refNames = refs.map((r) => r.name)
    expect(refNames).toContain('Header')
    expect(refNames).toContain('sub-widget')
    expect(refNames).not.toContain('div')
    expect(refNames).not.toContain('button')
    expect(refNames).not.toContain('OldThing')

    const headerRef = refs.find((r) => r.name === 'Header')
    expect(headerRef).toMatchObject({ line: 16 })
  })

  it('does not leak <style> block content into template ref extraction', () => {
    const { refs } = extractSvelte(SVELTE_CONTENT, 'Counter.svelte')
    expect(refs.some((r) => r.name === 'card')).toBe(false)
  })

  it('indexes a real .svelte file end-to-end through parseFile', async () => {
    const result = await parseFixture('Counter.svelte', SVELTE_CONTENT)
    expect(result.language).toBe('svelte')
    expect(result.symbols.some((s) => s.kind === 'svelte_component' && s.name === 'Counter')).toBe(true)
    expect(result.symbols.some((s) => s.name === 'handleClick' && s.kind === 'sfc_script_function')).toBe(true)
    expect(result.refs.some((r) => r.name === 'sub-widget')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Astro
// ---------------------------------------------------------------------------

describe('astro adapter', () => {
  it('extracts the component symbol, frontmatter declarations, and markup component refs', () => {
    const { symbols, refs } = extractAstro(ASTRO_CONTENT, 'Home.astro')

    const component = symbols.find((s) => s.kind === 'astro_component')
    expect(component).toMatchObject({ name: 'Home', lineStart: 1, lineEnd: 21 })

    const byName = (name: string) => symbols.find((s) => s.name === name)
    expect(byName('title')).toMatchObject({ kind: 'sfc_script_const', lineStart: 4 })
    expect(byName('greet')).toMatchObject({ kind: 'sfc_script_function', lineStart: 6 })

    const refNames = refs.map((r) => r.name)
    expect(refNames).toContain('Layout')
    expect(refNames).toContain('MainHero')
    expect(refNames).not.toContain('p')
    expect(refNames).not.toContain('OldHero')

    const layoutRef = refs.find((r) => r.name === 'Layout')
    expect(layoutRef).toMatchObject({ line: 11 })
  })

  it('does not leak <style> block content into markup ref extraction', () => {
    const { refs } = extractAstro(ASTRO_CONTENT, 'Home.astro')
    expect(refs.some((r) => r.name === 'blue')).toBe(false)
  })

  it('rejects a `---` pair that is not the very first content of the file as frontmatter', () => {
    const { symbols, refs } = extractAstro(ASTRO_NOT_FRONTMATTER, 'NotFm.astro')
    // No frontmatter detected -> no script-declaration symbols beyond the component symbol.
    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ kind: 'astro_component', name: 'NotFm' })
    // The `<Widget />` tag after the fake "frontmatter" is still reachable as a markup ref,
    // proving the whole file was scanned as plain markup, not truncated at the `---` lines.
    expect(refs.some((r) => r.name === 'Widget')).toBe(true)
  })

  it('indexes a real .astro file end-to-end through parseFile', async () => {
    const result = await parseFixture('Home.astro', ASTRO_CONTENT)
    expect(result.language).toBe('astro')
    expect(result.symbols.some((s) => s.kind === 'astro_component' && s.name === 'Home')).toBe(true)
    expect(result.symbols.some((s) => s.name === 'greet' && s.kind === 'sfc_script_function')).toBe(true)
    expect(result.refs.some((r) => r.name === 'MainHero')).toBe(true)
  })

  it('does not misdetect a `---`-only line inside the frontmatter script\'s own template literal as the closing fence (regression: detectAstroFrontmatter\'s naive line-exact scan had no string/template-literal awareness)', () => {
    const { symbols, refs } = extractAstro(ASTRO_TEMPLATE_LITERAL_DASHES, 'Home2.astro')

    // The real closing fence is on line 6, past the template literal's inner `---` on line 3 --
    // `title` (declared after the template literal, before the real fence) proves the frontmatter
    // parse ran all the way to the real close.
    const title = symbols.find((s) => s.name === 'title')
    expect(title).toMatchObject({ kind: 'sfc_script_const', lineStart: 5, lineEnd: 5 })

    // Markup after the real fence is still reached and scanned for component refs.
    const refNames = refs.map((r) => r.name)
    expect(refNames).toContain('Layout')
    expect(refNames).toContain('MainHero')
  })
})

// An empty file used to still get a whole-file component symbol, and `countContentLines('')` is
// 0, so that symbol claimed `lineStart: 1, lineEnd: 0`. The backwards span reached the database
// and printed to the reader as `Empty.vue:1-0`. Every other language emits nothing for empty
// content. Found by feeding hostile inputs (empty, unterminated, CRLF-only, deeply nested) to
// every adapter and asserting the span invariants none of them state for themselves.
describe('single-file components with no lines', () => {
  it.each([
    ['vue', extractVue],
    ['svelte', extractSvelte],
    ['astro', extractAstro],
  ])('emits no %s component symbol for an empty file, rather than a backwards span', (ext, extract) => {
    expect(extract('', `Empty.${ext}`).symbols).toEqual([])
  })

  it.each([
    ['vue', extractVue],
    ['svelte', extractSvelte],
    ['astro', extractAstro],
  ])('still emits the %s component symbol for a file holding one blank line', (ext, extract) => {
    const symbols = extract('\n', `Blank.${ext}`).symbols

    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({ name: 'Blank', lineStart: 1, lineEnd: 1 })
  })

  it.each([
    ['vue', extractVue],
    ['svelte', extractSvelte],
    ['astro', extractAstro],
  ])('never returns a %s symbol whose span ends before it starts', (ext, extract) => {
    for (const content of ['', '\n', '\r\n', '   ', '<template><div/></template>', '<script>\n']) {
      for (const symbol of extract(content, `Probe.${ext}`).symbols) {
        expect(symbol.lineEnd, `${JSON.stringify(content)} -> ${symbol.name}`).toBeGreaterThanOrEqual(
          symbol.lineStart,
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Brace counting across string/template-literal spans
// ---------------------------------------------------------------------------

/** Wraps a bare script body in whichever container the given SFC format expects. */
function wrapScript(ext: string, body: readonly string[]): string {
  const script = body.join('\n')
  if (ext === 'astro') return `---\n${script}\n---\n\n<div>markup</div>\n`
  return `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n  <div>markup</div>\n</template>\n`
}

const SFC_FORMATS = [
  ['vue', extractVue],
  ['svelte', extractSvelte],
  ['astro', extractAstro],
] as const

describe('top-level declaration brace counting', () => {
  it.each(SFC_FORMATS)(
    'still finds %s declarations that follow a multi-line template literal holding an unbalanced brace (regression: the per-line brace counter could not see a backtick span opened on an earlier line, so depth stayed above 0 and every later declaration was silently dropped)',
    (ext, extract) => {
      const content = wrapScript(ext, [
        'const before = 1',
        '',
        'const tpl = `',
        '  a line with a brace {',
        '  another line',
        '`',
        '',
        'function visibleFn() {',
        '  return 2',
        '}',
        '',
        'const visibleConst = 3',
      ])

      const names = extract(content, `Tpl.${ext}`).symbols.map((s) => s.name)

      expect(names, `${ext}: ${names.join(', ')}`).toEqual(
        expect.arrayContaining(['before', 'tpl', 'visibleFn', 'visibleConst']),
      )
    },
  )

  it.each(SFC_FORMATS)(
    'does not index a declaration-shaped line that only exists inside a %s template literal',
    (ext, extract) => {
      const content = wrapScript(ext, [
        'const snippet = `',
        '  function notReal() {}',
        '  const alsoNotReal = 1',
        '`',
        '',
        'const real = 2',
      ])

      const names = extract(content, `Snippet.${ext}`).symbols.map((s) => s.name)

      expect(names, `${ext}: ${names.join(', ')}`).toContain('real')
      expect(names, `${ext}: ${names.join(', ')}`).not.toContain('notReal')
      expect(names, `${ext}: ${names.join(', ')}`).not.toContain('alsoNotReal')
    },
  )

  // Control for the over-fix: a whole-file string state machine that opens a span and never
  // closes it swallows the rest of the file. A lone quote inside a regex character class is the
  // cheapest way to open one by accident, so the damage must stay bounded to that physical line.
  it.each(SFC_FORMATS)(
    'keeps a stray unclosed quote inside a %s regex literal from swallowing the declarations after it',
    (ext, extract) => {
      const content = wrapScript(ext, [
        'const quoteRe = /[\'"]/',
        '',
        'function afterRegex() {',
        '  return 1',
        '}',
        '',
        'const tailConst = 2',
      ])

      const names = extract(content, `Regex.${ext}`).symbols.map((s) => s.name)

      expect(names, `${ext}: ${names.join(', ')}`).toEqual(
        expect.arrayContaining(['quoteRe', 'afterRegex', 'tailConst']),
      )
    },
  )

  // Control for the other half of the over-fix: blanking string bodies must not stop the counter
  // from tracking real code braces, or nested declarations would leak out as top-level ones.
  it.each(SFC_FORMATS)('still treats braces in real %s code as depth', (ext, extract) => {
    const content = wrapScript(ext, [
      'function outer() {',
      '  const nestedConst = 1',
      '  function nestedFn() {',
      '    return nestedConst',
      '  }',
      '  return nestedFn',
      '}',
      '',
      'const afterOuter = 3',
    ])

    const names = extract(content, `Nested.${ext}`).symbols.map((s) => s.name)

    expect(names, `${ext}: ${names.join(', ')}`).toEqual(
      expect.arrayContaining(['outer', 'afterOuter']),
    )
    expect(names, `${ext}: ${names.join(', ')}`).not.toContain('nestedConst')
    expect(names, `${ext}: ${names.join(', ')}`).not.toContain('nestedFn')
  })
})
