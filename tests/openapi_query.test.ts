import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Stub config so the overflow guard (used by emitGuarded in runOpenApiOutline/runOpenApiOp's
// text-mode branch) has a deterministic, permissive budget instead of reading a real config.toml
// -- same pattern read_commands.test.ts uses for its own runJsonOutline/runJsonQuery coverage.
vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}))

import {
  parseOpenApiSpec,
  extractOperations,
  formatOpenApiOutline,
  findOperation,
  operationLabel,
  formatOperationDetail,
  type OpenApiOperation,
} from '../src/openapi_query.js'
import { runOpenApiOutline, runOpenApiOp } from '../src/read_commands.js'
import { loadConfig } from '../src/config.js'

const mockLoadConfig = vi.mocked(loadConfig)

/** Capture stdout/stderr for a function call. */
function capture(fn: () => void): { stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (s: string) => { stderr += s; return true }
  try {
    fn()
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = origOut
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = origErr
  }
  return { stdout, stderr }
}

const SPEC_JSON = {
  openapi: '3.0.0',
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List users',
        tags: ['users'],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a user',
        tags: ['users'],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/users/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getUserById',
        summary: 'Get a user by ID',
        description: 'Fetches a single user by their unique identifier.',
        tags: ['users'],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
  },
}

const SPEC_YAML = `
openapi: "3.0.0"
paths:
  /pets:
    get:
      operationId: listPets
      summary: List pets
      tags: [pets]
      responses:
        "200":
          description: OK
  /pets/{id}:
    get:
      operationId: getPetById
      summary: Get a pet by ID
      tags: [pets]
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK
        "404":
          description: Not found
`

// ---- pure module: parseOpenApiSpec -----------------------------------------

describe('parseOpenApiSpec', () => {
  it('parses .json content as JSON', () => {
    const data = parseOpenApiSpec(JSON.stringify(SPEC_JSON), 'openapi.json')
    expect(data).toEqual(SPEC_JSON)
  })

  it('parses .yaml content as YAML', () => {
    const data = parseOpenApiSpec(SPEC_YAML, 'openapi.yaml') as { paths: Record<string, unknown> }
    expect(Object.keys(data.paths)).toEqual(['/pets', '/pets/{id}'])
  })

  it('parses .yml content as YAML', () => {
    const data = parseOpenApiSpec(SPEC_YAML, 'openapi.yml') as { paths: Record<string, unknown> }
    expect(Object.keys(data.paths)).toEqual(['/pets', '/pets/{id}'])
  })

  it('falls back to YAML for an unrecognized extension when JSON parsing fails', () => {
    const data = parseOpenApiSpec(SPEC_YAML, 'openapi.spec') as { paths: Record<string, unknown> }
    expect(Object.keys(data.paths)).toEqual(['/pets', '/pets/{id}'])
  })

  it('throws on malformed JSON with a .json extension', () => {
    expect(() => parseOpenApiSpec('{ not valid json', 'openapi.json')).toThrow()
  })

  it('strips a leading UTF-8 BOM before parsing .json content (fail-on-buggy: JSON.parse throws "Unexpected token" on a BOM-prefixed file, common from Windows editors)', () => {
    const data = parseOpenApiSpec('﻿' + JSON.stringify(SPEC_JSON), 'openapi.json')
    expect(data).toEqual(SPEC_JSON)
  })
})

// ---- pure module: extractOperations / formatOpenApiOutline ----------------

describe('extractOperations', () => {
  it('flattens paths into one entry per method, sorted by path then method', () => {
    const ops = extractOperations(SPEC_JSON)
    expect(ops.map((o) => `${o.method} ${o.path}`)).toEqual([
      'GET /users',
      'POST /users',
      'GET /users/{id}',
    ])
  })

  it('merges path-level parameters ahead of the operation own parameters', () => {
    const ops = extractOperations(SPEC_JSON)
    const getById = ops.find((o) => o.operationId === 'getUserById')
    expect(getById?.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }])
  })

  it('lets an operation-level parameter override a path-level one sharing the same name+location instead of duplicating it', () => {
    const spec = {
      openapi: '3.0.0',
      paths: {
        '/widgets/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'generic id' }],
          get: {
            operationId: 'getWidget',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'the widget id' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    }
    const ops = extractOperations(spec)
    const getWidget = ops.find((o) => o.operationId === 'getWidget')
    expect(getWidget?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'the widget id' },
    ])
  })

  it('captures operationId, summary, description, and tags when present', () => {
    const ops = extractOperations(SPEC_JSON)
    const getById = ops.find((o) => o.operationId === 'getUserById')
    expect(getById?.summary).toBe('Get a user by ID')
    expect(getById?.description).toBe('Fetches a single user by their unique identifier.')
    expect(getById?.tags).toEqual(['users'])
  })

  it('captures requestBody and responses', () => {
    const ops = extractOperations(SPEC_JSON)
    const create = ops.find((o) => o.operationId === 'createUser')
    expect(create?.requestBody).toBeDefined()
    expect(Object.keys(create?.responses ?? {})).toEqual(['201'])
  })

  it('returns an empty list for a spec with no paths', () => {
    expect(extractOperations({ openapi: '3.0.0' })).toEqual([])
  })

  it('returns an empty list for non-object input', () => {
    expect(extractOperations(null)).toEqual([])
    expect(extractOperations('not a spec')).toEqual([])
  })
})

