/** What a recovery pair may store and replay (recovery_pairs.ts). A stored fix is shown to the model in a later session, and the error text that led to it is attacker-influenced, so the gate is an allowlist of the repo's own build, test and install verbs, not a list of known-bad commands. A part names no package (the package name would come from the error text), pipes nothing, redirects nothing and sets no environment variable that changes what gets loaded. Every command kept anywhere on disk must also be free of credentials. */

import { stripLeadingAssignments } from './bash_extractors.js'
import { hasPreciseSecret, redactSecrets } from './secret_redact.js'

/** The flags a replayed fix may carry, by name: switches that change how much is printed, whether the network is touched or which build profile runs, never one that names a file, a directory, a program or a script to run (`--prefix`, `--userconfig`, `--script-shell`, `--cwd`, `--config`, `--manifest-path`, `-exec`, `-toolexec`, `-s`). A value is allowed only as digits or `true`/`false`. */
const SAFE_FLAG_NAMES: readonly string[] = [
  '--ci', '--ignore-scripts', '--frozen-lockfile', '--immutable', '--no-audit', '--no-fund', '--silent', '--quiet', '--verbose', '--offline', '--prefer-offline', '--production', '--legacy-peer-deps', '--if-present', '--release',
  '--locked', '--frozen', '--all-features', '--all-targets', '--no-default-features', '--workspace', '--lib', '--bins', '--tests', '--dev', '--no-dev', '--all-extras', '--upgrade', '--no-cache-dir', '--no-cache',
  '--no-deps', '--no-build-isolation', '--no-install-project', '--no-fail-fast', '--fail-fast', '--info', '--stacktrace', '--no-daemon', '--batch-mode', '--no-restore', '--no-build', '--nologo',
  '-q', '-vvv', '-vv', '-v', '-B', '-U', '-o', '-e', '-race', '-short', '-json', '-DskipTests',
]
const SAFE_FLAG_VALUES: readonly string[] = ['-count', '-parallel', '--jobs', '--concurrency', '--maxsockets']
const FLAG = String.raw`(?:\s+(?:(?:${SAFE_FLAG_NAMES.join('|')})(?:=(?:true|false|\d{1,5}))?|(?:${SAFE_FLAG_VALUES.join('|')})=\d{1,5}|-j\d{1,3}|--console=plain)(?=\s|$))`
const PATH_ARG = String.raw`[\w./-]+`
const PIP_ARGS = String.raw`(?:${FLAG}|\s+-r\s+${PATH_ARG}|\s+-e\s+\.[\w./-]*|\s+\.)*`

/** The verbs a `make` target or a package-manager script name must start with to be replayed: the build, test, lint, setup, install, check, generate and compile family, never a deploy, publish, reset or migration. A name may continue after a verb with `:`, `-` or `_` (`build:prod`, `test-unit`, `lint:fix`) unless {@link UNSAFE_TASK_WORDS} appears anywhere in it. */
export const FIX_TASK_VERBS: readonly string[] = ['build', 'tests?', 'lint', 'typecheck', 'check', 'setup', 'install', 'bootstrap', 'generate', 'gen', 'codegen', 'compile']

/** Words that make a task name unsafe to replay whatever verb it starts with (`build-and-publish`, `test:reset-db`). */
const UNSAFE_TASK_WORDS: readonly string[] = ['deploy', 'publish', 'release', 'reset', 'drop', 'migrat', 'seed', 'push', 'upload', 'prune', 'wipe', 'destroy', 'clean', 'purge', 'delete', 'rollback']

const TASK = String.raw`(?!\S*(?:${UNSAFE_TASK_WORDS.join('|')}))(?:${FIX_TASK_VERBS.join('|')})(?:[:_-][\w:.-]*)?(?=\s|$)`

export interface FixVerbClass {
  name: string
  pattern: RegExp
  /** A command the class accepts; the test file derives its accepted cases from it. */
  example: string
}

/** The one list of verbs a stored fix may start with, after leading `VAR=value` and wrappers are peeled. Package-adding forms (`npm i left-pad`, `pip install foo`, `cargo add`, `yarn add`) match none of these: only argument-free installs and installs from a manifest do. */
export const FIX_VERB_ALLOWLIST: readonly FixVerbClass[] = [
  { name: 'js package manager install, build or test', pattern: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|test|t|build|rebuild)${FLAG}*$`), example: 'npm ci' },
  { name: 'js package manager script', pattern: new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+run\s+${TASK}${FLAG}*$`), example: 'npm run build' },
  { name: 'pip install from a manifest', pattern: new RegExp(String.raw`^(?:python3?\s+-m\s+)?pip3?\s+install${PIP_ARGS}$`), example: 'pip install -r requirements.txt' },
  { name: 'uv pip install from a manifest', pattern: new RegExp(String.raw`^uv\s+pip\s+install${PIP_ARGS}$`), example: 'uv pip install -e .' },
  { name: 'python environment sync', pattern: new RegExp(String.raw`^(?:uv\s+sync|poetry\s+install|pipenv\s+(?:install|sync))${FLAG}*$`), example: 'uv sync' },
  { name: 'cargo', pattern: new RegExp(String.raw`^cargo\s+(?:build|test|fetch|check)${FLAG}*$`), example: 'cargo fetch' },
  { name: 'go build and test', pattern: new RegExp(String.raw`^go\s+(?:build|test|vet)(?:${FLAG}|\s+\.{1,2}/[\w./-]*)*$`), example: 'go test ./...' },
  { name: 'go modules', pattern: new RegExp(String.raw`^go\s+mod\s+(?:download|tidy|vendor)${FLAG}*$`), example: 'go mod download' },
  { name: 'make target', pattern: new RegExp(String.raw`^make(?:\s+${TASK}|${FLAG})*$`), example: 'make setup' },
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

