/** File names whose contents are credentials. A suggestion that names one tells the model the file exists, and a near-miss echo quotes its lines, so both leave these out (path_suggest.ts, edit_near_miss.ts). Decided on the base name alone, case-folded. */

/** The templates of an env file, which hold placeholders and are meant to be read. */
const ENV_TEMPLATES: ReadonlySet<string> = new Set(['.env.example', '.env.sample'])

/** Whether `name`, a file's base name, is one that holds credentials: `.env` and its variants except the two templates, PEM and key files, PKCS#12 bundles, SSH private keys (`id_rsa`, `id_ed25519`; the `.pub` half is public), npm and netrc credential files, and anything called `credentials`. */
export function isSecretFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.')) return !ENV_TEMPLATES.has(lower)
  if (lower.startsWith('id_')) return !lower.endsWith('.pub')
  return /\.(?:pem|key|p12|pfx)$|^\.n(?:pm|et)rc$|^credentials/.test(lower)
}