describe('formatOpenApiOutline', () => {
  it('renders one line per operation with method, path, operationId, summary, and tags', () => {
    const text = formatOpenApiOutline(extractOperations(SPEC_JSON))
    expect(text).toContain('GET')
    expect(text).toContain('/users/{id}')
    expect(text).toContain('[getUserById]')
    expect(text).toContain('- Get a user by ID')
    expect(text).toContain('(users)')
  })

  it('reports no operations distinctly', () => {
    expect(formatOpenApiOutline([])).toBe('(no operations found)')
  })
})

// ---- pure module: findOperation / operationLabel / formatOperationDetail --

describe('findOperation', () => {
  const ops = extractOperations(SPEC_JSON)

  it('finds an operation by exact operationId', () => {
    const match = findOperation(ops, 'getUserById')
    expect(match?.path).toBe('/users/{id}')
    expect(match?.method).toBe('GET')
  })

  it('finds an operation by "METHOD path", method matched case-insensitively', () => {
    const match = findOperation(ops, 'get /users/{id}')
    expect(match?.operationId).toBe('getUserById')
  })

  it('returns undefined when neither operationId nor METHOD path matches', () => {
    expect(findOperation(ops, 'doesNotExist')).toBeUndefined()
    expect(findOperation(ops, 'GET /nope')).toBeUndefined()
  })
})

describe('operationLabel', () => {
  it('prefers operationId with method+path context', () => {
    const op: OpenApiOperation = { method: 'GET', path: '/x', operationId: 'getX', parameters: [], responses: {} }
    expect(operationLabel(op)).toBe('getX  (GET /x)')
  })

  it('falls back to METHOD path when no operationId', () => {
    const op: OpenApiOperation = { method: 'GET', path: '/x', parameters: [], responses: {} }
    expect(operationLabel(op)).toBe('GET /x')
  })
})

describe('formatOperationDetail', () => {
  it('includes method, path, operationId, summary, description, tags', () => {
    const ops = extractOperations(SPEC_JSON)
    const op = ops.find((o) => o.operationId === 'getUserById')
    if (op === undefined) throw new Error('unreachable')
    const text = formatOperationDetail(op)
    expect(text).toContain('GET /users/{id}')
    expect(text).toContain('operationId: getUserById')
    expect(text).toContain('summary: Get a user by ID')
    expect(text).toContain('description: Fetches a single user by their unique identifier.')
    expect(text).toContain('tags: users')
  })

  it('lists parameters with name, location, required flag, and schema', () => {
    const ops = extractOperations(SPEC_JSON)
    const op = ops.find((o) => o.operationId === 'getUserById')
    if (op === undefined) throw new Error('unreachable')
    const text = formatOperationDetail(op)
    expect(text).toContain('id (path) required')
    expect(text).toContain('"type": "string"')
  })

  it('includes the request body schema when present', () => {
    const ops = extractOperations(SPEC_JSON)
    const op = ops.find((o) => o.operationId === 'createUser')
    if (op === undefined) throw new Error('unreachable')
    const text = formatOperationDetail(op)
    expect(text).toContain('requestBody:')
    expect(text).toContain('application/json')
  })

  it('lists each response status code with its body', () => {
    const ops = extractOperations(SPEC_JSON)
    const op = ops.find((o) => o.operationId === 'getUserById')
    if (op === undefined) throw new Error('unreachable')
    const text = formatOperationDetail(op)
    expect(text).toContain('200:')
    expect(text).toContain('404:')
  })
})

// ---- CLI: runOpenApiOutline / runOpenApiOp ---------------------------------

