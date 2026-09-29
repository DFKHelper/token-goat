/** The prefixes every token-goat setting is read under: `TOKEN_GOAT_` and the pre-rename `TOKENWISE_` (src/config.ts ENV_KEYS and CONFIG_KEY_ENV_OVERRIDES still honour `TOKENWISE_COMPACT_ASSIST`). */
export const TOKEN_GOAT_ENV_PREFIXES = ['TOKEN_GOAT_', 'TOKENWISE_'] as const

/** The token-goat variables the suite keeps when it inherits them, because something outside the product sets them on purpose. tests/guards/test_process_inherits_no_token_goat_setting.test.ts fails when CI, a git hook or the test setup names a variable missing here, so a new one cannot be scrubbed without anyone noticing. */
export const KEPT_TOKEN_GOAT_ENV_VARS = [
  // Pinned by tests/setup/isolate-home.ts with "an inherited value wins", so a run can still choose its own.
  'TOKEN_GOAT_HOME',
  'TOKEN_GOAT_EMBEDDINGS_ENABLED',
  'TOKEN_GOAT_NO_WORKER_SPAWN',
  'TOKEN_GOAT_INSTALL_INDEX',
  'TOKEN_GOAT_HARNESS_OVERRIDE',
  'TOKEN_GOAT_HOOK_SERVER',
  'TOKEN_GOAT_NATIVE_HOOKS',
  // Set through GITHUB_ENV by .github/workflows/ci.yml so the embedding tests find the warmed model and fail rather than skip without it.
  'TOKEN_GOAT_MODEL_CACHE_DIR',
  'TOKEN_GOAT_REQUIRE_EMBED_MODEL',
  // Read by .lefthook-scripts/check-commit-msg.sh.
  'TOKEN_GOAT_CONFIDENTIAL_NAMES',
] as const

/** Test-infrastructure switches (tests/setup/build-bundle.ts, tests/setup/max-workers.ts) share this prefix and are all kept. */
export const KEPT_TOKEN_GOAT_ENV_PREFIX = 'TOKEN_GOAT_TEST_'

/** Deletes every token-goat setting from `env` except the ones named above, so a test runs on the product's defaults rather than on whatever the shell that launched the suite had exported. A developer who sets `TOKEN_GOAT_BASH_COMPRESS=0` to read raw output, and then runs `npm test` from that shell, otherwise sees guards fail that pass in CI. */
export function scrubTokenGoatUserEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase()
    if (!TOKEN_GOAT_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    if (upper.startsWith(KEPT_TOKEN_GOAT_ENV_PREFIX)) continue
    if ((KEPT_TOKEN_GOAT_ENV_VARS as readonly string[]).includes(upper)) continue
    delete env[name]
  }
}
