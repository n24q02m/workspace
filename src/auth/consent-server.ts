/**
 * When the temporary local server behind a Google consent shuts down.
 *
 * Both consent flows stand a throwaway HTTP server up on 127.0.0.1 to catch Google's
 * redirect: `runOAuthSetup` at first start, `startAddAccount` afterwards. Both used to
 * close it the instant the first consent resolved, and both produced the same bug, so the
 * policy lives here once instead of being re-derived per flow.
 */
import { SERVER_NAME } from '../constants.js'

/** The only part of the loopback consent server this module needs. */
interface ClosableServer {
  close: () => Promise<void>
}

/**
 * How long the temporary server outlives a SUCCESSFUL consent.
 *
 * A second consent tab is ordinary. The user clicks the URL twice, the browser prefetches
 * it, or they reload the finished page. Each tab exchanges its own code at `/callback`, so
 * closing the moment the FIRST tab succeeds drops a second tab onto a dead port. Seen in the
 * field: one tab on "Setup complete", the other ERR_CONNECTION_REFUSED at
 * 127.0.0.1:<port>/callback -- an error page for a consent that actually worked.
 *
 * Ten seconds is a round number, not a measured one. It covers the mechanical duplicates
 * above, which are all sub-second; it does not pretend to cover someone who finishes a
 * second tab a minute later. Covering that would mean not closing on success at all and
 * letting the flow's own deadline do it, which holds a port for minutes after a completed
 * consent.
 *
 * What a late tab may DO is the other half of this, and it stays in each flow's
 * `onTokens`: the first consent writes, a later one for the same account is accepted
 * and writes nothing, a later one for a different account is refused. A window where any
 * tab could write would trade this error page for a silently added account.
 */
export const CLOSE_GRACE_MS = 10_000

/**
 * Shut down now. On a failed or timed-out flow nobody is mid-consent, so there is no late
 * tab worth holding the port for.
 *
 * A close failure is nobody's outcome by the time it happens -- the consent has already
 * been saved, or already failed on its own -- and this runs on a promise no caller holds.
 * So it goes to stderr rather than into the flow's result (which would report a working
 * consent as a failed one) or into an unhandled rejection.
 */
export function closeNow(handle: ClosableServer): void {
  void handle.close().catch((err) => {
    console.error(`[${SERVER_NAME}] failed to close the consent callback server:`, err)
  })
}

/**
 * Shut down after the grace window, without making the caller wait for it: the flow's own
 * promise settles the moment the consent does. That matters most on the startup path, where
 * waiting would add the whole window to boot time.
 */
export function closeAfterGrace(handle: ClosableServer, graceMs: number = CLOSE_GRACE_MS): void {
  const timer = setTimeout(() => closeNow(handle), graceMs)
  // A pending close must not be the thing keeping the process alive.
  if (typeof timer.unref === 'function') timer.unref()
}
