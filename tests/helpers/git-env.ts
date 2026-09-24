// CAPTURE: `git rev-parse --local-env-vars` on git 2.53.0.windows.1 -- git's own list of the variables that tie a process to one particular repository, which it clears itself before entering a submodule. tests/guards/test_process_inherits_no_repository_env.test.ts asserts this still covers whatever the installed git prints.
export const REPO_LOCAL_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
] as const

/** Deletes every repository-location variable from `env`, so a git command run with it finds its repository from its working directory alone. Git exports some of these to every hook: `GIT_INDEX_FILE` always, and `GIT_DIR` as an absolute path whenever the commit is made from a linked worktree. A test that inherits them and then builds a scratch repository with `git init` in a temp directory is not building one: `init` reinitializes the hook's repository and marks it bare, `config user.*` rewrites that repository's shared config, and `add`/`commit` write the fixture into its index and onto its branch. */
export function scrubRepoLocalGitEnv(env: NodeJS.ProcessEnv): void {
  for (const name of REPO_LOCAL_GIT_ENV_VARS) delete env[name]
}
