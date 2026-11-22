import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { registerTools } from '../src/tools/registry.js'

// The tool surface a stdio client sees must match the recorded fixture, so any
// change to a tool name, description or schema shows up as a fixture diff in
// review. The fixture is regenerated from the built registry when a change is
// made on purpose; the per-field contracts are asserted in registry.test.ts.
const here = dirname(fileURLToPath(import.meta.url))
const expected = JSON.parse(readFileSync(join(here, 'fixtures', 'tools_expected.json'), 'utf8')) as {
  tools: unknown[]
}

describe('tool surface parity', () => {
  it('registers exactly the fixture tools with identical names, descriptions and schemas', async () => {
    // registerTools only needs setRequestHandler; capture the tools/list handler directly.
    const handlers = new Map<unknown, (request: unknown) => Promise<unknown>>()
    const fakeServer = {
      setRequestHandler: (schema: unknown, handler: (request: unknown) => Promise<unknown>) => {
        handlers.set(schema, handler)
      }
    } as unknown as Server
    registerTools(fakeServer)

    const listTools = handlers.get(ListToolsRequestSchema)
    if (!listTools) {
      throw new Error('registerTools did not register a tools/list handler')
    }
    const actual = (await listTools({ method: 'tools/list' })) as { tools: unknown[] }

    expect(actual.tools).toEqual(expected.tools)
  })
})
