import * as fs from 'node:fs'

/** esbuild names every dependency module by the path it resolved, and it resolves through symlinks and junctions. In a worktree whose node_modules is a junction into another checkout, a package arrives as `../../<elsewhere>/node_modules/commander/lib/command.js` instead of `node_modules/commander/lib/command.js`, both as a metafile key and as the `// <path>` marker and CommonJS wrapper key written into the built chunks. A guard that matches a literal `node_modules/...` path, or that counts the bytes of a chunk, then answers differently in a junctioned worktree than in an ordinary clone. These helpers rewrite the path to the form an ordinary clone produces. */

/** The part of `p` from the last `node_modules/` on; a path with no `node_modules/` is returned unchanged. */
export function dependencyRelative(p: string): string {
  const at = p.lastIndexOf('node_modules/')
  return at < 0 ? p : p.slice(at)
}

/** `text` with every `../`-led path that reaches a `node_modules/` directory rewritten to start at that directory, which is how an ordinary clone's build spells it. The leading `../` is required so a plain `node_modules/...` string in the source is never touched. */
export function withClonePaths(text: string): string {
  return text.replaceAll(/(?:\.\.\/)+(?:[^"'\s/]+\/)*?node_modules\//g, 'node_modules/')
}

/** The size in bytes of the built file at `file` as an ordinary clone's build would write it, for the size ceilings on bundle chunks. */
export function cloneByteSize(file: string): number {
  return Buffer.byteLength(withClonePaths(fs.readFileSync(file, 'utf8')))
}
