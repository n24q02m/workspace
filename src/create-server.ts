/**
 * Shared MCP Server Factory
 * Creates a configured MCP server instance reusable across transports
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { SERVER_NAME } from './constants.js'
import { registerTools } from './tools/registry.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Create a configured MCP server with all tools registered.
 * Single-account M1 -- no client factory param (unlike better-notion-mcp);
 * tools resolve the Google client from credential-state internally. Used
 * later by HTTP (M3); created now for parity with the other servers.
 */
export function createMCPServer(): McpServer {
  const server = new McpServer(
    { name: `@n24q02m/${SERVER_NAME}`, version: getVersion() },
    { capabilities: { resources: {} } }
  )
  registerTools(server)
  return server
}
