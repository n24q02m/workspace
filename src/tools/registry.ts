/**
 * Tool Registry -- N+2 tool surface: 1 mega-tool per domain (docs; Task 7
 * appends 9 more) + 2 infra tools (config, help). TOOLS, RESOURCES, the help
 * topic allowlist, and the CallTool dispatch map are all derived from the
 * single DOMAINS list in ./domains/index.js -- see that file to add a domain.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { getState, resolveCredentialState } from '../auth/credential-state.js'
import { config } from './config.js'
import type { DomainRunInput } from './domains/factory.js'
import { DOMAINS, type DomainDef } from './domains/index.js'
import { aiReadableMessage, findClosestMatch, WorkspaceMCPError } from './helpers/errors.js'

// Tools that work without a configured Google account
// 'time' is a no-auth domain (local date/time helpers) — exempt from the credential gate.
const TOKEN_FREE_TOOLS = new Set(['config', 'help', 'time'])

// Get docs directory path - works for both bundled CLI and unbundled code
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// For bundled CLI: __dirname = /bin/, docs at /build/src/docs/
// For unbundled: __dirname = /build/src/tools/, docs at /build/src/docs/
const DOCS_DIR = __dirname.endsWith('bin')
  ? join(__dirname, '..', 'build', 'src', 'docs')
  : join(__dirname, '..', 'docs')

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Documentation resources for full tool details. One per domain, plus the
 * config and help infra tools' own docs (not domains themselves).
 */
const RESOURCES = [
  ...DOMAINS.map((d) => ({
    uri: `workspace://docs/${d.name}`,
    name: `${capitalize(d.name)} Tool Docs`,
    file: `${d.name}.md`
  })),
  { uri: 'workspace://docs/config', name: 'Config Tool Docs', file: 'config.md' },
  { uri: 'workspace://docs/overview', name: 'Overview Docs', file: 'overview.md' }
]

const PRECOMPUTED_RESOURCES = RESOURCES.map((r) => ({ uri: r.uri, name: r.name, mimeType: 'text/markdown' }))
const RESOURCE_MAP = new Map(RESOURCES.map((r) => [r.uri, r]))
const AVAILABLE_RESOURCE_URIS = RESOURCES.map((r) => r.uri).join(', ')

const HELP_TOPICS = [...DOMAINS.map((d) => d.name), 'config', 'overview']
const VALID_HELP_TOPICS = new Set<string>(HELP_TOPICS)
const VALID_HELP_TOPICS_STRING = HELP_TOPICS.join(', ')

/**
 * A domain's mega-tool definition, derived from its DomainDef -- action enum
 * comes from `actions`, extra params from `inputProps`, and `account` is
 * appended for every domain (selects which Google account the call acts as).
 */
function availableActions(domain: DomainDef, allowLocalFilesystem: boolean): readonly string[] {
  if (allowLocalFilesystem || !domain.localOnlyActions) return domain.actions
  return domain.actions.filter((action) => !domain.localOnlyActions!.includes(action))
}

function availableInputProps(domain: DomainDef, allowLocalFilesystem: boolean): Record<string, unknown> {
  if (allowLocalFilesystem || !domain.localOnlyInputProps) return domain.inputProps
  return Object.fromEntries(
    Object.entries(domain.inputProps).filter(([name]) => !domain.localOnlyInputProps!.includes(name))
  )
}

function domainToolDef(domain: DomainDef, allowLocalFilesystem: boolean) {
  const actions = availableActions(domain, allowLocalFilesystem)
  return {
    name: domain.name,
    description: domain.description,
    annotations: {
      title: capitalize(domain.name),
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...actions], description: 'Action to perform' },
        account: {
          type: 'string',
          description: 'Google account email to act as. Defaults to the primary account (config action="account_list").'
        },
        ...availableInputProps(domain, allowLocalFilesystem)
      },
      required: ['action']
    }
  }
}

/**
 * N=1 domain now (docs). Task 7 appends 9 more entries to DOMAINS, not here.
 */
const INFRA_TOOLS = [
  {
    name: 'config',
    description:
      'Manage server configuration, credential state, and the Google accounts this server can act as.\n\nActions:\n- status: current credential state plus the configured accounts and which is primary\n- setup_start: instructions to configure the Google account via browser OAuth (HTTP: run `workspace auth --user <namespace>` on the host)\n- setup_reset: clear credentials, return to awaiting_setup\n- setup_complete: re-check credentials after external config changes\n- set: update a runtime setting (M1 has no mutable settings; returns info)\n- cache_clear: clear any cached state (no-op in M1)\n- account_add: start the browser consent flow for one more account (stdio: returns a URL to open; HTTP: returns the `workspace auth --user <namespace>` command to run on the host)\n- account_list: list configured accounts and the primary one\n- account_remove (account): forget one account; a remaining account is promoted if it was primary\n- account_set_default (account): make one account the primary (used when a call omits account)',
    annotations: {
      title: 'Config',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'setup_start',
            'setup_reset',
            'setup_complete',
            'set',
            'cache_clear',
            'account_add',
            'account_list',
            'account_remove',
            'account_set_default'
          ],
          description: 'Action to perform'
        },
        key: { type: 'string', description: 'Setting key (for set action)' },
        value: { type: 'string', description: 'Setting value (for set action)' },
        account: {
          type: 'string',
          description: 'Account email (for account_remove / account_set_default / account_add)'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'help',
    description: 'Get full documentation for a topic. Use when compressed tool descriptions are insufficient.',
    annotations: {
      title: 'Help',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: [...HELP_TOPICS], description: 'Topic to get documentation for' }
      },
      required: ['topic']
    }
  }
]

