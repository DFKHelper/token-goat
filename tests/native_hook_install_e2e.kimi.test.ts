import { registerHarnessRows, registerSandboxLifecycle } from './helpers/native_hook_e2e_rows.js'

registerSandboxLifecycle()
registerHarnessRows('kimi', ['serve', 'switch', 'doctor'])
