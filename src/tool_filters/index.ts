// Public surface of the bash-output compression filter framework.

export * from './helpers.js'
export { CompressedOutput, ToolFilter } from './base.js'
export type { ApplyOptions } from './base.js'
export { GenericFilter } from './generic.js'
export {
  TOOL_FILTERS,
  selectFilter,
  detectFromCommand,
  tryWrapCompoundSegments,
  compressOutput,
  filterByName,
} from './dispatch.js'
export type { CompressOptions } from './dispatch.js'
