/**
 * Unified entry point for Better Workspace MCP
 *
 * The console script is built with hull `buildCli`:
 *   - bare argv or flag-prefixed argv (`--http`) starts the server (`serve`).
 *   - `auth [--user <namespace>]` adds a Google account from the host (src/auth/cli-auth.ts).
 *   - `config`, `status`, `logout`, `doctor`, `token` are hull built-ins over the same store.
 *
 * TRANSPORT_MODE selects the transport:
 *   - "stdio" (default): Local mode. First run opens the Google consent flow on loopback,
 *     then the MCP SDK StdioServerTransport serves directly (no daemon proxy hop).
 *   - "http": Remote mode. hull `runHttpServer` with bearer-token auth (multi-user); each user
 *     has a credential namespace (src/transports/http.ts).
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildCli } from '@n24q02m/hull'
import { authCommand } from './auth/cli-auth.js'
import { getState, resolveCredentialState } from './auth/credential-state.js'
import { runOAuthSetup } from './auth/oauth-setup.js'
import { SERVER_NAME, STORE_PLUGIN } from './constants.js'
import { registerTools } from './tools/registry.js'
import { startHttp } from './transports/http.js'
import { getPackageVersion } from './version.js'

/**
 * Checks if the current module is the main entry point.
 */
export function isMain(importMetaUrl: string): boolean {
  const entrypoint = process.argv[1]
  if (!entrypoint) return false

  try {
    const mainPath = realpathSync(fileURLToPath(importMetaUrl))
    const entryPath = realpathSync(entrypoint)

    if (process.platform === 'win32') {
      // Normalize slashes and casing for Windows
      const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase()
      return normalize(mainPath) === normalize(entryPath)
    }

    return mainPath === entryPath
  } catch {
    return false
  }
}

/**
 * Validates and returns the transport mode from the environment.
 */
export function getTransportMode(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): string {
  const isHttp = argv.includes('--http') || env.MCP_TRANSPORT === 'http' || env.TRANSPORT_MODE === 'http'
  return isHttp ? 'http' : 'stdio'
}

/**
 * Starts the server for the specified mode.
 */
export async function startServer(mode: string): Promise<void> {
  if (process.env.BETTER_WORKSPACE_MCP_BOOTSTRAPPED) {
    console.error(`[${SERVER_NAME}] Startup aborted: server already running in this process tree.`)
    return
  }
  process.env.BETTER_WORKSPACE_MCP_BOOTSTRAPPED = 'true'

  if (mode === 'http') {
    // Remote users are served by the bearer-auth users file, not by a Google consent screen.
    await startHttp()
    return
  }

  // Stdio mode: no static token env var. Google tokens persist to disk via credential-state,
  // so only the FIRST run needs the browser step; later starts resolve straight to 'configured'.
  await resolveCredentialState()
  if (getState() !== 'configured') {
    await runOAuthSetup() // opens browser, persists Google tokens
    await resolveCredentialState() // -> 'configured'
  }

  const server = new Server(
    { name: SERVER_NAME, version: getPackageVersion() },
    { capabilities: { tools: {}, resources: {} } }
  )
  registerTools(server) // NO client factory (single-account M1)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[${SERVER_NAME}] stdio mode ready (v${getPackageVersion()})`)
}

// Global state for the selected mode
export const mode = getTransportMode()

/**
 * Bootstrap function to start the server with error handling.
 */
export async function bootstrap(selectedMode: string = mode) {
  try {
    await startServer(selectedMode)
  } catch (error) {
    console.error('Failed to start server:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

// Builds the console-script CLI and runs it. Exported so the entry wiring is testable.
export function runCli(argv: string[]): Promise<void> {
  const cli = buildCli(SERVER_NAME, {
    serve: () => bootstrap(),
    extra: { auth: authCommand },
    version: getPackageVersion(),
    // Credentials are stored under STORE_PLUGIN, so `config`/`status` must read the same slug.
    pluginName: STORE_PLUGIN
  })
  return cli(argv).then((code) => {
    process.exitCode = code
  })
}

// Only run the CLI when this file is the entry point, and not inside the test environment.
if (isMain(import.meta.url) && process.env.NODE_ENV !== 'test') {
  runCli(process.argv.slice(2))
}
