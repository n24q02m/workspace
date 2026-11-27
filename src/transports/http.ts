/**
 * HTTP transport: Streamable HTTP `/mcp` serving MCP 2026-07-28 (with stateless
 * 2025-11-25 compatibility) and hull's per-user bearer-token authentication.
 *
 * Auth is hull's `multi` mode: every `/mcp` request carries
 * `Authorization: Bearer <token>`, hull maps the token to a user row in the
 * users file, and that row's `namespace` is the credential bucket for the
 * request via `AsyncLocalStorage` (`currentUser()` in subject-context.ts).
 * Google consent is NOT served over HTTP; it runs from the CLI `auth` command
 * on the host (`src/auth/cli-auth.ts`).
 */
import { createServer } from 'node:http'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { Authenticator, guardRequest } from '@n24q02m/hull/token-auth'
import { jsonResponse } from '@n24q02m/hull/transport'
import { SERVER_NAME } from '../constants.js'
import { loadWorkspaceSkillsCatalog, type WorkspaceSkillCatalog } from '../skills.js'
import { registerTools } from '../tools/registry.js'
import { getPackageVersion } from '../version.js'

/**
 * Users file for `multi` auth. Unset means hull's default (`~/.hull/users.toml`).
 * Mint tokens and rows with the CLI `token` command; the file never holds raw tokens.
 */
export const USERS_FILE_ENV = 'WORKSPACE_USERS_FILE'

export interface WorkspaceHttpOptions {
  port?: number
  host?: string
  usersFile?: string
  skillsCatalog?: WorkspaceSkillCatalog
}

export interface WorkspaceHttpHandle {
  host: string
  port: number
  close: () => Promise<void>
}

/**
 * Create and start the authenticated Streamable HTTP server for Better Workspace MCP.
 * Serves `2026-07-28` (`server/discover`, MRTR elicitation, `io.modelcontextprotocol/skills`,
 * `io.modelcontextprotocol/files`) alongside stateless `2025-11-25` fallback on `/mcp`,
 * plus `/health`.
 */
export async function createWorkspaceHttpServer(options: WorkspaceHttpOptions = {}): Promise<WorkspaceHttpHandle> {
  const host = options.host ?? '127.0.0.1'
  const wantedPort = options.port ?? 0
  const authenticator = new Authenticator({ mode: 'multi', usersFile: options.usersFile })
  const skillsCatalog = options.skillsCatalog ?? (await loadWorkspaceSkillsCatalog())

  const mcpHandler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: SERVER_NAME, version: getPackageVersion() },
        { capabilities: { resources: {} } }
      )
      skillsCatalog.attach(server)
      registerTools(server, { allowLocalFilesystem: false })
      return server
    },
    {
      onerror: (error) => {
        console.error(`[${SERVER_NAME}] http error:`, error.message)
      }
    }
  )

  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      console.error(`[${SERVER_NAME}] http handler error:`, error.message)
    }
  })

  const dispatch = async (req: Parameters<typeof nodeMcpHandler>[0], res: Parameters<typeof nodeMcpHandler>[1]) => {
    const rawReq = req as import('node:http').IncomingMessage
    const rawRes = res as import('node:http').ServerResponse
    const url = new URL(rawReq.url ?? '/', `http://${rawReq.headers.host ?? 'localhost'}`)
    if (url.pathname === '/health') {
      jsonResponse(rawRes, 200, { status: 'ok', server: SERVER_NAME })
      return
    }
    if (url.pathname === '/mcp') {
      await guardRequest(authenticator, rawReq, rawRes, () => nodeMcpHandler(rawReq, rawRes))
      return
    }
    jsonResponse(rawRes, 404, { error: 'not_found' })
  }

  const httpServer = createServer((req, res) => {
    dispatch(req, res).catch(() => {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'internal_error' })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(wantedPort, host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  const addr = httpServer.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : wantedPort

  return {
    host,
    port: actualPort,
    close: async () => {
      await mcpHandler.close().catch(() => undefined)
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

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
  const usersFile = process.env[USERS_FILE_ENV] || undefined
  const skillsCatalog = await loadWorkspaceSkillsCatalog()

  const handle = await createWorkspaceHttpServer({
    port,
    host,
    usersFile,
    skillsCatalog
  })

  console.error(`[${SERVER_NAME}] http mode on http://${handle.host}:${handle.port}/mcp`)

  // The listening socket keeps the loop alive; this wait lets SIGINT/SIGTERM reach
  // handle.close() cleanly instead of leaving connections mid-flight.
  await new Promise<void>((resolve) => {
    let closed = false
    const shutdown = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close()
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}
