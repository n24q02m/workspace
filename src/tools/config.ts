/**
 * Config Tool
 * Manage credential state, the configuration lifecycle, and the set of Google
 * accounts the server can act as. Does NOT require a configured Google account
 * -- works independently of the domain tools.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { startAddAccount } from '../auth/add-account.js'
import { getAuth, getState, resetState, resolveCredentialState } from '../auth/credential-state.js'
import { currentSubject } from '../auth/subject-context.js'
import { WorkspaceMCPError, withErrorHandling } from './helpers/errors.js'

export interface ConfigInput {
  action:
    | 'status'
    | 'setup_start'
    | 'setup_reset'
    | 'setup_complete'
    | 'set'
    | 'cache_clear'
    | 'account_add'
    | 'account_list'
    | 'account_remove'
    | 'account_set_default'
  key?: string
  value?: string
  account?: string
}

// The MCP SDK's own CallTool result type -- reusing it (rather than a
// hand-rolled lookalike) keeps `config()` structurally exact for setRequestHandler.
export type ConfigResult = CallToolResult

const VALID_ACTIONS =
  'status, setup_start, setup_reset, setup_complete, set, cache_clear, account_add, account_list, account_remove, account_set_default'

async function statusJson(): Promise<string> {
  const state = getState()
  const { accounts, primary } = await getAuth().listAccounts()
  return JSON.stringify({ state, configured: state === 'configured', accounts, primary })
}

function textResult(text: string): ConfigResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * account_remove / account_set_default act on ONE named account. There is no
 * safe default to fall back on -- defaulting to the primary would silently
 * remove or reshuffle the wrong account.
 */
function requireAccount(input: ConfigInput): string {
  if (!input.account) {
    throw new WorkspaceMCPError(
      `${input.action} requires an account`,
      'VALIDATION_ERROR',
      'Pass account="<email>" (see config action="account_list")'
    )
  }
  return input.account
}

/**
 * Manage server configuration and credential state
 */
export function config(input: ConfigInput): Promise<ConfigResult> {
  return withErrorHandling(async () => {
    switch (input.action) {
      case 'status':
        return textResult(await statusJson())

      case 'setup_start':
        return textResult(
          'Run `workspace auth` on the host to start the Google consent flow, then retry the tool. Stdio servers start this flow automatically on first run.'
        )

      case 'setup_reset':
        await resetState()
        return textResult(await statusJson())

      case 'setup_complete':
        await resolveCredentialState()
        return textResult(await statusJson())

      case 'set':
        return textResult(
          'No mutable runtime settings in M1. To update credentials, use setup_reset then restart the server.'
        )

      case 'cache_clear':
        return textResult('No client-side cache to clear in M1.')

      case 'account_list': {
        const { accounts, primary } = await getAuth().listAccounts()
        return textResult(JSON.stringify({ accounts, primary }))
      }

      case 'account_remove': {
        const email = requireAccount(input)
        const { removed, newPrimary } = await getAuth().removeAccount(email)
        // Removing the last account puts the server back in awaiting_setup, so the
        // credential gate stops letting domain calls through.
        await resolveCredentialState()
        return textResult(JSON.stringify({ removed, primary: newPrimary }))
      }

      case 'account_set_default': {
        const email = requireAccount(input)
        await getAuth().setPrimary(email)
        return textResult(JSON.stringify({ primary: email.trim().toLowerCase() }))
      }

      case 'account_add': {
        const makePrimary = input.value === 'primary'

        // A subject scope means an authenticated HTTP caller (hull `multi` auth).
        // Google consent is not served over HTTP, so the account is added from the host
        // with the CLI `auth` command, which writes to the same per-user store.
        const sub = currentSubject()
        if (sub !== undefined) {
          return textResult(
            JSON.stringify({
              open: null,
              next: `Google consent cannot be started over HTTP. On the host where this server runs, run \`workspace auth --user ${sub}\` and open the URL it prints. Then call config(action="account_list") to confirm.`,
              default_account: makePrimary
                ? 'value="primary" is not available over HTTP and was ignored. Adding an account does not change your default; call config(action="account_set_default", account="<email>") once it appears in account_list.'
                : 'Adding an account does not change your default. Call config(action="account_set_default", account="<email>") to change it. (If you had no accounts at all, the first one becomes the default.)'
            })
          )
        }

        const flow = await startAddAccount({ makePrimary })
        // Deliberately not awaiting flow.done: the tool call has to return the URL
        // right away so the user can open it. The flow stores the account and closes
        // its temporary server on its own.
        void flow.done.catch(() => {
          /* already surfaced on the consent page; account_list shows the outcome */
        })
        return textResult(
          JSON.stringify({
            open: flow.url,
            next: 'Complete the Google consent in the browser, then call config(action="account_list") to confirm.'
          })
        )
      }

      default:
        throw new WorkspaceMCPError(
          `Unsupported action: ${(input as { action: string }).action}`,
          'VALIDATION_ERROR',
          `Valid actions: ${VALID_ACTIONS}`
        )
    }
  })()
}
