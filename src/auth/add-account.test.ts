import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emailFromIdToken } from './account-store.js'
import { startAddAccount } from './add-account.js'
import { CLOSE_GRACE_MS } from './consent-server.js'

const saveTokensMock = vi.fn()
vi.mock('./credential-state.js', () => ({
  getAuth: () => ({ saveTokens: saveTokensMock })
}))

const closeSpy = vi.fn(async () => {})
let capturedOnTokens: ((tokens: Record<string, unknown>) => Promise<void>) | undefined
const startLoopbackConsentMock = vi.fn()
vi.mock('./loopback-consent.js', () => ({
  startLoopbackConsent: (...args: unknown[]) => startLoopbackConsentMock(...args)
}))

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
const idToken = (email: string) => `${b64({ alg: 'none' })}.${b64({ email, sub: 'goog-sub' })}.sig`

/** Lets the mocked consent server hand back its `onTokens`, as the real one does per tab. */
const tab = (email: string, accessToken = 'at') =>
  (capturedOnTokens as (tokens: Record<string, unknown>) => Promise<void>)({
    access_token: accessToken,
    refresh_token: 'rt',
    id_token: idToken(email)
  })

describe('startAddAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
    // Mirrors the real saveTokens contract: resolves with the stored email, rejects without one.
    saveTokensMock.mockImplementation(async (tokens: { id_token: string }) => {
      const email = emailFromIdToken(tokens.id_token)
      if (!email) throw new Error('Google account has no email claim.')
      return email
    })
    capturedOnTokens = undefined
    startLoopbackConsentMock.mockImplementation(async (opts: { onTokens: typeof capturedOnTokens }) => {
      capturedOnTokens = opts.onTokens
      return { url: 'http://127.0.0.1:41234/', host: '127.0.0.1', port: 41234, close: closeSpy }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a local URL to open and resolves with the added account email', async () => {
    const flow = await startAddAccount()
    expect(flow.url).toBe('http://127.0.0.1:41234/')

    await tab('new@example.com')
    expect(await flow.done).toBe('new@example.com')
    expect(saveTokensMock).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'at' }), {
      makePrimary: undefined
    })
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
  })

  it('leaves the callback server listening after success so a late consent tab still lands', async () => {
    const flow = await startAddAccount()
    await tab('late-tab@example.com')

    // The caller learns the outcome at once -- it does not wait out the grace window.
    expect(await flow.done).toBe('late-tab@example.com')
    expect(closeSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('accepts a late tab that consented as the SAME account, without saving twice', async () => {
    const flow = await startAddAccount()
    await tab('same@example.com', 'at-1')
    expect(await flow.done).toBe('same@example.com')

    await expect(tab('same@example.com', 'at-2')).resolves.toBeUndefined()
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
  })

  it('refuses a late tab that consented as a DIFFERENT account instead of silently adding it', async () => {
    const flow = await startAddAccount()
    await tab('a@example.com', 'at-a')
    expect(await flow.done).toBe('a@example.com')

    // The user picked another identity in Google's account chooser on the second tab.
    await expect(tab('b@example.com', 'at-b')).rejects.toThrow(
      'This add-account flow already completed for a@example.com. Call config(action="account_add") again to add a different account.'
    )
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
  })

  it('does not let a late tab steal primary', async () => {
    const flow = await startAddAccount({ makePrimary: true })
    await tab('a@example.com', 'at-a')
    await flow.done

    await expect(tab('b@example.com', 'at-b')).rejects.toThrow()
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    expect(saveTokensMock).toHaveBeenCalledWith(expect.anything(), { makePrimary: true })
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
  })

  it('lets only the first of two SIMULTANEOUS tabs save, before the first save finishes', async () => {
    // A gated save with both consents started before it resolves: a flag set after the await
    // would still read as unset for the second tab.
    const gate = Promise.withResolvers<string>()
    saveTokensMock.mockImplementationOnce(() => gate.promise)
    const flow = await startAddAccount()

    const first = tab('a@example.com', 'at-a')
    const second = tab('b@example.com', 'at-b')
    const secondRefused = expect(second).rejects.toThrow(/a@example\.com/)

    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    gate.resolve('a@example.com')

    await expect(first).resolves.toBeUndefined()
    await secondRefused
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    expect(await flow.done).toBe('a@example.com')
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
  })

  it('closes the server once, no matter how many places await the flow', async () => {
    const flow = await startAddAccount()
    await tab('shared@example.com')

    await Promise.all([flow.done, flow.done, flow.done.then((e) => e.toUpperCase())])
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS * 3)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('reports a failed shutdown on stderr rather than failing the flow', async () => {
    closeSpy.mockRejectedValueOnce(new Error('port stuck'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const flow = await startAddAccount()
      await tab('noisy@example.com')

      // The consent succeeded; a cleanup failure must not be reported as the flow's outcome.
      expect(await flow.done).toBe('noisy@example.com')
      await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to close'), expect.any(Error))
    } finally {
      errSpy.mockRestore()
    }
  })

  it('starts the loopback consent with the configured OAuth client credentials', async () => {
    await startAddAccount()
    expect(startLoopbackConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'cid', clientSecret: 'sec' })
    )
  })

  it('rejects when the account has no email claim, and closes the server without grace', async () => {
    const flow = await startAddAccount()
    const rejected = expect(flow.done).rejects.toThrow(/email/i)
    await expect(tab('')).rejects.toThrow()
    await rejected
    // No grace on a failure: nothing was saved, so a second tab has nothing to land on.
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('times out and closes the temporary server when the user never finishes the consent', async () => {
    const flow = await startAddAccount({ ttlMs: 20 })
    const timedOut = expect(flow.done).rejects.toThrow(
      'Add-account flow timed out before the Google consent completed.'
    )

    await vi.advanceTimersByTimeAsync(20)
    await timedOut
    // Nobody is mid-consent when the deadline hits -- close now, do not hold the port.
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('fails fast when the OAuth client env vars are missing', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    await expect(startAddAccount()).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/)
    expect(startLoopbackConsentMock).not.toHaveBeenCalled()
  })
})
