import { registerSandboxLifecycle, registerStaleRows } from './helpers/native_hook_e2e_rows.js'

registerSandboxLifecycle()
registerStaleRows(['node', 'absent'])
