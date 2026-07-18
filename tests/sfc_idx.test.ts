import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { parseFile } from '../src/parser.js'
import { detectLanguage } from '../src/parser_types.js'
import { extractVue, extractSvelte, extractAstro } from '../src/languages/sfc_idx.js'

function tmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sfc-test-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

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
    expect(component).toMatchObject({ name: 'MyButtonPanel', lineStart: 1, lineEnd: 32 })

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
    const file = tmp('Widget.vue', VUE_CONTENT)
    try {
      const result = await parseFile(file)
      expect(result.language).toBe('vue')
      expect(result.symbols.some((s) => s.kind === 'vue_component' && s.name === 'Widget')).toBe(true)
      expect(result.symbols.some((s) => s.name === 'increment' && s.kind === 'sfc_script_function')).toBe(true)
      expect(result.refs.some((r) => r.name === 'MyButton')).toBe(true)
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Svelte
// ---------------------------------------------------------------------------

describe('svelte adapter', () => {
  it('extracts the component symbol, module + instance script declarations, and template refs', () => {
    const { symbols, refs } = extractSvelte(SVELTE_CONTENT, 'Counter.svelte')

    const component = symbols.find((s) => s.kind === 'svelte_component')
    expect(component).toMatchObject({ name: 'Counter', lineStart: 1, lineEnd: 28 })

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
    const file = tmp('Counter.svelte', SVELTE_CONTENT)
    try {
      const result = await parseFile(file)
      expect(result.language).toBe('svelte')
      expect(result.symbols.some((s) => s.kind === 'svelte_component' && s.name === 'Counter')).toBe(true)
      expect(result.symbols.some((s) => s.name === 'handleClick' && s.kind === 'sfc_script_function')).toBe(true)
      expect(result.refs.some((r) => r.name === 'sub-widget')).toBe(true)
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Astro
// ---------------------------------------------------------------------------

describe('astro adapter', () => {
  it('extracts the component symbol, frontmatter declarations, and markup component refs', () => {
    const { symbols, refs } = extractAstro(ASTRO_CONTENT, 'Home.astro')

    const component = symbols.find((s) => s.kind === 'astro_component')
    expect(component).toMatchObject({ name: 'Home', lineStart: 1, lineEnd: 22 })

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
    const file = tmp('Home.astro', ASTRO_CONTENT)
    try {
      const result = await parseFile(file)
      expect(result.language).toBe('astro')
      expect(result.symbols.some((s) => s.kind === 'astro_component' && s.name === 'Home')).toBe(true)
      expect(result.symbols.some((s) => s.name === 'greet' && s.kind === 'sfc_script_function')).toBe(true)
      expect(result.refs.some((r) => r.name === 'MainHero')).toBe(true)
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })
})
