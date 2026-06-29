// Public surface of the bash-output compression filter framework.

export * from './helpers.js'
export { CompressedOutput, ToolFilter } from './base.js'
export type { ApplyOptions } from './base.js'
export { GenericFilter } from './generic.js'
export { makeNodeTestRunnerFilter, plural } from './families.js'
export type { NodeTestRunnerConfig } from './families.js'
export { jestFilter, vitestFilter, TEST_RUNNER_FILTERS } from './test_runners.js'
export {
  TOOL_FILTERS,
  selectFilter,
  detectFromCommand,
  tryWrapCompoundSegments,
  compressOutput,
  filterByName,
} from './dispatch.js'
export type { CompressOptions } from './dispatch.js'
