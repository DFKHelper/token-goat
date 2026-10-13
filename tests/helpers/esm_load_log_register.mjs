// The --import preload that installs esm_load_log.mjs. The log path arrives in ESM_LOAD_LOG.
import { register } from 'node:module'
import process from 'node:process'

register('./esm_load_log.mjs', { parentURL: import.meta.url, data: { logPath: process.env.ESM_LOAD_LOG } })
