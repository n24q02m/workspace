/**
 * MCP Elicitation helper (`elicitWithFallback`) with CLI/headless fallback for
 * sensitive Google Workspace operations and ambiguous multi-account selection.
 */

import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server'
import { elicitWithFallback } from '@n24q02m/hull/extensions'
import { getAuth } from '../../auth/credential-state.js'

/** Sensitive actions requiring explicit user confirmation when client supports elicitation. */
export const SENSITIVE_OPERATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  gmail: {
    send: 'Send an email via Gmail',
    sendDraft: 'Send an existing Gmail draft'
  },
  drive: {
    trashFile: 'Move a Google Drive file to trash'
  },
  calendar: {
    deleteEvent: 'Delete a Google Calendar event'
  },
  config: {
    account_remove: 'Remove a configured Google account',
    setup_reset: 'Reset all configured Google credentials'
  }
}

function errorTextResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function describeSensitiveTarget(args: Record<string, unknown>): string {
  const hints: string[] = []
  for (const key of ['account', 'to', 'subject', 'draftId', 'fileId', 'eventId', 'calendarId'] as const) {
    const val = args[key]
    if (typeof val === 'string' && val.trim() !== '') {
      hints.push(`${key}=${val.trim()}`)
    }
  }
  return hints.length > 0 ? ` (${hints.join(', ')})` : ''
}

function readCarriedAccountFromState(ctx: ServerContext): string | undefined {
  const raw = typeof ctx.mcpReq.requestState === 'function' ? ctx.mcpReq.requestState() : undefined
  if (typeof raw !== 'string' || !raw.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(raw) as { account?: unknown }
    return typeof parsed.account === 'string' && parsed.account.trim() !== '' ? parsed.account.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * When multiple accounts are configured and the caller omitted `account` on an
 * account-scoped domain tool, elicit account selection from interactive MCP
 * clients and fall back to the primary account for CLI/headless clients.
 */
export async function resolveElicitedAccount(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: ServerContext
): Promise<{ account?: string; earlyResult?: CallToolResult | InputRequiredResult }> {
  const explicitAccount =
    typeof args.account === 'string' && args.account.trim() !== '' ? args.account.trim() : undefined
  if (explicitAccount !== undefined) {
    return { account: explicitAccount }
  }

  const { accounts, primary } = await getAuth().listAccounts()
  if (accounts.length <= 1) {
    return { account: undefined }
  }

  if (!ctx) {
    return { account: primary ?? accounts[0] }
  }

  const stateAccount = readCarriedAccountFromState(ctx)
  if (stateAccount !== undefined && accounts.includes(stateAccount)) {
    return { account: stateAccount }
  }

  const action = typeof args.action === 'string' ? args.action : ''
  const actionSuffix = action ? `.${action}` : ''
  const outcome = await elicitWithFallback<{ account: string }>(ctx, {
    key: 'select_account',
    message: `Multiple Google accounts are configured (${accounts.join(', ')}). Select which account to use for ${toolName}${actionSuffix}.`,
    requestedSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          enum: accounts,
          description: 'Google account email to act as'
        }
      },
      required: ['account']
    },
    defaultValue: primary ? { account: primary } : accounts[0] ? { account: accounts[0] } : undefined
  })

  if (outcome.status === 'input_required') {
    return { earlyResult: outcome.result }
  }
  if (outcome.status === 'declined' || outcome.status === 'cancelled') {
    return { earlyResult: errorTextResult(`Account selection ${outcome.status} by user.`) }
  }

  const selected = typeof outcome.data.account === 'string' ? outcome.data.account.trim() : undefined
  if (!selected || !accounts.includes(selected)) {
    return { earlyResult: errorTextResult(`Invalid selected account: ${String(outcome.data.account ?? '')}`) }
  }
  return { account: selected }
}

/**
 * Elicit explicit user confirmation before sensitive Google Workspace
 * mutations/deletions. Falls back cleanly (`defaultValue: { confirmed: true }`)
 * when running via CLI (`ctx === undefined`) or a client without elicitation.
 */
export async function confirmSensitiveOperation(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: ServerContext,
  selectedAccount?: string
): Promise<CallToolResult | InputRequiredResult | undefined> {
  const action = typeof args.action === 'string' ? args.action : undefined
  if (!action) return undefined

  const description = SENSITIVE_OPERATIONS[toolName]?.[action]
  if (!description) return undefined

  if (!ctx) {
    return undefined
  }

  const target = describeSensitiveTarget(
    selectedAccount && args.account === undefined ? { ...args, account: selectedAccount } : args
  )
  const outcome = await elicitWithFallback<{ confirmed: boolean }>(ctx, {
    key: `confirm_${toolName}_${action}`,
    message: `Confirm sensitive operation: ${description}${target}`,
    requestedSchema: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          title: 'Confirm operation',
          description: `Set to true to proceed with ${toolName}.${action}`
        }
      },
      required: ['confirmed']
    },
    defaultValue: { confirmed: true },
    ...(selectedAccount !== undefined ? { requestState: JSON.stringify({ account: selectedAccount }) } : {})
  })

  if (outcome.status === 'input_required') {
    return outcome.result
  }
  if (outcome.status === 'declined' || outcome.status === 'cancelled') {
    return errorTextResult(`Sensitive operation ${toolName}.${action} ${outcome.status} by user.`)
  }
  if (outcome.data.confirmed !== true) {
    return errorTextResult(`Sensitive operation ${toolName}.${action} was not confirmed by user.`)
  }
  return undefined
}