/** A flag that points an install at another package index or registry, or hands make or pip another file (`-i`, `-f`, `-c`), in the spaced or the `=` form. Refused whatever its value, because the value would be a host or file the error text chose. */
const SOURCE_FLAG = /(?:^|\s)(?:--?(?:index-url|extra-index-url|default-index|index|find-links|registry|trusted-host|proxy|repository|repository-url|file|makefile)|-[ifc])(?:=|\s|$)/i

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

/** Stands in for the failed command itself in a stored fix: its arguments are free text (`pytest -k <anything>`) and an allowlist can not tell a test name from a secret, so the text is never kept and the fix says only that the same command was run again. */
export const RERUN_PLACEHOLDER = '(the same command)'

/** What may sit in front of {@link RERUN_PLACEHOLDER}: nothing, or a runner word with no flag of its own. A leading `VAR=value`, `env`, or a wrapper flag carries free text, so a rerun behind one is not learned. */
const SAFE_LEAD = /^(?:(?:npx\s+(?:(?:-y|--yes|--no-install)\s+)*|bunx\s+|uv\s+run\s+|poetry\s+run\s+|pipenv\s+run\s+|pnpm\s+exec\s+))?$/

/** Whether the failed command `core` may be rerun by name in a stored fix: a runner or a listing, or an allowlisted verb, with no pipe, chain, redirect or source flag. */
export function rerunIsAllowed(core: string): boolean {
  if (FORBIDDEN_IN_PART.test(core) || SOURCE_FLAG.test(core)) return false
  return RERUN_COMMAND.test(core) || FIX_VERB_ALLOWLIST.some((verb) => verb.pattern.test(core))
}

/** `make -e` (or `--environment-overrides`) lets the caller's environment override the Makefile's own variables, which {@link DANGEROUS_ENV} does not see in a part that sets none. */
const MAKE_ENV_OVERRIDE = /^make\b.*\s(?:-e|--environment-overrides)(?=\s|$)/

/** Whether every `&&` part of `fix` is safe to show a later session as history. A part is accepted when it starts with an allowlisted verb or ends in {@link RERUN_PLACEHOLDER} behind a {@link SAFE_LEAD}; the failed command is never kept as text, so there is no third way in. */
export function fixIsAllowed(fix: string, wrappers: RegExp): boolean {
  for (const part of fix.split(' && ')) {
    if (part === '' || FORBIDDEN_IN_PART.test(part) || SOURCE_FLAG.test(part)) return false
    if (part.endsWith(RERUN_PLACEHOLDER)) {
      if (!SAFE_LEAD.test(part.slice(0, part.length - RERUN_PLACEHOLDER.length))) return false
      continue
    }
    if (leadingAssignmentNames(part).some((name) => DANGEROUS_ENV.test(name))) return false
    const core = coreOf(part, wrappers)
    if (MAKE_ENV_OVERRIDE.test(core) || !FIX_VERB_ALLOWLIST.some((verb) => verb.pattern.test(core))) return false
  }
  return true
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(?:^|\s)--?(?:password|passwd|passphrase|pass|pwd|pw|token|api[-_]?key|secret|access[-_]?key|client[-_]?secret|auth|cookie|credentials?)(?:=|\s+)\S/i,
  /(?:^|\s)(?:-u|--user)\s+\S*:\S/,
  /\b(?:mysql|mysqldump|mysqladmin|psql|pg_dump|pg_restore|mongo\w*|redis-cli|sqlcmd)\b[^|;&]*\s-(?:p\S|W\s+\S)/i,
  /(?:^|[\s;&|])(?:[A-Za-z_]\w*)?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|PASS|PWD|PAT|CRED|CREDENTIALS?|AUTH)=/i,
  /\bsshpass\b/i,
  /\bopenssl\b[^|;&]*\s-(?:k|kfile|pass|passin|passout)\s+\S/i,
  /(?:^|\s)(?:-H|--header)[\s=]+["']?[\w-]*(?:auth|token|key|secret|cookie|session|passw)[\w-]*\s*:\s*\S/i,
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
  /\b(?:authorization|bearer)\b/i,
]

/** Whether `text` holds a credential, by the redactor, its precise patterns, or the command-line shapes the redactor's generic pattern misses (`--token abc`, `-u user:pw`, `-pSECRET`, `GITHUB_TOKEN=...`). Anything that does is neither stored nor replayed. */
export function carriesCredential(text: string): boolean {
  return redactSecrets(text).text !== text || hasPreciseSecret(text) || CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))
}
