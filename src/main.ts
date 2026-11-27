/**
 * Unified entry point for Better Workspace MCP
 *
 * The console script is built with hull `buildCli`:
 *   - bare argv or flag-prefixed argv (`--http`) starts the server (`serve`).
 *   - `auth [--user <namespace>]` adds a Google account from the host (src/auth/cli-auth.ts).
 *   - `config`, `status`, `logout`, `doctor`, `token` are hull built-ins over the same store.
 *   - `<tool> <action> [--param value]... [--json]` calls any MCP tool from the terminal
 *     (src/cli/tools.ts); it runs the same dispatch the `tools/call` handler runs.
 *
 * TRANSPORT_MODE selects the transport:
 *   - "stdio" (default): Local mode. First run opens the Google consent flow on loopback,
 *     then the MCP SDK StdioServerTransport serves directly (no daemon proxy hop).
 *   - "http": Remote mode. Streamable HTTP `/mcp` via createMcpHandler + hull bearer-token auth
 *     (multi-user); each user has a credential namespace (src/transports/http.ts).
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio'
import { buildCli } from '@n24q02m/hull'
import { resolveProfile } from '@n24q02m/hull/storage'
import { authCommand } from './auth/cli-auth.js'
import { getState, resolveCredentialState } from './auth/credential-state.js'
import { runOAuthSetup } from './auth/oauth-setup.js'
import { cliHelpText, toolCommands } from './cli/tools.js'
import { SERVER_NAME, STORE_PLUGIN } from './constants.js'
import { prepareDataDir } from './data-dir.js'
import { loadWorkspaceSkillsCatalog } from './skills.js'
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
  // `WORKSPACE_DATA_DIR`, if set, must be in force before the first credential
  // read, and a store written by an earlier release moves across once.
  await prepareDataDir()
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
    await runOAuthSetup() // prints the consent URL, waits for consent, persists Google tokens
    await resolveCredentialState() // -> 'configured'
  }

  const skillsCatalog = await loadWorkspaceSkillsCatalog()
  const transport = new StdioServerTransport()
  serveStdio(
    () => {
      const server = new McpServer(
        { name: SERVER_NAME, version: getPackageVersion() },
        { capabilities: { resources: {} } }
      )
      skillsCatalog.attach(server)
      registerTools(server) // NO client factory (single-account M1)
      return server
    },
    {
      transport,
      onerror: (error) => {
        console.error(`[${SERVER_NAME}] stdio error:`, error.message)
      }
    }
  )
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
function extractProfileFlag(argv: string[]): { profile: string | undefined; rest: string[] } {
  let profile: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (arg === '--profile') {
      if (i + 1 >= argv.length) {
        throw new Error('Missing value for --profile')
      }
      profile = argv[++i]
      continue
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (!value) {
        throw new Error('Missing value for --profile')
      }
      profile = value
      continue
    }
    rest.push(arg)
  }
  return { profile, rest }
}

export async function runCli(argv: string[]): Promise<void> {
  let parsed: { profile: string | undefined; rest: string[] }
  try {
    parsed = extractProfileFlag(argv)
    if (parsed.profile !== undefined) {
      process.env.WORKSPACE_PROFILE = resolveProfile(STORE_PLUGIN, parsed.profile)
    }
  } catch (error) {
    console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }

  // Before buildCli parses argv: its built-in `config`, `status` and `doctor`
  // commands read the credential store.
  // `WORKSPACE_DATA_DIR` must be in force, and a store written by an earlier
  // release moves across once, before anything reads the credential store.
  await prepareDataDir()

  // `--help` is the one place the tool groups and the operator commands have to
  // be told apart; hull's flat list would merge them. Everything else stays
  // hull's: bare/flag argv serves, reserved built-ins stay operator commands.
  if (parsed.rest[0] === '-h' || parsed.rest[0] === '--help') {
    console.log(cliHelpText())
    process.exitCode = 0
    return
  }

  const cli = buildCli(SERVER_NAME, {
    serve: () => bootstrap(),
    extra: {
      auth: authCommand,
      // One subcommand per MCP tool; each runs the same handler the server registers.
      ...toolCommands()
    },
    version: getPackageVersion(),
    // Credentials are stored under STORE_PLUGIN, so `config`/`status` must read the same slug.
    pluginName: STORE_PLUGIN
  })
  process.exitCode = await cli(parsed.rest)
}

// Only run the CLI when this file is the entry point, and not inside the test environment.
if (isMain(import.meta.url) && process.env.NODE_ENV !== 'test') {
  runCli(process.argv.slice(2))
}
