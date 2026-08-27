// Shared image-shrink materializer used verbatim inside the generated bridge scripts for opencode (opencode.ts), OpenClaw (openclaw.ts) and the Copilot CLI hook shim (copilot_cli.ts). Those hosts have no pre-tool context channel to hand the shrunk image to the model directly -- only argument rewriting -- so the shrink payload token-goat emits as additionalContext ("<summary>\ndata:image/<fmt>;base64,<data>", built by formatShrinkSummary in src/image_shrink.ts) is decoded to a real temp file here and the read path argument is rewritten to point at it. pi.ts keeps its own typed copy of this logic and is intentionally NOT wired to this constant, for the same reason relay_block.ts documents for BRIDGE_RELAY_JS: pi's extension host is a real TypeScript compile target, and this block is plain untyped JS meant to be dropped verbatim into a generated file. Any behavioral change here must be mirrored into pi.ts's typed copy.
// Host contract: the enclosing script must have `fs`, `os` and `path` bound to node:fs / node:os / node:path (ESM imports in the plugin scripts, require() in the CommonJS Copilot shim).
export const MATERIALIZE_SHRUNK_IMAGE_JS = `// Best-effort sweep of previously materialized shrunk copies in the OS temp dir. The temp file only needs to outlive the single tool call whose path argument was rewritten to it, so anything older than an hour is finished with; the "token-goat-shrink-" prefix check confines the sweep to this mechanism's own files (same defense-in-depth rule as pruneShrinkCache in src/image_shrink.ts). Throttled per process; runs only when a shrink payload actually arrives, so the common no-image path never pays for it.
const MATERIALIZED_SHRINK_MAX_AGE_MS = 60 * 60 * 1000
let lastMaterializedShrinkSweepAtMs = 0
function pruneMaterializedShrinks() {
  const now = Date.now()
  if (now - lastMaterializedShrinkSweepAtMs < MATERIALIZED_SHRINK_MAX_AGE_MS) return
  lastMaterializedShrinkSweepAtMs = now
  try {
    const dir = os.tmpdir()
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith("token-goat-shrink-")) continue
      const full = path.join(dir, file)
      try {
        const st = fs.statSync(full)
        if (st.isFile() && now - st.mtimeMs > MATERIALIZED_SHRINK_MAX_AGE_MS) fs.unlinkSync(full)
      } catch {
        // Best-effort per-file cleanup; one bad stat/unlink must not abort the sweep.
      }
    }
  } catch {
    // Best-effort; a readdir failure must never break the materialization below.
  }
}

// Decode a token-goat image-shrink additionalContext payload ("<summary>\\ndata:image/<fmt>;base64,<data>") into a real file on disk, since the host's pre-tool hook has no context-injection channel to hand the shrunk image to the model directly -- only argument rewriting. The temp filename is derived from pid/time/random alone, never from the source image's own name, so an attacker-chosen filename cannot steer the write; the format suffix comes from the data-URL's media subtype, whose character class ([a-zA-Z0-9.+-]) admits no path separators. Returns undefined (leaving the original path argument untouched, so a failed shrink falls back to the original image) if the context isn't a shrink payload or anything goes wrong writing it.
function materializeShrunkImage(context) {
  if (typeof context !== "string") return undefined
  const idx = context.indexOf("data:image/")
  if (idx === -1) return undefined
  const match = /^data:image\\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(context.slice(idx).trim())
  if (!match) return undefined
  try {
    pruneMaterializedShrinks()
    const buf = Buffer.from(match[2], "base64")
    const name = \`token-goat-shrink-\${process.pid}-\${Date.now()}-\${Math.random().toString(36).slice(2)}.\${match[1]}\`
    const file = path.join(os.tmpdir(), name)
    fs.writeFileSync(file, buf)
    return file
  } catch {
    return undefined
  }
}`
