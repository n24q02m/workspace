import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_GRACE_MS } from './consent-server.js'
import { runOAuthSetup, WORKSPACE_SCOPES } from './oauth-setup.js'

function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.`
}

const saveTokensMock = vi.fn()
vi.mock('./credential-state.js', () => ({
  getAuth: () => ({ saveTokens: saveTokensMock })
}))

const startLoopbackConsentMock = vi.fn()
vi.mock('./loopback-consent.js', () => ({
  startLoopbackConsent: (...args: unknown[]) => startLoopbackConsentMock(...args)
}))

type Tokens = Record<string, unknown>

/**
 * The loopback server is mocked, so nothing delivers a consent on its own: capture the
 * `onTokens` the flow hands over, start the flow without awaiting it, and drive the tabs
 * from the test body -- which is the only way to reach a tab arriving AFTER the flow settled.
 */
function startSetup(opts: { graceMs?: number } = {}) {
  const close = vi.fn().mockResolvedValue(undefined)
  let onTokens: ((tokens: Tokens) => Promise<void>) | undefined
  startLoopbackConsentMock.mockImplementation(async (o: { onTokens: (tokens: Tokens) => Promise<void> }) => {
    onTokens = o.onTokens
    return { url: 'http://127.0.0.1:1/', host: '127.0.0.1', port: 1, close }
  })
  const done = runOAuthSetup(opts)
  return {
    done,
    close,
    consent: (claims: Record<string, unknown>) =>
      (onTokens as (tokens: Tokens) => Promise<void>)({
        id_token: fakeIdToken(claims),
        access_token: 'at',
        refresh_token: 'rt'
      })
  }
}

describe('WORKSPACE_SCOPES', () => {
  it('requests the Forms scopes up front so M4 needs no second consent', () => {
    expect(WORKSPACE_SCOPES).toContain('https://www.googleapis.com/auth/forms.body')
    expect(WORKSPACE_SCOPES).toContain('https://www.googleapis.com/auth/forms.responses.readonly')
  })

  it('does not request forms.body.readonly, which forms.body already covers', () => {
    expect(WORKSPACE_SCOPES).not.toContain('https://www.googleapis.com/auth/forms.body.readonly')
  })
})

describe('runOAuthSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // WorkspaceAuth.saveTokens resolves with the email it stored; a later tab is compared
    // against that email, so the mock honours the real signature.
    saveTokensMock.mockResolvedValue('setup@example.com')
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('throws when Google OAuth client credentials are not set', async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
    await expect(runOAuthSetup()).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/)
    expect(startLoopbackConsentMock).not.toHaveBeenCalled()
  })

  it('starts the loopback consent with the workspace scopes and offline access', async () => {
    startSetup()
    expect(startLoopbackConsentMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'cid', clientSecret: 'sec', scopes: WORKSPACE_SCOPES })
    )
  })

  it('saves the delivered tokens on the first consent, then resolves', async () => {
    const flow = startSetup()
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    await flow.done

    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    expect(saveTokensMock).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'at', refresh_token: 'rt' }))
  })

  it('prints the authorization line with the consent URL on stderr', async () => {
    const writes: string[] = []
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    try {
      const flow = startSetup()
      await flow.consent({ email: 'a@example.com' })
      await flow.done
      expect(writes.join('')).toBe(
        '[workspace] Google authorization required. Open http://127.0.0.1:1/ in a browser to continue.\n'
      )
    } finally {
      stderrSpy.mockRestore()
    }
  })

  it('leaves the callback port open after a successful consent, then closes it once', async () => {
    const flow = startSetup()
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    await flow.done
    // Startup carries on immediately; the port is what lingers, not the boot.
    expect(flow.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS - 1)
    expect(flow.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(flow.close).toHaveBeenCalledTimes(1)
  })

  it('does not make startup wait out the grace window', async () => {
    const flow = startSetup()
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })

    // No timer advanced: if the flow only settled after the grace window, this hangs.
    await flow.done
    expect(flow.close).not.toHaveBeenCalled()
  })

  it('accepts a late tab for the SAME account without saving twice', async () => {
    saveTokensMock.mockResolvedValue('a@example.com')
    const flow = startSetup()
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    await flow.done

    await expect(flow.consent({ sub: 'google-user-123', email: 'a@example.com' })).resolves.toBeUndefined()
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a late tab for a DIFFERENT account instead of storing it', async () => {
    saveTokensMock.mockResolvedValue('a@example.com')
    const flow = startSetup()
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    await flow.done

    await expect(flow.consent({ sub: 'google-user-999', email: 'b@example.com' })).rejects.toThrow(
      'Setup already completed for a@example.com. Use config(action="account_add") to add another account.'
    )
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
  })

  it('lets only the first of two SIMULTANEOUS tabs save, before the first save finishes', async () => {
    // A gated save plus two consents with no await between them: the second tab is
    // guaranteed to arrive while the first save is still in flight.
    const gate = Promise.withResolvers<string>()
    saveTokensMock.mockImplementationOnce(() => gate.promise)
    const flow = startSetup()

    const first = flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    const second = flow.consent({ sub: 'google-user-999', email: 'b@example.com' })
    const secondRefused = expect(second).rejects.toThrow(/a@example\.com/)

    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    gate.resolve('a@example.com')

    await expect(first).resolves.toBeUndefined()
    await secondRefused
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
    await flow.done
  })

  it('rejects a late tab that carries no email claim, since it cannot be shown to be the same account', async () => {
    saveTokensMock.mockResolvedValue('a@example.com')
    const flow = startSetup()
    await flow.consent({ sub: 'google-user-123', email: 'a@example.com' })
    await flow.done

    await expect(flow.consent({ sub: 'google-user-123' })).rejects.toThrow(/Setup already completed/)
    expect(saveTokensMock).toHaveBeenCalledTimes(1)
  })

  // A saveTokens disk error must reject the flow and close the server, not hang it.
  it('rejects (does not hang) and closes the server when saveTokens throws', async () => {
    const saveError = new Error('EACCES: disk write failed')
    saveTokensMock.mockRejectedValueOnce(saveError)
    const flow = startSetup()
    const setupRejected = expect(flow.done).rejects.toThrow(saveError)
    await expect(flow.consent({ sub: 'google-user-123', email: 'a@example.com' })).rejects.toThrow(saveError)
    await setupRejected
    expect(flow.close).toHaveBeenCalledOnce()
  })
})
