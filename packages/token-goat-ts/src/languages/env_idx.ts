/**
 * Dotenv / environment variable file extractor.
 *
 * Handles `.env`, `.env.example`, `.env.sample`, `.env.local`, and similar
 * dotenv-family files. Each `KEY=value` at column 0 becomes an `env_key` symbol.
 * Delegates to `ini_idx.extractEnv` for the actual parse logic.
 */

export { extractEnv as extractEnvFile } from './ini_idx.js'
