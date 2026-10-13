/** isSecretFileName (src/secret_file_names.ts): the base names that hold credentials. Every case is HAND-DERIVED from the list the rule states (env files except the two templates, PEM and key files, PKCS#12 bundles, SSH private keys, npm and netrc files, credentials*), with ordinary names beside each class that the rule must leave alone. */
import { describe, expect, it } from 'vitest'

import { isSecretFileName } from '../src/secret_file_names.js'

const SECRET = ['.env', '.env.local', '.env.production', '.ENV.Local', 'server.pem', 'tls.key', 'KEY.PEM', 'store.p12', 'store.pfx', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.npmrc', '.netrc', 'credentials', 'credentials.json', 'Credentials.yml', '.pgpass', '.git-credentials', 'vault.kdbx', 'Vault.KDBX', 'terraform.tfstate', 'terraform.tfstate.backup', 'infra/prod.tfstate', 'secrets.yml', 'secrets.yaml', 'config/Secrets.YAML', '.aws/config', 'home/.aws/config', 'home/.AWS/Config', String.raw`C:\Users\a\.aws\config`]
const ORDINARY = ['config', 'src/config', 'aws/config', '.aws/config.ts', 'config/.aws', 'secrets.ts', 'secrets.yml.md', 'my-secrets.yml', 'kdbx.md', 'vault.kdbx.md', 'tfstate.md', 'terraform.tfvars', 'pgpass.md', 'git-credentials.md', '.env.example', '.env.sample', '.ENV.EXAMPLE', 'environment.ts', 'envelope.md', 'id_rsa.pub', 'id.ts', 'idle.ts', 'keyboard.ts', 'monkey.ts', 'pem.ts', 'npmrc.md', 'netrc.md', 'credential.json', 'README.md', 'config.ts']

describe('isSecretFileName', () => {
  it('has both lists populated', () => {
    expect(SECRET.length).toBeGreaterThan(10)
    expect(ORDINARY.length).toBeGreaterThan(10)
  })

  it.each(SECRET.map((name) => [name] as const))('holds %s back', (name) => {
    expect(isSecretFileName(name)).toBe(true)
  })

  it.each(ORDINARY.map((name) => [name] as const))('lets %s through', (name) => {
    expect(isSecretFileName(name)).toBe(false)
  })
})
