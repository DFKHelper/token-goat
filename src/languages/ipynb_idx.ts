/**
 * Jupyter notebook (`.ipynb`) adapter.
 *
 * `.ipynb` files are JSON, not source code -- there is no tree-sitter grammar for the format
 * itself. Rather than write a bespoke symbol extractor, this module flattens a notebook's code
 * (and markdown) cells into a single virtual Python-like document, and parser.ts runs the SAME
 * tree-sitter Python extraction path against that virtual document (forcing language 'python'
 * for extraction purposes only -- the stored `files.language` stays 'ipynb'). This gets full
 * tree-sitter-quality symbol/ref extraction for notebook code cells for free.
 *
 * Line numbers in the returned `content` are exactly the line numbers tree-sitter (and therefore
 * the extracted symbols' lineStart/lineEnd) will use -- they intentionally do NOT correspond to
 * byte offsets in the raw `.ipynb` JSON on disk. That's fine: read_commands.ts's resolveBody uses
 * each SymbolEntry's own `body` field (populated by the extractor from this same virtual content)
 * directly, only falling back to re-slicing the raw file by line number when `body` is empty.
 *
 * Known limitation (documented, not a TODO): only Python-kernel notebooks are supported. A
 * notebook whose kernel is declared as something else (R, Julia, Scala, ...) yields
 * `cellLanguage: null` and is never parsed for symbols/refs -- extraction for non-Python kernels
 * is out of scope for this first pass.
 */

export interface IpynbVirtualSource {
  readonly content: string
  readonly cellLanguage: 'python' | null
}

interface NotebookCell {
  readonly cell_type?: unknown
  readonly source?: unknown
}

interface NotebookMetadata {
  readonly kernelspec?: { readonly language?: unknown }
  readonly language_info?: { readonly name?: unknown }
}

interface NotebookJson {
  readonly cells?: unknown
  readonly metadata?: NotebookMetadata
}

/**
 * Normalizes a cell's `source` field (a single string, or an array of per-line strings -- the
 * common real-world nbformat shape) into one string. Array elements almost always already carry
 * their own trailing `\n`, so the default is to join them with no extra separator; if NONE of the
 * elements end in `\n` (a producer that omitted line terminators), join with `\n` instead so
 * lines don't get glued together.
 */
function normalizeSource(source: unknown): string {
  if (typeof source === 'string') return source
  if (!Array.isArray(source)) return ''
  const lines = source.filter((s): s is string => typeof s === 'string')
  if (lines.length === 0) return ''
  const noneEndWithNewline = lines.every((l) => !l.endsWith('\n'))
  return noneEndWithNewline ? lines.join('\n') : lines.join('')
}

function resolveKernelLanguage(metadata: NotebookMetadata | undefined): string | undefined {
  const kernelspecLang = metadata?.kernelspec?.language
  if (typeof kernelspecLang === 'string' && kernelspecLang !== '') return kernelspecLang.toLowerCase()
  const infoLang = metadata?.language_info?.name
  if (typeof infoLang === 'string' && infoLang !== '') return infoLang.toLowerCase()
  return undefined
}

/** Best-effort, never-throw: malformed JSON or an unsupported kernel yields an empty result. */
export function ipynbToVirtualSource(raw: string): IpynbVirtualSource {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { content: '', cellLanguage: null }
  }
  if (typeof data !== 'object' || data === null) return { content: '', cellLanguage: null }
  const nb = data as NotebookJson
  if (!Array.isArray(nb.cells)) return { content: '', cellLanguage: null }

  const declared = resolveKernelLanguage(nb.metadata)
  const isPython = declared === undefined || declared === 'python' || declared === 'python3'
  if (!isPython) return { content: '', cellLanguage: null }

  const blocks: string[] = []
  nb.cells.forEach((cell: unknown, index: number) => {
    if (typeof cell !== 'object' || cell === null) return
    const c = cell as NotebookCell
    if (c.cell_type === 'code') {
      const src = normalizeSource(c.source).replace(/\n+$/, '')
      blocks.push(`# %% cell ${index}\n${src}`)
    } else if (c.cell_type === 'markdown') {
      const src = normalizeSource(c.source).replace(/\n+$/, '')
      const commented = src
        .split('\n')
        .map((line) => (line === '' ? '#' : `# ${line}`))
        .join('\n')
      blocks.push(`# %% [markdown] cell ${index}\n${commented}`)
    }
    // raw cells are rare, kernel-specific, and never emitted into the virtual document.
  })

  return { content: blocks.join('\n\n'), cellLanguage: 'python' }
}
