import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { google } from 'googleapis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORE_PLUGIN } from '../constants.js'
import { UNIDENTIFIED_ACCOUNT } from './account-store.js'
import { WorkspaceAuth } from './workspace-auth.js'

// id_token chỉ được đọc phần payload, không xác thực chữ ký -- JWT giả là đủ.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
const fakeIdToken = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`

// fetchAccountEmail là protected (test thay được mà không phải mở ra public API).
type EmailProbe = { fetchAccountEmail: (client: unknown) => Promise<string | undefined> }
const probeOf = (auth: WorkspaceAuth) => auth as unknown as EmailProbe

describe('WorkspaceAuth', () => {
  let testHomeDir: string

  beforeEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'sec'
    // Isolate PerPluginStore's LocalFsBackend from the real ~/.better-workspace-mcp/config.json.
    testHomeDir = mkdtempSync(join(tmpdir(), 'workspace-test-'))
    setHomeDirForTesting(testHomeDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setHomeDirForTesting(null)
    rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('builds an OAuth2Client with stored credentials', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens(
      { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600_000 },
      { email: 'stored@example.com' }
    )
    const client = await auth.getAuthenticatedClient()
    expect(client.credentials.access_token).toBe('at')
    expect(client.credentials.refresh_token).toBe('rt')
    await auth.clear()
  })

  it('throws a clear error when no token is stored', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.clear()
    await expect(auth.getAuthenticatedClient()).rejects.toThrow(/not configured/i)
  })

  it('computes expiry_date from expires_in when absent', async () => {
    const auth = new WorkspaceAuth(['openid'])
    const before = Date.now()
    // Google's raw token response: expires_in (relative seconds), no expiry_date.
    await auth.saveTokens(
      { access_token: 'a', refresh_token: 'r', expires_in: 3600 } as unknown as Parameters<
        WorkspaceAuth['saveTokens']
      >[0],
      { email: 'expiry@example.com' }
    )
    const client = await auth.getAuthenticatedClient()
    expect(client.credentials.expiry_date).toBeGreaterThanOrEqual(before + 3600_000)
    expect(client.credentials.expiry_date).toBeLessThanOrEqual(Date.now() + 3600_000)
    await auth.clear()
  })

  it('uses a store plugin name without the -mcp suffix (avoids double -mcp on disk)', () => {
    expect(STORE_PLUGIN).toBe('better-workspace')
    expect(STORE_PLUGIN.endsWith('-mcp')).toBe(false)
  })

  it('persists an auto-refreshed access_token on the client "tokens" event, keeping the stored refresh_token', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens(
      { access_token: 'at', refresh_token: 'rt', expiry_date: Date.now() + 3600_000 },
      { email: 'refresh@example.com' }
    )
    const client = await auth.getAuthenticatedClient()
    const saveTokensSpy = vi.spyOn(auth, 'saveTokens')

    // google-auth-library emits 'tokens' with a fresh access_token but no
    // refresh_token on a refresh grant -- simulate that here. EventEmitter
    // invokes the listener (and thus the `void this.saveTokens(...)` call)
    // synchronously, so the spy is already populated once emit() returns;
    // await its captured promise instead of guessing a delay (the listener
    // itself is deliberately fire-and-forget in production code).
    client.emit('tokens', { access_token: 'new-at', expiry_date: Date.now() + 7200_000 })
    expect(saveTokensSpy).toHaveBeenCalledTimes(1)
    await saveTokensSpy.mock.results[0]?.value

    const refreshed = await auth.getAuthenticatedClient()
    expect(refreshed.credentials.access_token).toBe('new-at')
    expect(refreshed.credentials.refresh_token).toBe('rt') // preserved from the original save
    await auth.clear()
  })

  it('serves different credentials for two accounts', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens({ access_token: 'at-one', refresh_token: 'rt-one' }, { email: 'one@example.com' })
    await auth.saveTokens({ access_token: 'at-two', refresh_token: 'rt-two' }, { email: 'two@example.com' })

    const one = await auth.getAuthenticatedClient('one@example.com')
    const two = await auth.getAuthenticatedClient('two@example.com')

    expect(one.credentials.access_token).toBe('at-one')
    expect(two.credentials.access_token).toBe('at-two')
    expect(one).not.toBe(two)
    await auth.clear()
  })

  it('falls back to the primary account when no account is given', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens({ access_token: 'at-one' }, { email: 'one@example.com' })
    await auth.saveTokens({ access_token: 'at-two' }, { email: 'two@example.com' })
    const client = await auth.getAuthenticatedClient()
    expect(client.credentials.access_token).toBe('at-one')
    await auth.clear()
  })

  it('names the unknown account in the error instead of silently using the primary', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens({ access_token: 'at-one' }, { email: 'one@example.com' })
    await expect(auth.getAuthenticatedClient('ghost@example.com')).rejects.toThrow(/ghost@example\.com/)
    // the message also lists what IS configured, so the caller can self-correct
    await expect(auth.getAuthenticatedClient('ghost@example.com')).rejects.toThrow(/one@example\.com/)
    await auth.clear()
  })

  it('derives the account email from the id_token when none is passed', async () => {
    const auth = new WorkspaceAuth(['openid'])
    const email = await auth.saveTokens({
      access_token: 'at',
      id_token: fakeIdToken({ email: 'derived@example.com' })
    })
    expect(email).toBe('derived@example.com')
    expect((await auth.listAccounts()).accounts).toEqual(['derived@example.com'])
    await auth.clear()
  })

  it('refuses to store tokens it cannot name an account for', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await expect(auth.saveTokens({ access_token: 'at' })).rejects.toThrow(/without an account email/i)
  })

  it('honours makePrimary when saving a second account', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens({ access_token: 'a' }, { email: 'one@example.com' })
    await auth.saveTokens({ access_token: 'b' }, { email: 'two@example.com' })
    expect((await auth.listAccounts()).primary).toBe('one@example.com')

    await auth.saveTokens({ access_token: 'c' }, { email: 'three@example.com', makePrimary: true })
    expect((await auth.listAccounts()).primary).toBe('three@example.com')
    await auth.clear()
  })

  it('lists, re-primaries and removes accounts', async () => {
    const auth = new WorkspaceAuth(['openid'])
    await auth.saveTokens({ access_token: 'a' }, { email: 'one@example.com' })
    await auth.saveTokens({ access_token: 'b' }, { email: 'two@example.com' })

    expect(await auth.listAccounts()).toEqual({
      accounts: ['one@example.com', 'two@example.com'],
      primary: 'one@example.com'
    })

    await auth.setPrimary('two@example.com')
    expect((await auth.listAccounts()).primary).toBe('two@example.com')

    expect(await auth.removeAccount('one@example.com')).toEqual({ removed: true, newPrimary: 'two@example.com' })
    expect((await auth.listAccounts()).accounts).toEqual(['two@example.com'])
    await auth.clear()
  })

  it('adopts a legacy M1 blob by asking Google for the account email', async () => {
    // Blob phẳng M1 không có id_token -> chỉ còn cách hỏi userinfo.
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
    const auth = new WorkspaceAuth(['openid'])
    const spy = vi.spyOn(probeOf(auth), 'fetchAccountEmail').mockResolvedValue('adopted@example.com')

    const client = await auth.getAuthenticatedClient()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(client.credentials.access_token).toBe('legacy-at')
    // adoption phải giữ refresh_token -- đó là thứ duy nhất không lấy lại được
    expect(client.credentials.refresh_token).toBe('legacy-rt')
    expect((await auth.listAccounts()).accounts).toEqual(['adopted@example.com'])
    await auth.clear()
  })

  it('adopts the legacy blob only once -- the next call reads the migrated v2 blob', async () => {
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
    const auth = new WorkspaceAuth(['openid'])
    const spy = vi.spyOn(probeOf(auth), 'fetchAccountEmail').mockResolvedValue('adopted@example.com')

    await auth.getAuthenticatedClient()
    await auth.getAuthenticatedClient()

    expect(spy).toHaveBeenCalledTimes(1) // second call no longer touches the network
    await auth.clear()
  })

  it('never records the placeholder used while probing the legacy blob as an account', async () => {
    // Probe client phải KHÔNG gắn listener 'tokens': nếu gắn, một lần refresh
    // giữa lúc probe sẽ ghi một account tên '(legacy)' vào store.
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
    const auth = new WorkspaceAuth(['openid'])
    vi.spyOn(probeOf(auth), 'fetchAccountEmail').mockImplementation(async (client) => {
      // google-auth-library would emit this if it refreshed mid-probe
      ;(client as { emit: (event: string, payload: unknown) => boolean }).emit('tokens', {
        access_token: 'probe-refreshed'
      })
      return 'adopted@example.com'
    })

    await auth.getAuthenticatedClient()

    expect((await auth.listAccounts()).accounts).toEqual(['adopted@example.com'])
    await auth.clear()
  })

  it('keeps the legacy blob and explains what to do when the email cannot be resolved', async () => {
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at' })
    const auth = new WorkspaceAuth(['openid'])
    vi.spyOn(probeOf(auth), 'fetchAccountEmail').mockResolvedValue(undefined)

    await expect(auth.getAuthenticatedClient()).rejects.toThrow(/account_add|re-authorize/i)
    // token cũ KHÔNG bị xoá
    expect(await new PerPluginStore(STORE_PLUGIN).load()).not.toBeNull()
    await auth.clear()
  })

  it('lets a fresh consent complete even while an unadoptable legacy blob is on disk', async () => {
    // Chuỗi deadlock: adopt thất bại (cần mạng) -> state về awaiting_setup -> server
    // mở OAuth -> người dùng consent xong -> lần ghi ĐÓ bị guard chặn -> startup fail,
    // và setup_reset thì cần server đang chạy. saveTokens phải đi qua được trạng thái này.
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
    const auth = new WorkspaceAuth(['openid'])

    const email = await auth.saveTokens(
      { access_token: 'fresh-at', refresh_token: 'fresh-rt' },
      {
        email: 'fresh@example.com'
      }
    )

    expect(email).toBe('fresh@example.com')
    const { accounts, primary } = await auth.listAccounts()
    expect(accounts).toEqual([UNIDENTIFIED_ACCOUNT, 'fresh@example.com'])
    expect(primary).toBe('fresh@example.com')
    // Server dùng được ngay: client mặc định là account vừa consent.
    const client = await auth.getAuthenticatedClient()
    expect(client.credentials.access_token).toBe('fresh-at')
    // Và blob cũ không bị mất -- xoá được bằng account_remove.
    expect((await auth.removeAccount(UNIDENTIFIED_ACCOUNT)).removed).toBe(true)
    await auth.clear()
  })

  it('does not try to adopt a legacy blob when a specific account was asked for', async () => {
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at' })
    const auth = new WorkspaceAuth(['openid'])
    const spy = vi.spyOn(probeOf(auth), 'fetchAccountEmail').mockResolvedValue('adopted@example.com')

    await expect(auth.getAuthenticatedClient('someone@example.com')).rejects.toThrow(/not configured/i)

    expect(spy).not.toHaveBeenCalled()
    await auth.clear()
  })

  describe('fetchAccountEmail', () => {
    it('lowercases the email returned by the Google userinfo endpoint', async () => {
      const auth = new WorkspaceAuth(['openid'])
      vi.spyOn(google, 'oauth2').mockReturnValue({
        userinfo: { get: async () => ({ data: { email: 'Probe@Example.com' } }) }
      } as never)

      expect(await probeOf(auth).fetchAccountEmail({})).toBe('probe@example.com')
    })

    it('returns undefined when userinfo answers without an email', async () => {
      const auth = new WorkspaceAuth(['openid'])
      vi.spyOn(google, 'oauth2').mockReturnValue({
        userinfo: { get: async () => ({ data: {} }) }
      } as never)

      expect(await probeOf(auth).fetchAccountEmail({})).toBeUndefined()
    })

    it('returns undefined instead of throwing when the userinfo call fails', async () => {
      const auth = new WorkspaceAuth(['openid'])
      vi.spyOn(google, 'oauth2').mockReturnValue({
        userinfo: {
          get: async () => {
            throw new Error('401 invalid_token')
          }
        }
      } as never)

      expect(await probeOf(auth).fetchAccountEmail({})).toBeUndefined()
    })
  })
})
