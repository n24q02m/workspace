/**
 * Add one more Google account from the host, by the CLI `auth` command or the stdio
 * `config(action="account_add")` tool.
 *
 * A loopback consent server on 127.0.0.1 catches Google's redirect. This returns the URL
 * IMMEDIATELY so a tool call can hand it to the user; the waiting lives in the `done` promise.
 *
 * Remote (HTTP) callers do not reach this module. They are told to run `auth` on the host,
 * because Google's Web OAuth client cannot redirect to a runtime-chosen loopback port.
 *
 * `makePrimary` is only honoured here because nothing in this flow crosses a URL a third
 * party could present to promote an account.
 */
import { emailFromIdToken } from './account-store.js'
import { closeAfterGrace, closeNow } from './consent-server.js'
import { getAuth } from './credential-state.js'
import { type ConsentTokens, startLoopbackConsent } from './loopback-consent.js'
import { WORKSPACE_SCOPES } from './oauth-setup.js'
import type { GoogleTokens } from './workspace-auth.js'

export interface AddAccountFlow {
  /** URL the user opens to start the consent screen. */
  url: string
  /** Resolves with the email that was added; rejects if the flow failed or timed out. */
  done: Promise<string>
}

/**
 * Walking away mid-consent is ordinary, and this function returns immediately so the waiting
 * is invisible. Without a deadline the temporary server would stay up holding its port forever,
 * one leak per abandoned call. After this long the flow closes itself.
 */
const FLOW_TTL_MS = 10 * 60 * 1000

export async function startAddAccount(
  opts: { makePrimary?: boolean; ttlMs?: number; graceMs?: number } = {}
): Promise<AddAccountFlow> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET required to add an account.')
  }

  const settled = Promise.withResolvers<string>()

  /**
   * The one consent allowed to write, held as the in-flight promise rather than a flag set after
   * its `await`. Two tabs redirecting at once would both find a flag still unset, and two
   * concurrent `saveTokens` calls race the credential store's write-then-rename into an ENOENT.
   */
  let firstConsent: Promise<string> | null = null

  const handle = await startLoopbackConsent({
    clientId,
    clientSecret,
    scopes: WORKSPACE_SCOPES,
    onTokens: async (tokens: ConsentTokens) => {
      // One flow adds ONE account. Every consent tab that comes back lands here (see
      // CLOSE_GRACE_MS), so the first one writes and the rest are checked against it --
      // otherwise a second tab where the user picked a different identity in Google's account
      // chooser would be stored silently, and with makePrimary it would take primary away from
      // the account this flow already reported adding.
      if (firstConsent === null) {
        firstConsent = getAuth()
          .saveTokens(tokens as unknown as GoogleTokens, { makePrimary: opts.makePrimary })
          .then(
            (email) => {
              settled.resolve(email)
              return email
            },
            (err) => {
              settled.reject(err)
              throw err
            }
          )
        await firstConsent
        return
      }

      // Whatever the first tab settled on -- rejecting here if it failed, which is right: the flow
      // is over either way, and a late tab must not revive it.
      const added = await firstConsent
      if (emailFromIdToken((tokens as unknown as GoogleTokens).id_token) === added) {
        // Same account twice: nothing left to write, and re-running makePrimary would be a second
        // write for a primary that is already set to this very account.
        return
      }
      // Also the no-email-claim case, where the account cannot be shown to be the same one --
      // refusing costs the user one more account_add call, storing the wrong account costs them
      // a mailbox they never meant to connect.
      throw new Error(
        `This add-account flow already completed for ${added}. Call config(action="account_add") again to add a different account.`
      )
    }
  })

  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(
    () => timeout.reject(new Error('Add-account flow timed out before the Google consent completed.')),
    opts.ttlMs ?? FLOW_TTL_MS
  )
  // Don't let the deadline alone keep the event loop alive -- on a stdio server that turns
  // exiting into a ten-minute hang.
  if (typeof timer.unref === 'function') timer.unref()

  // race, NOT any: whichever settles first wins, so a real onTokens failure surfaces now.
  // Promise.any ignores rejections, which would hide that error behind a "timed out" later.
  const done = Promise.race([settled.promise, timeout.promise])

  // Shut down on our own schedule instead of through .finally() on `done`: the caller's promise
  // settles the moment consent lands, while the port outlives it by the grace window.
  done.then(
    () => {
      clearTimeout(timer)
      closeAfterGrace(handle, opts.graceMs)
    },
    () => {
      clearTimeout(timer)
      closeNow(handle)
    }
  )
  return { url: handle.url, done }
}
