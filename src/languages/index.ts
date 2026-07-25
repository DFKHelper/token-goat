/**
 * Re-exports all language adapters added in the languages/ subdirectory.
 *
 * Adapters for TypeScript/JS, Python, Go, Rust, Ruby, Java, C++, Markdown,
 * JSON, YAML, TOML, CSS, and Dockerfile remain inlined in `parser.ts`.
 * This barrel exports the newer adapters: C#, PHP, HTML, Liquid, Kotlin, Swift,
 * GraphQL, SQL, INI, Makefile, Proto, .env, Apex, and Salesforce metadata.
 */

export * from './common.js'
export * from './csharp.js'
export * from './php.js'
export * from './html.js'
export * from './liquid.js'
export * from './kotlin.js'
export * from './swift.js'
export * from './graphql_idx.js'
export * from './sql_idx.js'
export * from './ini_idx.js'
export * from './makefile_idx.js'
export * from './proto_idx.js'
export * from './terraform_idx.js'
export * from './powershell_idx.js'
export * from './env_idx.js'
export * from './apex.js'
export * from './salesforce_metadata.js'
export * from './salesforce_frontend.js'
export * from './sfc_idx.js'