describe('runOpenApiOutline / runOpenApiOp', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-openapi-cmds-'))
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('runOpenApiOutline', () => {
    it('summarizes a valid JSON spec as one line per operation', () => {
      const f = path.join(tempDir, 'openapi.json')
      fs.writeFileSync(f, JSON.stringify(SPEC_JSON))
      const { stdout } = capture(() => { runOpenApiOutline({ file: f }) })
      expect(stdout).toContain('GET')
      expect(stdout).toContain('/users/{id}')
      expect(stdout).toContain('[getUserById]')
    })

    it('summarizes a valid YAML spec as one line per operation', () => {
      const f = path.join(tempDir, 'openapi.yaml')
      fs.writeFileSync(f, SPEC_YAML)
      const { stdout } = capture(() => { runOpenApiOutline({ file: f }) })
      expect(stdout).toContain('GET')
      expect(stdout).toContain('/pets/{id}')
      expect(stdout).toContain('[getPetById]')
    })

    it('emits a structured JSON array under --json', () => {
      const f = path.join(tempDir, 'openapi.json')
      fs.writeFileSync(f, JSON.stringify(SPEC_JSON))
      const { stdout } = capture(() => { runOpenApiOutline({ file: f, json: true }) })
      const parsed = JSON.parse(stdout) as Array<{ operationId?: string }>
      expect(parsed.length).toBe(3)
      expect(parsed.map((o) => o.operationId)).toContain('getUserById')
    })

    it('returns 1 when the file does not exist', () => {
      const code = runOpenApiOutline({ file: path.join(tempDir, 'missing.json') })
      expect(code).toBe(1)
    })

    it('returns 1 with a clear message on a malformed spec (neither JSON nor YAML)', () => {
      const f = path.join(tempDir, 'bad.json')
      // Invalid as JSON (unterminated object) AND invalid as YAML (tab characters are illegal
      // as YAML indentation), so both the .json-forced parser and, for good measure, the
      // extension-less fallback path are exercised as genuinely unparseable.
      fs.writeFileSync(f, '{ "a": \t\tbad\n')
      let code = -1
      const { stderr } = capture(() => { code = runOpenApiOutline({ file: f }) })
      expect(code).toBe(1)
      expect(stderr).toContain('Failed to parse OpenAPI spec')
    })
  })

  describe('runOpenApiOp', () => {
    it('finds an operation by operationId and prints full detail', () => {
      const f = path.join(tempDir, 'openapi.json')
      fs.writeFileSync(f, JSON.stringify(SPEC_JSON))
      const { stdout } = capture(() => { runOpenApiOp({ file: f, operation: 'getUserById' }) })
      expect(stdout).toContain('GET /users/{id}')
      expect(stdout).toContain('id (path) required')
      expect(stdout).toContain('404:')
    })

    it('finds an operation by "METHOD path"', () => {
      const f = path.join(tempDir, 'openapi.json')
      fs.writeFileSync(f, JSON.stringify(SPEC_JSON))
      const { stdout } = capture(() => { runOpenApiOp({ file: f, operation: 'GET /users/{id}' }) })
      expect(stdout).toContain('operationId: getUserById')
    })

    it('finds an operation in a YAML spec', () => {
      const f = path.join(tempDir, 'openapi.yaml')
      fs.writeFileSync(f, SPEC_YAML)
      const { stdout } = capture(() => { runOpenApiOp({ file: f, operation: 'listPets' }) })
      expect(stdout).toContain('GET /pets')
    })

    it('emits structured JSON under --json', () => {
      const f = path.join(tempDir, 'openapi.json')
      fs.writeFileSync(f, JSON.stringify(SPEC_JSON))
      const { stdout } = capture(() => { runOpenApiOp({ file: f, operation: 'getUserById', json: true }) })
      const parsed = JSON.parse(stdout) as { operationId: string; responses: Record<string, unknown> }
      expect(parsed.operationId).toBe('getUserById')
      expect(Object.keys(parsed.responses)).toEqual(['200', '404'])
    })

    it('returns 1 with a not-found message plus close-match suggestions when the operation is absent', () => {
      const f = path.join(tempDir, 'openapi.json')
      fs.writeFileSync(f, JSON.stringify(SPEC_JSON))
      let code = -1
      const { stderr } = capture(() => { code = runOpenApiOp({ file: f, operation: 'nonExistentOp' }) })
      expect(code).toBe(1)
      expect(stderr).toContain("Operation 'nonExistentOp' not found")
      expect(stderr).toContain('Did you mean:')
      expect(stderr).toContain('getUserById')
    })

    it('returns 1 when the file does not exist', () => {
      const code = runOpenApiOp({ file: path.join(tempDir, 'missing.json'), operation: 'x' })
      expect(code).toBe(1)
    })

    it('returns 1 with a clear message on a malformed spec', () => {
      const f = path.join(tempDir, 'bad.json')
      fs.writeFileSync(f, '{ "a": \t\tbad\n')
      let code = -1
      const { stderr } = capture(() => { code = runOpenApiOp({ file: f, operation: 'x' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('Failed to parse OpenAPI spec')
    })
  })
})
