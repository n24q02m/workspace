/**
 * HTTP transport: Streamable HTTP `/mcp` served by hull, with a per-user bearer table.
 *
 * Auth is hull's `multi` mode: every request carries `Authorization: Bearer <token>`,
 * hull maps the token to a user row in the users file, and that row's `namespace` is
 * the credential bucket for the request (see subject-context.ts). Google consent is
 * NOT served over HTTP; it runs from the CLI `auth` command on the host
 * (src/auth/cli-auth.ts), which wraps add-account.ts.
 *
 * Session-based (one Server per MCP session), because the SDK stateless mode is not
 * used by hull.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runHttpServer } from '@n24q02m/hull/transport'
import { SERVER_NAME } from '../constants.js'
import { registerTools } from '../tools/registry.js'
import { getPackageVersion } from '../version.js'

/**
 * Users file for `multi` auth. Unset means hull's default (`~/.hull/users.toml`).
 * Mint tokens and rows with the CLI `token` command; the file never holds raw tokens.
 */
export const USERS_FILE_ENV = 'WORKSPACE_USERS_FILE'

export async function startHttp(): Promise<void> {
  // Per-user credential stores (PerPluginStore with a subject) derive their encryption key
  // from CREDENTIAL_SECRET and throw on first write without it. Refuse at startup so the
  // failure cannot surface in the middle of a user's consent.
  if (!process.env.CREDENTIAL_SECRET) {
    throw new Error(
      'CREDENTIAL_SECRET is required for http mode: per-user credential stores derive their encryption key from it.'
    )
  }

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0
  const host = process.env.HOST

  const handle = await runHttpServer(
    () => {
      // One Server per MCP session. hull types the factory as McpServer but only calls
      // `.connect(transport)`, which the low-level Server also implements.
      const server = new Server(
        { name: SERVER_NAME, version: getPackageVersion() },
        { capabilities: { tools: {}, resources: {} } }
      )
      registerTools(server, { allowLocalFilesystem: false })
      return server as unknown as McpServer
    },
    {
      serverName: SERVER_NAME,
      port,
      host,
      auth: { mode: 'multi', usersFile: process.env[USERS_FILE_ENV] || undefined }
    }
  )

  console.error(`[${SERVER_NAME}] http mode on http://${handle.host}:${handle.port}/mcp`)

  // The listening socket keeps the loop alive; this wait lets SIGINT/SIGTERM reach
  // handle.close() (closes the transport and removes the lock file) instead of cutting it.
  await new Promise<void>((resolve) => {
    const shutdown = async (): Promise<void> => {
      await handle.close()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
