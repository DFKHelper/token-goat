/** File names whose contents are credentials. A suggestion that names one tells the model the file exists, and a near-miss echo quotes its lines, so both leave these out (path_suggest.ts, edit_near_miss.ts). Decided on the base name, case-folded, plus the directory it sits in for the one name that is only a secret there (`.aws/config`). */

/** The templates of an env file, which hold placeholders and are meant to be read. */
const ENV_TEMPLATES: ReadonlySet<string> = new Set(['.env.example', '.env.sample'])

/** Base names that are credential stores whatever the extension rule says: the Postgres password file and git's stored logins. */
const SECRET_BASE_NAMES: ReadonlySet<string> = new Set(['.pgpass', '.git-credentials'])

/** Whether `path`, a file's path or just its base name, names a file that holds credentials: `.env` and its variants except the two templates, PEM and key files, PKCS#12 bundles, SSH private keys (`id_rsa`, `id_ed25519`; the `.pub` half is public), npm and netrc credential files, `.pgpass`, `.git-credentials`, KeePass databases (`*.kdbx`), Terraform state (`*.tfstate`, which holds every secret value in plain text), `secrets.yml` and `secrets.yaml`, the AWS CLI's `config` under a `.aws` directory, and anything called `credentials`. */
export function isSecretFileName(path: string): boolean {
  const parts = path.split(/[\\/]/)
  const lower = (parts[parts.length - 1] ?? '').toLowerCase()
  const parent = (parts[parts.length - 2] ?? '').toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.')) return !ENV_TEMPLATES.has(lower)
  if (lower.startsWith('id_')) return !lower.endsWith('.pub')
  if (lower === 'config' && parent === '.aws') return true
  return SECRET_BASE_NAMES.has(lower) || /\.(?:pem|key|p12|pfx|kdbx?|tfstate(?:\.backup)?)$|^\.n(?:pm|et)rc$|^credentials|^secrets\.ya?ml$/.test(lower)
}
