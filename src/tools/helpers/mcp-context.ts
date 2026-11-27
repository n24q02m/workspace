/**
 * Per-invocation MCP context carried across `dispatchTool` -> domain helpers.
 *
 * Domain functions (`drive`, `gmail`, `docs`, `slides`, `config`) keep a plain
 * `(input) => Promise<CallToolResult>` signature shared with the CLI adapter;
 * AsyncLocalStorage propagates the active MCP `ServerContext` and client
 * capabilities when running inside an MCP `tools/call` handler, and resolves
 * to `undefined` for headless CLI / direct calls.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { CLIENT_CAPABILITIES_META_KEY, type ClientCapabilities, type ServerContext } from '@modelcontextprotocol/server'
import { FILES_EXTENSION_ID } from '@n24q02m/hull/extensions'

export interface McpDispatchContext {
  serverContext?: ServerContext
  clientCapabilities?: ClientCapabilities
}

const storage = new AsyncLocalStorage<McpDispatchContext>()

export function runWithMcpContext<T>(ctx: McpDispatchContext | undefined, fn: () => Promise<T>): Promise<T> {
  if (!ctx) return fn()
  return storage.run(ctx, fn)
}

export function currentMcpContext(): McpDispatchContext | undefined {
  return storage.getStore()
}

export function getActiveClientCapabilities(
  ctx: McpDispatchContext | undefined = currentMcpContext()
): ClientCapabilities | undefined {
  const envelope = ctx?.serverContext?.mcpReq?.envelope as Record<string, unknown> | undefined
  const envelopeCaps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined
  return envelopeCaps ?? ctx?.clientCapabilities
}

/**
 * True when the connected MCP client declared `io.modelcontextprotocol/files`
 * in its capabilities (via initialize on 2025-11-25 or envelope on 2026-07-28).
 */
export function clientSupportsFilesExtension(ctx: McpDispatchContext | undefined = currentMcpContext()): boolean {
  const caps = getActiveClientCapabilities(ctx)
  const ext = caps?.extensions as Record<string, unknown> | undefined
  if (!ext || !(FILES_EXTENSION_ID in ext)) return false
  const setting = ext[FILES_EXTENSION_ID]
  return setting !== undefined && setting !== false
}
