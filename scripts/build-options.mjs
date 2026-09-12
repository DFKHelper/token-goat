// The parts of the shipping build that more than one tool has to agree on.
//
// esbuild.config.mjs builds dist/, scripts/generate-third-party-notices.mjs works out which
// third-party packages that build inlines, and tests/guards/third_party_notices.test.ts checks the
// generated file still describes the real build. All three have to bundle the same module graph:
// if one of them carried its own copy of the entry points or the external list and the copies
// drifted, the notices file would describe a build nobody ships, and it would do so silently --
// the build would still succeed and the guard would still pass, against the wrong graph.

/** The two entry points one build emits. See esbuild.config.mjs for why they are one build. */
export const ENTRY_POINTS = {
  'token-goat.core': 'src/main.ts',
  'token-goat-hook': 'src/hook_lib.ts',
}

/**
 * Native addons cannot be bundled, and every package here is declared optionalDependencies in
 * package.json -- bundling one anyway (as sharp, puppeteer-core, pdfjs-dist and fflate previously
 * were, via their `await import(...)` call sites) defeats "optional": esbuild statically resolves
 * and inlines even a dynamic `import('literal')`, so the feature only worked at runtime because a
 * matching platform package happened to be present in node_modules, not because the
 * graceful-degradation fallback ever ran.
 *
 * `sharp` was in this list until it stopped being a dependency at all. Nothing under `src/` imports
 * it -- the image pipeline is pure TypeScript -- so the entry matched no import and marked nothing
 * external, while reading as a claim the build was keeping something out that was never in.
 */
export const EXTERNAL_NATIVE_DEPS = [
  'sqlite-vec',
  'tree-sitter',
  'tree-sitter-*',
  'puppeteer-core',
  'pdfjs-dist',
  'pdfjs-dist/*',
  'fflate',
  'onnxruntime-node',
  // Not a native addon either, but tesseract.js's Node entrypoint resolves its worker
  // script and tesseract.js-core's WASM binary via on-disk paths relative to its own
  // package directory at runtime -- bundling it into token-goat.mjs would break those
  // relative lookups, and per the comment above would also defeat graceful degradation
  // on installs that skip optional deps (see image_ocr.ts's loadTesseract).
  'tesseract.js',
  // Not a native addon, but the same "optionalDependencies entry must not get statically
  // inlined" reasoning applies: the full TypeScript compiler (ts_refs.ts's lazily-`require`d
  // type-resolved `refs` tier) is multiple MB of pure JS. Bundling it would both bloat
  // dist/token-goat.mjs for every install and, per the comment above, defeat graceful
  // degradation on installs that skip optional deps.
  'typescript',
]
