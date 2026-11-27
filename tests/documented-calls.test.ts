/**
 * Tool calls written out for an agent to copy -- `calendar(action="listEvents", timeMin="...")`
 * in a packaged skill, a help doc under `src/docs` or the README -- have to match what the
 * server lists. A call that names an action outside the tool's enum gets `Unknown action`
 * back, and a parameter the schema does not list is dropped by clients that filter
 * arguments by schema. This test reads every such call and checks it against the tools/list
 * reply of the real registry.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { registerTools } from '../src/tools/registry.js'

const ROOT = resolve(__dirname, '..')

interface ListedTool {
  name: string
  inputSchema: { properties: Record<string, { enum?: string[] }> }
}

async function listedTools(): Promise<Map<string, ListedTool>> {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' }, { capabilities: { resources: {} } })
  registerTools(server)
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, ctx: unknown) => Promise<unknown>>
    }
  )._requestHandlers
  const listTools = handlers.get('tools/list')
  if (!listTools) throw new Error('registerTools did not register a tools/list handler')
  const { tools } = (await listTools({ method: 'tools/list' }, {})) as { tools: ListedTool[] }
  return new Map(tools.map((tool) => [tool.name, tool]))
}

function documents(): string[] {
  const skills = readdirSync(join(ROOT, 'skills')).map((name) => join(ROOT, 'skills', name, 'SKILL.md'))
  const docs = readdirSync(join(ROOT, 'src', 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(ROOT, 'src', 'docs', name))
  return [...skills, ...docs, join(ROOT, 'README.md')]
}

// A call is an inline code span holding `name(arg="..." , ...)` with `action` among the args.
const CALL = /`(\w+)\(([^`)]*\baction="[^`)]*)\)`/g
const ARG = /(\w+)="/g
const ACTION = /\baction="(\w+)"/

describe('documented tool calls', () => {
  it('name a listed tool, an action from its enum and parameters from its schema', async () => {
    const tools = await listedTools()
    const calls: string[] = []
    const problems: string[] = []
    for (const file of documents()) {
      const where = relative(ROOT, file)
      for (const [call, name, args] of readFileSync(file, 'utf8').matchAll(CALL)) {
        calls.push(call)
        const tool = tools.get(name)
        if (!tool) {
          problems.push(`${where}: ${call} names no listed tool`)
          continue
        }
        const action = ACTION.exec(args)?.[1] ?? ''
        if (!tool.inputSchema.properties.action?.enum?.includes(action)) {
          problems.push(`${where}: ${call} uses action ${action}, not in the ${name} enum`)
        }
        for (const [, param] of args.matchAll(ARG)) {
          if (!(param in tool.inputSchema.properties)) {
            problems.push(`${where}: ${call} passes ${param}, not in the ${name} schema`)
          }
        }
      }
    }
    // The packaged skills alone hold two calls; finding none means the pattern broke.
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(problems).toEqual([])
  })
})
