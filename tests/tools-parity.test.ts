import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
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
    const server = new McpServer({ name: 'test-server', version: '0.0.0' }, { capabilities: { resources: {} } })
    registerTools(server)

    const handlers = (
      server.server as unknown as {
        _requestHandlers: Map<string, (request: unknown, ctx: unknown) => Promise<unknown>>
      }
    )._requestHandlers
    const listTools = handlers.get('tools/list')
    if (!listTools) {
      throw new Error('registerTools did not register a tools/list handler')
    }
    const actual = (await listTools({ method: 'tools/list' }, {})) as { tools: unknown[] }

    expect(actual.tools).toEqual(expected.tools)
  })
})
