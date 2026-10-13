/** Registers the subagent hooks of hooks_agent_spawn.ts behind dynamic imports, so the hook entry does not parse that module's briefing, report-compaction and roster code on every tool call; it loads on the first subagent event. */

import { registerHook } from './hook_registry.js'
import { loadingHiddenRuleCheck } from './rewrite_permission.js'
import type * as AgentReceiptModule from './agent_receipt.js'
import type * as AgentSpawnModule from './hooks_agent_spawn.js'

const loadAgentSpawn = (): Promise<typeof AgentSpawnModule> => import('./hooks_agent_spawn.js')
const loadAgentReceipt = (): Promise<typeof AgentReceiptModule> => import('./agent_receipt.js')

registerHook('subagent_start', async (event) => (await loadAgentSpawn()).subagentStartHandler(event))
// advisory: the handlers that share this event must all still run, whichever module registered first.
registerHook('subagent_stop', async (event) => (await loadAgentReceipt()).subagentReceiptHandler(event), { advisory: true })
registerHook('subagent_stop', async (event) => (await loadAgentReceipt()).subagentStopHandler(event), { advisory: true })
registerHook('subagent_stop', async (event) => (await loadAgentSpawn()).subagentReportRewriteHandler(event), { advisory: true })
const preAgent = loadingHiddenRuleCheck(async (event: Parameters<typeof AgentSpawnModule.preAgentHandler>[0]) => (await loadAgentSpawn()).preAgentHandler(event))
const postAgent = async (event: Parameters<typeof AgentSpawnModule.postAgentHandler>[0]) => (await loadAgentSpawn()).postAgentHandler(event)
// Written out one per line, not looped over the table of spawn tools: tests/hooks_cli.test.ts scans the source for literal registerHook toolName arguments to prove every name a harness maps to has a handler. A test pins these lines to the table's keys (SPAWN_TOOL_BRIEF_FIELD in hooks_agent_spawn.ts).
registerHook('pre_tool_use', preAgent, { toolName: 'Agent' })
registerHook('pre_tool_use', preAgent, { toolName: 'task' })
registerHook('pre_tool_use', preAgent, { toolName: 'Task' })
registerHook('pre_tool_use', preAgent, { toolName: 'spawn_agent' })
registerHook('post_tool_use', postAgent, { toolName: 'Agent' })
registerHook('post_tool_use', postAgent, { toolName: 'task' })
registerHook('post_tool_use', postAgent, { toolName: 'Task' })
registerHook('post_tool_use', postAgent, { toolName: 'spawn_agent' })
registerHook('post_tool_use', async (event) => (await loadAgentReceipt()).waitAgentHandler(event), { toolName: 'multi_agent_v1wait_agent' })
