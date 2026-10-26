import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { setHomeDirForTesting } from '@n24q02m/hull/storage'
import { localAuthContext, runWithAuthContext } from '@n24q02m/hull/token-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuth, resetState, resolveCredentialState } from '../auth/credential-state.js'
import { config } from './config.js'

const VALID_ACTIONS =
  'Valid actions: status, setup_start, setup_reset, setup_complete, set, cache_clear, account_add, account_list, account_remove, account_set_default'

function textOf(result: CallToolResult): string {
  const first = result.content[0]
  return 'text' in first ? first.text : ''
}

// add-account.js is mocked: the real flow binds a local HTTP port. Each call is
// recorded so tests can assert the stdio-only contract.
const addAccountCalls = vi.hoisted(() => [] as Array<{ makePrimary?: boolean }>)
vi.mock('../auth/add-account.js', () => ({
  startAddAccount: async (opts: { makePrimary?: boolean }) => {
    addAccountCalls.push(opts)
    return { url: 'http://127.0.0.1:9999/', done: Promise.resolve('x@example.com') }
  }
}))

// Bind `sub` as the hull caller namespace for `fn`; currentSubject() reads it back.
const asSub = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  runWithAuthContext({ ...localAuthContext(), uid: sub, namespace: sub, mode: 'multi' }, fn)

