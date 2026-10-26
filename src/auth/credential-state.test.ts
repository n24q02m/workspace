import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { localAuthContext, runWithAuthContext } from '@n24q02m/hull/token-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_PLUGIN } from '../constants.js'
import { getAuth, getState, resetState, resolveCredentialState } from './credential-state.js'

// Bind `sub` as the hull caller namespace for the duration of `fn`; currentSubject()
// reads it back as the storage subject.
const asSub = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  runWithAuthContext({ ...localAuthContext(), uid: sub, namespace: sub, mode: 'multi' }, fn)

describe('credential-state', () => {
  let testHomeDir: string

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
    testHomeDir = mkdtempSync(join(tmpdir(), 'workspace-test-'))
    setHomeDirForTesting(testHomeDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setHomeDirForTesting(null)
    rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('starts as awaiting_setup, resolves to configured after saveTokens, back to awaiting_setup after resetState', async () => {
    expect(getState()).toBe('awaiting_setup')

    await getAuth().saveTokens(
      { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600_000 },
      { email: 'one@example.com' }
    )
    expect(await resolveCredentialState()).toBe('configured')
    expect(getState()).toBe('configured')

    await resetState()
    expect(getState()).toBe('awaiting_setup')
  })

  it('falls back to awaiting_setup when getAuthenticatedClient() throws (no token stored)', async () => {
    // No saveTokens call -- getAuthenticatedClient() throws 'not configured',
    // exercising resolveCredentialState()'s catch branch.
    expect(await resolveCredentialState()).toBe('awaiting_setup')
    expect(getState()).toBe('awaiting_setup')
  })

  it('reports configured when at least one account exists', async () => {
    const auth = getAuth()
    await auth.saveTokens({ access_token: 'at' }, { email: 'a@example.com' })
    expect(await resolveCredentialState()).toBe('configured')
    await auth.clear()
    expect(await resolveCredentialState()).toBe('awaiting_setup')
  })

  it('answers from the account list alone, without building a client', async () => {
    // Building a client is what can reach the network (the legacy-adoption
    // probe). With accounts on disk there is nothing to probe, so the state
    // must be decided from the list -- otherwise `config(action="status")`
    // pays a Google round-trip on every call.
    const auth = getAuth()
    await auth.saveTokens({ access_token: 'at' }, { email: 'a@example.com' })
    const spy = vi.spyOn(auth, 'getAuthenticatedClient')

    expect(await resolveCredentialState()).toBe('configured')

    expect(spy).not.toHaveBeenCalled()
    await auth.clear()
  })

  it('still reports configured for an unadopted legacy blob', async () => {
    // Flat M1 blob with no derivable email: listAccounts() is empty, so the
    // state falls back to asking getAuthenticatedClient(), which adopts it.
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at' })
    const auth = getAuth()
    vi.spyOn(
      auth as unknown as { fetchAccountEmail: (client: unknown) => Promise<string | undefined> },
      'fetchAccountEmail'
    ).mockResolvedValue('adopted@example.com')

    expect(await resolveCredentialState()).toBe('configured')
    expect((await auth.listAccounts()).accounts).toEqual(['adopted@example.com'])
    await auth.clear()
  })

  describe('per-subject buckets', () => {
    // Subject branch needs CREDENTIAL_SECRET (per-user key derivation).
    // Each test uses its OWN sub name: the two module-level cache Maps live
    // across the whole file (only the home dir is fresh per test), so distinct
    // names keep every test independent of run order.
    const originalSecret = process.env.CREDENTIAL_SECRET

    beforeEach(() => {
      process.env.CREDENTIAL_SECRET = 'test-credential-secret-at-least-32-chars'
    })
    afterEach(() => {
      if (originalSecret === undefined) delete process.env.CREDENTIAL_SECRET
      else process.env.CREDENTIAL_SECRET = originalSecret
    })

    it('hands out one WorkspaceAuth per subject and reuses it', async () => {
      // getAuth() is on the hot path of EVERY tool call, so it must cache;
      // but the cache must be keyed by sub, or two users share one AccountStore.
      const first = await asSub('cache-a', async () => getAuth())
      const again = await asSub('cache-a', async () => getAuth())
      const other = await asSub('cache-b', async () => getAuth())

      expect(again).toBe(first)
      expect(other).not.toBe(first)
      expect(getAuth()).not.toBe(first) // the stdio bucket is its own instance too
    })

    it('keeps each subject accounts out of the other subject list', async () => {
      await asSub('iso-a', async () => {
        await getAuth().saveTokens({ access_token: 'a-at' }, { email: 'alice@example.com' })
      })
      await asSub('iso-b', async () => {
        await getAuth().saveTokens({ access_token: 'b-at' }, { email: 'bob@example.com' })
      })

      const seenByA = await asSub('iso-a', async () => (await getAuth().listAccounts()).accounts)
      const seenByB = await asSub('iso-b', async () => (await getAuth().listAccounts()).accounts)

      expect(seenByA).toEqual(['alice@example.com'])
      expect(seenByB).toEqual(['bob@example.com'])
      // Outside every subject scope = the stdio bucket, which sees neither user.
      expect((await getAuth().listAccounts()).accounts).toEqual([])
    })

    it('resets only the calling subject bucket', async () => {
      // resetState() must go through getAuth(): with a singleton instance,
      // setup_reset from one remote user would NOT clear their own credentials
      // and WOULD wipe someone else's bucket.
      await asSub('reset-a', async () => {
        await getAuth().saveTokens({ access_token: 'a-at' }, { email: 'alice@example.com' })
      })
      await asSub('reset-b', async () => {
        await getAuth().saveTokens({ access_token: 'b-at' }, { email: 'bob@example.com' })
      })

      await asSub('reset-a', async () => {
        await resetState()
      })

      expect(await asSub('reset-a', async () => (await getAuth().listAccounts()).accounts)).toEqual([])
      expect(await asSub('reset-b', async () => (await getAuth().listAccounts()).accounts)).toEqual(['bob@example.com'])
    })

    it('tracks configured/awaiting_setup per subject', async () => {
      // getState() gates every domain tool (registry.ts:224). A single shared
      // state variable would let one user's setup_reset lock out another user's tools.
      await asSub('state-a', async () => {
        await getAuth().saveTokens({ access_token: 'a-at' }, { email: 'alice@example.com' })
        expect(await resolveCredentialState()).toBe('configured')
      })
      await asSub('state-b', async () => {
        await getAuth().saveTokens({ access_token: 'b-at' }, { email: 'bob@example.com' })
        expect(await resolveCredentialState()).toBe('configured')
      })

      await asSub('state-a', async () => {
        await resetState()
      })

      expect(await asSub('state-a', async () => getState())).toBe('awaiting_setup')
      expect(await asSub('state-b', async () => getState())).toBe('configured')
    })
  })
})
