// Public surface of the bash-output compression filter framework.

export * from './helpers.js'
export { CompressedOutput, ToolFilter } from './base.js'
export type { ApplyOptions } from './base.js'
export { GenericFilter } from './generic.js'
export { makeNodeTestRunnerFilter, makePackageManagerFilter, makeLinterFilter, plural } from './families.js'
export type { NodeTestRunnerConfig, PackageManagerFilterConfig, LinterFilterConfig, DropRule } from './families.js'
export { jestFilter, vitestFilter, TEST_RUNNER_FILTERS } from './test_runners.js'
export { PytestFilter, pytestFilter } from './pytest.js'
export { GoTestFilter, goTestFilter } from './go_test.js'
export { PACKAGE_MANAGER_FILTERS } from './package_managers.js'
export { LINTER_FILTERS } from './linters.js'
export {
  TOOL_FILTERS,
  selectFilter,
  detectFromCommand,
  tryWrapCompoundSegments,
  compressOutput,
  filterByName,
} from './dispatch.js'
export type { CompressOptions } from './dispatch.js'
