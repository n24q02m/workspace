import { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./tools/registry.js', () => ({ registerTools: vi.fn() }))

import { createMCPServer } from './create-server.js'
import { registerTools } from './tools/registry.js'

describe('createMCPServer', () => {
  it('returns an McpServer with tools registered', () => {
    const server = createMCPServer()

    expect(server).toBeInstanceOf(McpServer)
    expect(registerTools).toHaveBeenCalledWith(server)
  })
})