// The real credential-state module (not a mock): every account action here has to
// land on the actual store to prove anything, and PerPluginStore honors
// setHomeDirForTesting, so a temp home keeps that hermetic. resetState() also
// normalizes the module-level credential state between tests.
describe('config', () => {
  let testHomeDir: string

  beforeEach(async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
    testHomeDir = mkdtempSync(join(tmpdir(), 'bws-config-test-'))
    setHomeDirForTesting(testHomeDir)
    await resetState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setHomeDirForTesting(null)
    rmSync(testHomeDir, { recursive: true, force: true })
  })

  describe('status action', () => {
    it('reports awaiting_setup state with no accounts', async () => {
      const result = await config({ action: 'status' })

      expect(JSON.parse(textOf(result))).toEqual({
        state: 'awaiting_setup',
        configured: false,
        accounts: [],
        primary: null
      })
    })

    it('reports configured state with the account summary', async () => {
      await getAuth().saveTokens({ access_token: 'a' }, { email: 'one@example.com' })
      await resolveCredentialState()

      const result = await config({ action: 'status' })

      expect(JSON.parse(textOf(result))).toEqual({
        state: 'configured',
        configured: true,
        accounts: ['one@example.com'],
        primary: 'one@example.com'
      })
    })
  })

  describe('setup_start action', () => {
    it('tells the user to run workspace auth on the host', async () => {
      const result = await config({ action: 'setup_start' })

      expect(textOf(result)).toContain('workspace auth')
    })
  })

  describe('setup_reset action', () => {
    it('clears every stored account and reports the new status', async () => {
      await getAuth().saveTokens({ access_token: 'a' }, { email: 'one@example.com' })
      await resolveCredentialState()

      const result = await config({ action: 'setup_reset' })

      expect(JSON.parse(textOf(result))).toEqual({
        state: 'awaiting_setup',
        configured: false,
        accounts: [],
        primary: null
      })
      expect((await getAuth().listAccounts()).accounts).toEqual([])
    })
  })

  describe('setup_complete action', () => {
    it('re-resolves credential state and reports it', async () => {
      // Tokens landed on disk without the server noticing (the browser flow
      // finished out-of-band) -- setup_complete is the re-check.
      await getAuth().saveTokens({ access_token: 'a' }, { email: 'one@example.com' })

      const result = await config({ action: 'setup_complete' })

      expect(JSON.parse(textOf(result))).toEqual({
        state: 'configured',
        configured: true,
        accounts: ['one@example.com'],
        primary: 'one@example.com'
      })
    })
  })

  describe('set action', () => {
    it('returns a no-op info message', async () => {
      const result = await config({ action: 'set' })

      expect(textOf(result)).toContain('No mutable runtime settings')
    })
  })

  describe('cache_clear action', () => {
    it('returns a no-op info message', async () => {
      const result = await config({ action: 'cache_clear' })

      expect(textOf(result)).toContain('No client-side cache')
    })
  })

  describe('account actions', () => {
    it('account_list reports accounts and which one is primary', async () => {
      const auth = getAuth()
      await auth.saveTokens({ access_token: 'a' }, { email: 'one@example.com' })
      await auth.saveTokens({ access_token: 'b' }, { email: 'two@example.com' })

      const result = await config({ action: 'account_list' })

      expect(result.isError).toBeFalsy()
      expect(JSON.parse(textOf(result))).toEqual({
        accounts: ['one@example.com', 'two@example.com'],
        primary: 'one@example.com'
      })
    })

    it('account_remove drops the account and reports the new primary', async () => {
      const auth = getAuth()
      await auth.saveTokens({ access_token: 'a' }, { email: 'one@example.com' })
      await auth.saveTokens({ access_token: 'b' }, { email: 'two@example.com' })

      const result = await config({ action: 'account_remove', account: 'one@example.com' })

      expect(JSON.parse(textOf(result))).toEqual({ removed: true, primary: 'two@example.com' })
      expect((await auth.listAccounts()).accounts).toEqual(['two@example.com'])
    })

    // config() rejects; registry.ts is what renders a rejection as isError for the
    // MCP client (see the protocol E2E for that end of the contract).
    it('account_remove without an account argument is a validation error', async () => {
      await expect(config({ action: 'account_remove' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/account/i)
      })
    })

    it('account_set_default switches the primary', async () => {
      const auth = getAuth()
      await auth.saveTokens({ access_token: 'a' }, { email: 'one@example.com' })
      await auth.saveTokens({ access_token: 'b' }, { email: 'two@example.com' })

      const result = await config({ action: 'account_set_default', account: 'Two@Example.com' })

      expect(JSON.parse(textOf(result))).toEqual({ primary: 'two@example.com' })
      expect((await auth.listAccounts()).primary).toBe('two@example.com')
    })

    it('account_set_default on an unknown account surfaces a clean error', async () => {
      await getAuth().saveTokens({ access_token: 'a' }, { email: 'one@example.com' })

      await expect(config({ action: 'account_set_default', account: 'ghost@example.com' })).rejects.toThrow(
        /not configured/i
      )
    })

    it('account_set_default without an account argument is a validation error', async () => {
      await expect(config({ action: 'account_set_default' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR'
      })
    })

    // add-account.js is mocked: the real flow binds a local HTTP port, and the
    // point of this test is the non-blocking contract (URL back now, consent later).
    it('account_add returns a URL to open without blocking on the consent', async () => {
      addAccountCalls.length = 0
      const body = JSON.parse(textOf(await config({ action: 'account_add' }))) as { open: string }
      expect(body.open).toBe('http://127.0.0.1:9999/')

      // value="primary" is how a caller asks for the new account to become default.
      await config({ action: 'account_add', value: 'primary' })
      expect(addAccountCalls).toEqual([{ makePrimary: false }, { makePrimary: true }])
    })

    // Subject scope (HTTP): account_add must NOT start a local consent flow. It
    // returns no URL and tells the caller to run `workspace auth --user <sub>` on the host.
    it('account_add inside a subject scope returns the host command instead of a local flow', async () => {
      addAccountCalls.length = 0
      const body = (await asSub('sub-alice', async () =>
        JSON.parse(textOf(await config({ action: 'account_add', value: 'primary' })))
      )) as { open: null; next: string; default_account: string }

      expect(addAccountCalls).toEqual([])
      expect(body.open).toBeNull()
      expect(body.next).toMatch(/workspace auth --user sub-alice/)
      // value="primary" cannot be honoured over HTTP, and the caller is TOLD so
      // rather than left believing their default changed.
      expect(body.default_account).toMatch(/not available over HTTP/)
      expect(body.default_account).toMatch(/account_set_default/)
    })

    it('tells a remote caller how to change the default when they did not ask to', async () => {
      // config and subject-context MUST see the same hull module instance; the
      // static imports at the top of this file guarantee that.
      const body = (await asSub('sub-alice', async () =>
        JSON.parse(textOf(await config({ action: 'account_add' })))
      )) as { default_account: string }

      expect(body.default_account).toMatch(/does not change your default/)
      expect(body.default_account).toMatch(/account_set_default/)
      // The empty-bucket case is real (AccountStore promotes the first account
      // so a bucket is never left without a working primary) and is stated
      // rather than hidden.
      expect(body.default_account).toMatch(/no accounts at all/)
    })
  })

  describe('invalid action', () => {
    it('throws a WorkspaceMCPError listing valid actions', async () => {
      await expect(config({ action: 'bogus' as never })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Unsupported action: bogus',
        suggestion: VALID_ACTIONS
      })
    })
  })
})