function toolDefinitions(allowLocalFilesystem: boolean) {
  return [...DOMAINS.map((domain) => domainToolDef(domain, allowLocalFilesystem)), ...INFRA_TOOLS]
}

/**
 * Dispatch map for domain mega-tools, keyed by domain name. Each entry
 * returns the MCP CallTool result shape directly (no re-wrapping). Task 7
 * appends 9 more entries to DOMAINS, not here.
 */
const DOMAIN_MAP = new Map(DOMAINS.map((domain) => [domain.name, domain]))

/**
 * Register all tools with the MCP server. Single-account M1 -- no client factory.
 */
export function registerTools(
  server: Server,
  { allowLocalFilesystem = true }: { allowLocalFilesystem?: boolean } = {}
) {
  const tools = toolDefinitions(allowLocalFilesystem)
  const allToolNames = tools.map((tool) => tool.name)
  const allToolNamesString = allToolNames.join(', ')

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools
  }))

  // Resources handlers for full documentation
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: PRECOMPUTED_RESOURCES
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    const resource = RESOURCE_MAP.get(uri)

    if (!resource) {
      throw new WorkspaceMCPError(
        `Resource not found: ${uri}`,
        'RESOURCE_NOT_FOUND',
        `Available: ${AVAILABLE_RESOURCE_URIS}`
      )
    }

    const fullPath = join(DOCS_DIR, basename(resource.file))
    const rel = relative(DOCS_DIR, fullPath)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorkspaceMCPError('Path traversal attempt detected', 'SECURITY_ERROR', 'Invalid resource URI')
    }

    try {
      const content = await readFile(fullPath, 'utf-8')
      return {
        contents: [{ uri, mimeType: 'text/markdown', text: content }]
      }
    } catch {
      throw new WorkspaceMCPError(
        `Documentation not found for: ${resource.name}`,
        'DOC_NOT_FOUND',
        'Check resource URI'
      )
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (!args) {
      return {
        content: [{ type: 'text', text: 'Error: No arguments provided' }],
        isError: true
      }
    }

    // Credential guard. config and help work without a configured Google
    // account; every domain tool (docs, and the 9 more Task 7 appends)
    // requires the OAuth flow to have completed at least once.
    // The state map is per process and per bucket. A fresh process (or a new HTTP user)
    // starts empty, so re-resolve from the store before refusing. resolveCredentialState
    // fails closed: a store read error leaves the state at 'awaiting_setup'.
    if (!TOKEN_FREE_TOOLS.has(name) && getState() !== 'configured') {
      await resolveCredentialState()
    }
    if (!TOKEN_FREE_TOOLS.has(name) && getState() !== 'configured') {
      return {
        content: [
          {
            type: 'text',
            text: 'Google account not configured. Run `workspace auth` on the host to complete the Google consent, or call config(action="setup_start") for instructions.'
          }
        ],
        isError: true
      }
    }

    try {
      const domain = DOMAIN_MAP.get(name)
      if (domain) {
        const action = (args as DomainRunInput).action
        if (!allowLocalFilesystem && domain.localOnlyActions?.includes(action)) {
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
        return await domain.run(args as any)
      }

      switch (name) {
        case 'config':
          return await config(args as any)

        case 'help': {
          const topic = (args as { topic: string }).topic
          // Security: validate topic against allowlist to prevent path traversal
          if (!VALID_HELP_TOPICS.has(topic)) {
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

        default: {
          const closest = findClosestMatch(name, allToolNames)
          const suggestion = closest ? ` Did you mean '${closest}'?` : ''
          throw new WorkspaceMCPError(
            `Unknown tool: ${name}.${suggestion}`,
            'UNKNOWN_TOOL',
            `Available tools: ${allToolNamesString}`
          )
        }
      }
    } catch (error) {
      const enhancedError =
        error instanceof WorkspaceMCPError
          ? error
          : new WorkspaceMCPError((error as Error).message, 'TOOL_ERROR', 'Check the error details and try again')

      return {
        content: [{ type: 'text', text: aiReadableMessage(enhancedError) }],
        isError: true
      }
    }
  })
}
