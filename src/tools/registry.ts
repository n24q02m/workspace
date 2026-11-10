/**
 * Tool Registry -- N+2 tool surface: 1 mega-tool per domain (docs; Task 7
 * appends 9 more) + 2 infra tools (config, help). TOOLS, RESOURCES, the help
 * topic allowlist, and the CallTool dispatch map are all derived from the
 * single DOMAINS list in ./domains/index.js -- see that file to add a domain.
 *
 * The `tools/call` body itself lives in ./dispatch.ts: the CLI tool
 * subcommands (cli/tools.ts) call the same `dispatchTool`, so a tool's
 * behaviour cannot differ between MCP and `workspace <tool> <action>`.
 */

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { DOCS_DIR, dispatchTool, HELP_TOPICS } from './dispatch.js'
import type { DomainDef } from './domains/index.js'
import { DOMAINS } from './domains/index.js'
import { WorkspaceMCPError } from './helpers/errors.js'

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
 * Register all tools with the MCP server. Single-account M1 -- no client factory.
 */
export function registerTools(
  server: Server,
  { allowLocalFilesystem = true }: { allowLocalFilesystem?: boolean } = {}
) {
  const tools = toolDefinitions(allowLocalFilesystem)

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
    return dispatchTool(name, args, { allowLocalFilesystem })
  })
}
