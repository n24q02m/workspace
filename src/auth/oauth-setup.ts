import { SERVER_NAME } from '../constants.js'
import { emailFromIdToken } from './account-store.js'
import { closeAfterGrace, closeNow } from './consent-server.js'
import { getAuth } from './credential-state.js'
import { type ConsentTokens, startLoopbackConsent } from './loopback-consent.js'
import type { GoogleTokens } from './workspace-auth.js'

// M1 aimed to request the full Workspace scope set upfront so domains added
// later need no re-consent. The Forms set (M4) was missed then and is added
// here in M2, so the next real consent -- adding a second account -- covers it
// too, instead of making the user click through another round at M4. Keep in
// sync with the APIs the vendored services actually call.
//
// Note for M4: Google does not widen an already-issued token, so an account
// authorized BEFORE this change keeps the old scope set and will need a
// re-consent once Forms is called. Accounts added after it will not.
export const WORKSPACE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly'
]

/**
 * First-run consent for the stdio server, run when no credentials are stored. Blocks until
 * the first consent is stored, then leaves the loopback port open for the grace window so a
 * duplicate tab still lands on a live server.
 */
export async function runOAuthSetup(opts: { graceMs?: number } = {}): Promise<void> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET required for OAuth setup.')
  }
  const finished = Promise.withResolvers<void>()

  /**
   * The one consent allowed to write, held as the in-flight promise rather than a flag set
   * after its `await`: two tabs arriving at once would both find a flag still unset, and two
   * concurrent `saveTokens` calls race the credential store's write-then-rename into an ENOENT.
   */
  let firstConsent: Promise<string> | null = null

  const handle = await startLoopbackConsent({
    clientId,
    clientSecret,
    scopes: WORKSPACE_SCOPES,
    onTokens: async (tokens: ConsentTokens) => {
      if (firstConsent === null) {
        firstConsent = getAuth()
          .saveTokens(tokens as unknown as GoogleTokens)
          .then(
            (email) => {
              finished.resolve()
              return email
            },
            (err) => {
              finished.reject(err)
              throw err
            }
          )
        await firstConsent
        return
      }

      // A later tab. Rejecting here if the first one failed is right: setup is over either way,
      // and a late tab must not revive a flow whose server is closing.
      const setUpAs = await firstConsent
      if (emailFromIdToken((tokens as unknown as GoogleTokens).id_token) === setUpAs) {
        // Same account twice -- nothing left to store, so this tab just gets its page.
        return
      }
      // Also the no-email-claim case, where this tab cannot be shown to be the same account.
      // Refusing costs one more consent; storing it connects a mailbox the user never chose.
      throw new Error(
        `Setup already completed for ${setUpAs}. Use config(action="account_add") to add another account.`
      )
    }
  })

  process.stderr.write(`[${SERVER_NAME}] Google authorization required. Open ${handle.url} in a browser to continue.\n`)
  try {
    await finished.promise
  } catch (err) {
    // Nobody is mid-consent on a failure, so there is no late tab worth the port.
    closeNow(handle)
    throw err
  }
  // Hand startup back NOW and let the port linger: boot must not wait out the grace window
  // (see consent-server.ts), while a late consent tab still needs somewhere to land.
  closeAfterGrace(handle, opts.graceMs)
}
