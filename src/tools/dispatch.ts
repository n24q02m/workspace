/**
 * Tool dispatch core, shared by the MCP `tools/call` handler (registry.ts) and
 * the CLI tool subcommands (cli/tools.ts).
 *
 * The dispatch used to live inline in registry.ts, which meant a CLI could only
 * reach it through an MCP server object. Extracting it here is what lets
 * `workspace <tool> <action>` run the EXACT handler the server registers --
 * credential gate, domain validation, error wrapping and all -- instead of a
 * second implementation that would drift.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getState, resolveCredentialState } from '../auth/credential-state.js'
import { type ConfigInput, config } from './config.js'
import type { DomainRunInput } from './domains/factory.js'
import { DOMAINS } from './domains/index.js'
import { aiReadableMessage, findClosestMatch, WorkspaceMCPError } from './helpers/errors.js'

// Tools that work without a configured Google account.
// 'time' is a no-auth domain (local date/time helpers) — exempt from the credential gate.
const TOKEN_FREE_TOOLS: Record<string, true> = { config: true, help: true, time: true }

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// For bundled CLI: __dirname = /bin/, docs at /build/src/docs/
// For unbundled: __dirname = /build/src/tools/, docs at /build/src/docs/
export const DOCS_DIR = __dirname.endsWith('bin')
  ? join(__dirname, '..', 'build', 'src', 'docs')
  : join(__dirname, '..', 'docs')

export const HELP_TOPICS = [...DOMAINS.map((d) => d.name), 'config', 'overview']
const VALID_HELP_TOPICS: Record<string, true> = Object.fromEntries(HELP_TOPICS.map((topic) => [topic, true]))
export const VALID_HELP_TOPICS_STRING = HELP_TOPICS.join(', ')

const DOMAIN_MAP = new Map(DOMAINS.map((domain) => [domain.name, domain]))

/** Every tool name this server registers: the domains plus config and help. */
export const TOOL_NAMES: string[] = [...DOMAINS.map((d) => d.name), 'config', 'help']

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

async function helpTopic(topic: string): Promise<CallToolResult> {
  // Security: validate topic against allowlist to prevent path traversal
  if (VALID_HELP_TOPICS[topic] !== true) {
    throw new WorkspaceMCPError(
      `Invalid topic: ${topic}`,
      'VALIDATION_ERROR',
      `Valid topics: ${VALID_HELP_TOPICS_STRING}`
    )
  }
  // Security: basename() ensures we only look for files directly inside
  // DOCS_DIR, even if the allowlist check above were bypassed.
  const docFile = `${basename(topic)}.md`
  const fullPath = join(DOCS_DIR, docFile)
  const rel = relative(DOCS_DIR, fullPath)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceMCPError('Path traversal attempt detected', 'SECURITY_ERROR', 'Invalid topic')
  }

  try {
    const content = await readFile(fullPath, 'utf-8')
    return { content: [{ type: 'text', text: content }] }
  } catch {
    throw new WorkspaceMCPError(`Documentation not found for: ${topic}`, 'DOC_NOT_FOUND', 'Check topic')
  }
}

/**
 * Run one tool call and return the MCP CallTool result shape. Never throws:
 * every failure comes back as `isError: true` with an AI-readable message, so
 * both callers (stdio/http server and the CLI) report it the same way.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined,
  { allowLocalFilesystem = true }: { allowLocalFilesystem?: boolean } = {}
): Promise<CallToolResult> {
  if (!args) {
    return errorResult('Error: No arguments provided')
  }

  // Credential guard. config and help work without a configured Google
  // account; every domain tool requires the OAuth flow to have completed at
  // least once. The state map is per process and per bucket. A fresh process
  // (or a new HTTP user) starts empty, so re-resolve from the store before
  // refusing. resolveCredentialState fails closed: a store read error leaves
  // the state at 'awaiting_setup'.
  if (TOKEN_FREE_TOOLS[name] !== true && getState() !== 'configured') {
    await resolveCredentialState()
  }
  if (TOKEN_FREE_TOOLS[name] !== true && getState() !== 'configured') {
    return errorResult(
      'Google account not configured. Run `workspace auth` on the host to complete the Google consent, or call config(action="setup_start") for instructions.'
    )
  }

  try {
    const domain = DOMAIN_MAP.get(name)
    if (domain) {
      const action = args.action
      if (!allowLocalFilesystem && typeof action === 'string' && domain.localOnlyActions?.includes(action) === true) {
        if (name === 'drive' && action === 'downloadFile') {
          throw new WorkspaceMCPError(
            'downloadFile is only available in local stdio mode.',
            'VALIDATION_ERROR',
            'Use a local stdio server to download a Drive file to the local filesystem.'
          )
        }
        throw new WorkspaceMCPError(
          `Action not available in this transport: ${action}`,
          'VALIDATION_ERROR',
          'Use an action listed in the tool schema.'
        )
      }
      // `args` arrives as `unknown` values from JSON-RPC / argv; the domain's
      // factory validates `action` against its own list before dispatching.
      return await domain.run(args as DomainRunInput)
    }

    switch (name) {
      case 'config':
        // `config()` validates each action itself; the cast only restores the
        // call shape the JSON-RPC/argv payload lost.
        return await config(args as unknown as ConfigInput)

      case 'help': {
        const topic = args.topic
        if (typeof topic !== 'string') {
          throw new WorkspaceMCPError(
            'help requires a topic',
            'VALIDATION_ERROR',
            `Valid topics: ${VALID_HELP_TOPICS_STRING}`
          )
        }
        return await helpTopic(topic)
      }

      default: {
        const closest = findClosestMatch(name, TOOL_NAMES)
        const suggestion = closest ? ` Did you mean '${closest}'?` : ''
        throw new WorkspaceMCPError(
          `Unknown tool: ${name}.${suggestion}`,
          'UNKNOWN_TOOL',
          `Available tools: ${TOOL_NAMES.join(', ')}`
        )
      }
    }
  } catch (error) {
    const enhancedError =
      error instanceof WorkspaceMCPError
        ? error
        : new WorkspaceMCPError((error as Error).message, 'TOOL_ERROR', 'Check the error details and try again')

    return errorResult(aiReadableMessage(enhancedError))
  }
}
