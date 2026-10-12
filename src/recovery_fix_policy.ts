/** What a recovery pair may store and replay (recovery_pairs.ts). A stored fix is shown to the model in a later session, and the error text that led to it is attacker-influenced, so the gate is an allowlist of the repo's own build, test and install verbs, not a list of known-bad commands. A part names no package (the package name would come from the error text), pipes nothing, redirects nothing and sets no environment variable that changes what gets loaded. Every command kept anywhere on disk must also be free of credentials. */

import { stripLeadingAssignments } from './bash_extractors.js'
import { hasPreciseSecret, redactSecrets } from './secret_redact.js'

const FLAG = String.raw`(?:\s+--?[A-Za-z][\w-]*(?:=[\w./-]+)?)`
const PATH_ARG = String.raw`[\w./-]+`
const PIP_ARGS = String.raw`(?:${FLAG}|\s+-r\s+${PATH_ARG}|\s+-e\s+\.[\w./-]*|\s+\.)*`

export interface FixVerbClass {
  name: string
  pattern: RegExp
  /** A command the class accepts; the test file derives its accepted cases from it. */
  example: string
}

/** The one list of verbs a stored fix may start with, after leading `VAR=value` and wrappers are peeled. Package-adding forms (`npm i left-pad`, `pip install foo`, `cargo add`, `yarn add`) match none of these: only argument-free installs and installs from a manifest do. */
export const FIX_VERB_ALLOWLIST: readonly FixVerbClass[] = [
  { name: 'js package manager install, build or test', pattern: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|test|t|build|rebuild)${FLAG}*$`), example: 'npm ci' },
  { name: 'js package manager script', pattern: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]+${FLAG}*$`), example: 'npm run build' },
  { name: 'pip install from a manifest', pattern: new RegExp(String.raw`^(?:python3?\s+-m\s+)?pip3?\s+install${PIP_ARGS}$`), example: 'pip install -r requirements.txt' },
  { name: 'uv pip install from a manifest', pattern: new RegExp(String.raw`^uv\s+pip\s+install${PIP_ARGS}$`), example: 'uv pip install -e .' },
  { name: 'python environment sync', pattern: new RegExp(String.raw`^(?:uv\s+sync|poetry\s+install|pipenv\s+(?:install|sync))${FLAG}*$`), example: 'uv sync' },
  { name: 'cargo', pattern: new RegExp(String.raw`^cargo\s+(?:build|test|fetch|check)${FLAG}*$`), example: 'cargo fetch' },
  { name: 'go build and test', pattern: new RegExp(String.raw`^go\s+(?:build|test|vet)(?:${FLAG}|\s+\.{1,2}/[\w./-]*)*$`), example: 'go test ./...' },
  { name: 'go modules', pattern: new RegExp(String.raw`^go\s+mod\s+(?:download|tidy|vendor)${FLAG}*$`), example: 'go mod download' },
  { name: 'make target', pattern: new RegExp(String.raw`^make(?:\s+[\w.-]+|${FLAG})*$`), example: 'make setup' },
  { name: 'virtualenv activation', pattern: new RegExp(String.raw`^(?:source|\.)\s+[\w./-]*activate(?:\.\w+)?$`), example: 'source .venv/bin/activate' },
  { name: 'bundler', pattern: new RegExp(String.raw`^bundle\s+install${FLAG}*$`), example: 'bundle install' },
  { name: 'dotnet', pattern: new RegExp(String.raw`^dotnet\s+(?:restore|build|test)${FLAG}*$`), example: 'dotnet restore' },
  { name: 'maven and gradle', pattern: new RegExp(String.raw`^(?:\./)?(?:mvnw?|gradlew?)(?:\s+(?:clean|install|compile|test|package|verify|build|assemble)|${FLAG})+$`), example: 'mvn clean install' },
  { name: 'cd into a directory', pattern: new RegExp(String.raw`^cd\s+${PATH_ARG}$`), example: 'cd services/api' },
]

/** The failed command itself, rerun behind an allowlisted prefix (`source .venv/bin/activate && pytest`): a test or lint runner, or a plain directory listing. Its arguments are free text, so {@link FORBIDDEN_IN_PART} is what keeps a pipe, a chain or a redirect out of it. Any other command is replayed only when it is on {@link FIX_VERB_ALLOWLIST}. */
export const RERUN_COMMAND: RegExp = /^(?:python3?\s+-m\s+)?(?:pytest|vitest|jest|mocha|tsc|eslint|ruff|mypy|flake8)(?:\s+\S.*)?$|^ls(?:\s+[\w./-]+)*$/

/** Anything that pipes, chains, redirects, substitutes, fetches or escalates. A match refuses the part whatever verb it starts with. */
const FORBIDDEN_IN_PART = /[|;<>&$`]|\b(?:curl|wget|sudo|iex|eval|base64)\b|Invoke-Expression/i

/** Environment variables that change what a program loads or runs. */
const DANGEROUS_ENV = /^(?:LD_\w+|DYLD_\w+|PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|RUBYOPT|GIT_\w+|npm_config_\w+|NPM_CONFIG_\w+|PIP_\w+|UV_\w+)$/

function leadingAssignmentNames(segment: string): string[] {
  const names: string[] = []
  for (const token of segment.split(' ')) {
    const assign = /^([A-Za-z_]\w*)=/.exec(token)
    if (assign !== null) names.push(assign[1] ?? '')
    else if (token !== 'env' && !token.startsWith('-')) break
  }
  return names
}

function coreOf(segment: string, wrappers: RegExp): string {
  let core = segment
  for (let peel = 0; peel < 4; peel++) {
    const next = stripLeadingAssignments(core).replace(/\s+/g, ' ').trim().replace(wrappers, '')
    if (next === core) break
    core = next
  }
  return core
}

/** Whether every `&&` part of `fix` is safe to show a later session as history. A part is accepted when it starts with an allowlisted verb, or is the failed command itself (`failedCore`) and a {@link RERUN_COMMAND}, behind the prefix the success added. */
export function fixIsAllowed(fix: string, failedCore: string, wrappers: RegExp): boolean {
  for (const part of fix.split(' && ')) {
    if (part === '' || FORBIDDEN_IN_PART.test(part)) return false
    if (leadingAssignmentNames(part).some((name) => DANGEROUS_ENV.test(name))) return false
    const core = coreOf(part, wrappers)
    if (core === failedCore && RERUN_COMMAND.test(core)) continue
    if (!FIX_VERB_ALLOWLIST.some((verb) => verb.pattern.test(core))) return false
  }
  return true
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(?:^|\s)--?(?:password|passwd|pass|pwd|token|api[-_]?key|secret|access[-_]?key|client[-_]?secret|auth)(?:=|\s+)\S/i,
  /(?:^|\s)(?:-u|--user)\s+\S*:\S/,
  /\b(?:mysql|mysqldump|mysqladmin|psql|pg_dump|pg_restore|mongo\w*|redis-cli|sqlcmd)\b[^|;&]*\s-p\S/i,
  /(?:^|[\s;&|])[A-Za-z_]\w*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS)=/i,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
  /\b(?:authorization|bearer)\b/i,
]

/** Whether `text` holds a credential, by the redactor, its precise patterns, or the command-line shapes the redactor's generic pattern misses (`--token abc`, `-u user:pw`, `-pSECRET`, `GITHUB_TOKEN=...`). Anything that does is neither stored nor replayed. */
export function carriesCredential(text: string): boolean {
  return redactSecrets(text).text !== text || hasPreciseSecret(text) || CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
}
