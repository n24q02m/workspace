import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STORE_PLUGIN } from '../constants.js'
import { AccountStore, emailFromIdToken, isLegacyBlob, UNIDENTIFIED_ACCOUNT } from './account-store.js'

// id_token là JWT không cần chữ ký hợp lệ ở đây: chỉ payload được đọc.
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

const REC = { access_token: 'at', refresh_token: 'rt', expiry_date: 4_000_000_000_000 }

describe('emailFromIdToken', () => {
  it('reads the email claim', () => {
    expect(emailFromIdToken(fakeIdToken({ sub: '1', email: 'A@Example.com' }))).toBe('a@example.com')
  })
  it('returns undefined for a token without an email claim', () => {
    expect(emailFromIdToken(fakeIdToken({ sub: '1' }))).toBeUndefined()
  })
  it('returns undefined for undefined or malformed input', () => {
    expect(emailFromIdToken(undefined)).toBeUndefined()
    expect(emailFromIdToken('not-a-jwt')).toBeUndefined()
    expect(emailFromIdToken('a.!!!.c')).toBeUndefined()
  })
})

describe('isLegacyBlob', () => {
  it('detects the flat M1 shape', () => {
    expect(isLegacyBlob({ access_token: 'at' })).toBe(true)
  })
  it('rejects the v2 shape and null', () => {
    expect(isLegacyBlob({ version: 2, accounts: {}, primary: '' })).toBe(false)
    expect(isLegacyBlob(null)).toBe(false)
  })
})

describe('AccountStore', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bws-accounts-test-'))
    setHomeDirForTesting(home)
  })
  afterEach(() => {
    setHomeDirForTesting(null)
    rmSync(home, { recursive: true, force: true })
  })

  it('returns null before anything is stored', async () => {
    expect(await new AccountStore().load()).toBeNull()
    expect(await new AccountStore().get()).toBeNull()
  })

  it('stores the first account and makes it primary automatically', async () => {
    const store = new AccountStore()
    await store.put('First@Example.com', REC)
    expect(await store.list()).toEqual({ accounts: ['first@example.com'], primary: 'first@example.com' })
    const got = await store.get()
    expect(got?.email).toBe('first@example.com')
    expect(got?.record.access_token).toBe('at')
  })

  it('keeps the existing primary when a second account is added without makePrimary', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await store.put('two@example.com', { ...REC, access_token: 'at2' })
    expect((await store.list()).primary).toBe('one@example.com')
    expect((await store.get('two@example.com'))?.record.access_token).toBe('at2')
  })

  it('switches primary when makePrimary is set', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await store.put('two@example.com', REC, { makePrimary: true })
    expect((await store.list()).primary).toBe('two@example.com')
  })

  it('resolves an unknown account to null rather than falling back to primary', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    expect(await store.get('nobody@example.com')).toBeNull()
  })

  it('removes an account and promotes a remaining one when the primary goes away', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await store.put('two@example.com', REC)
    expect(await store.remove('one@example.com')).toEqual({ removed: true, newPrimary: 'two@example.com' })
    expect((await store.list()).primary).toBe('two@example.com')
  })

  it('clears the blob when the last account is removed', async () => {
    const store = new AccountStore()
    await store.put('only@example.com', REC)
    expect(await store.remove('only@example.com')).toEqual({ removed: true, newPrimary: null })
    expect(await store.load()).toBeNull()
  })

  it('reports removed:false for an account that was never there', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    expect(await store.remove('ghost@example.com')).toEqual({ removed: false, newPrimary: 'one@example.com' })
  })

  it('refuses to set primary to an unknown account', async () => {
    const store = new AccountStore()
    await store.put('one@example.com', REC)
    await expect(store.setPrimary('ghost@example.com')).rejects.toThrow(/not configured/i)
  })

  it('migrates a flat M1 blob in place when it carries an id_token with an email', async () => {
    await new PerPluginStore(STORE_PLUGIN).save({ ...REC, id_token: fakeIdToken({ email: 'legacy@example.com' }) })
    const store = new AccountStore()
    expect(await store.load()).toEqual({
      version: 2,
      accounts: { 'legacy@example.com': expect.objectContaining({ access_token: 'at' }) },
      primary: 'legacy@example.com'
    })
    // migration được ghi lại xuống đĩa, không phải chỉ trong bộ nhớ
    expect(isLegacyBlob(await new PerPluginStore(STORE_PLUGIN).load())).toBe(false)
  })

  it('leaves a flat blob untouched and exposes it via loadLegacy when the email cannot be derived', async () => {
    await new PerPluginStore(STORE_PLUGIN).save({ ...REC })
    const store = new AccountStore()
    expect(await store.load()).toBeNull()
    expect((await store.loadLegacy())?.access_token).toBe('at')
    expect(isLegacyBlob(await new PerPluginStore(STORE_PLUGIN).load())).toBe(true)
  })

  it('refuses to overwrite an unadopted legacy blob instead of losing its tokens', async () => {
    // Blob phẳng M1 không có id_token -> load() trả null, nhưng dữ liệu vẫn ở đó.
    await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
    const store = new AccountStore()

    await expect(store.put('new@example.com', REC)).rejects.toThrow(/older single-account layout/i)

    // Token cũ còn nguyên, không bị ghi đè.
    expect((await store.loadLegacy())?.access_token).toBe('legacy-at')
    expect((await store.loadLegacy())?.refresh_token).toBe('legacy-rt')
  })

  describe('absorbLegacy', () => {
    it('absorbs an unidentified legacy blob instead of deadlocking the next consent', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()

      await store.put('new@example.com', REC, { absorbLegacy: true })

      const { accounts, primary } = await store.list()
      expect(accounts).toContain('new@example.com')
      expect(accounts).toContain(UNIDENTIFIED_ACCOUNT)
      expect(primary).toBe('new@example.com')
      // token cũ vẫn còn, xoá được bằng account_remove
      expect((await store.get(UNIDENTIFIED_ACCOUNT))?.record.refresh_token).toBe('legacy-rt')
    })

    it('still refuses when the caller did not just complete a consent', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at' })
      const store = new AccountStore()
      await expect(store.put('new@example.com', REC)).rejects.toThrow(/older single-account layout/i)
    })

    it('lets account_remove clear the absorbed blob, leaving the real account alone', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()
      await store.put('new@example.com', REC, { absorbLegacy: true })

      expect(await store.remove(UNIDENTIFIED_ACCOUNT)).toEqual({ removed: true, newPrimary: 'new@example.com' })
      expect(await store.list()).toEqual({ accounts: ['new@example.com'], primary: 'new@example.com' })
    })

    it('promotes a real account over the unidentified blob when the primary is removed', async () => {
      // (unidentified) là credential không biết của ai và thường đã hết hiệu lực.
      // Để nó lên primary là âm thầm đưa mọi lời gọi không truyền `account` sang
      // một mailbox không xác định.
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()
      await store.put('first@example.com', REC, { absorbLegacy: true })
      await store.put('second@example.com', REC)

      expect(await store.remove('first@example.com')).toEqual({ removed: true, newPrimary: 'second@example.com' })
      expect((await store.list()).primary).toBe('second@example.com')
    })

    it('falls back to the unidentified blob only when nothing else is left', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()
      await store.put('only@example.com', REC, { absorbLegacy: true })

      expect(await store.remove('only@example.com')).toEqual({ removed: true, newPrimary: UNIDENTIFIED_ACCOUNT })
    })
  })

  describe('adoptLegacy', () => {
    it('turns the flat blob into a v2 blob under the given email, keeping its tokens', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()

      expect(await store.adoptLegacy('Adopted@Example.com')).toMatchObject({ access_token: 'legacy-at' })

      expect(await store.load()).toEqual({
        version: 2,
        accounts: {
          'adopted@example.com': expect.objectContaining({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
        },
        primary: 'adopted@example.com'
      })
      expect(isLegacyBlob(await new PerPluginStore(STORE_PLUGIN).load())).toBe(false)
      expect(await store.loadLegacy()).toBeNull()
    })

    it('unblocks put() -- the guard only fires while the legacy blob is unadopted', async () => {
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()

      await store.adoptLegacy('adopted@example.com')
      await store.put('new@example.com', REC)

      expect((await store.list()).accounts).toEqual(['adopted@example.com', 'new@example.com'])
      // adoption giữ ngôi primary, thêm account mới không cướp nó
      expect((await store.list()).primary).toBe('adopted@example.com')
    })

    it('returns null when there is no flat blob to adopt', async () => {
      const store = new AccountStore()
      expect(await store.adoptLegacy('nobody@example.com')).toBeNull()

      await store.put('one@example.com', REC)
      expect(await store.adoptLegacy('one@example.com')).toBeNull()
      // blob v2 đang có không bị adoptLegacy làm hỏng
      expect((await store.list()).accounts).toEqual(['one@example.com'])
    })

    it('is a no-op the second time, leaving every account of the v2 blob in place', async () => {
      // Bảo hiểm cho tuyên bố "gọi lần hai là no-op" trong doc-comment: nếu
      // adoptLegacy ghi vô điều kiện thì nó thu blob v2 về đúng MỘT account và
      // xoá sạch những account thêm sau lần adopt -- mất token thật.
      await new PerPluginStore(STORE_PLUGIN).save({ access_token: 'legacy-at', refresh_token: 'legacy-rt' })
      const store = new AccountStore()
      await store.adoptLegacy('adopted@example.com')
      await store.put('second@example.com', { ...REC, access_token: 'at2' })

      expect(await store.adoptLegacy('adopted@example.com')).toBeNull()

      expect(await store.list()).toEqual({
        accounts: ['adopted@example.com', 'second@example.com'],
        primary: 'adopted@example.com'
      })
      expect((await store.get('second@example.com'))?.record.access_token).toBe('at2')
      expect((await store.get('adopted@example.com'))?.record.refresh_token).toBe('legacy-rt')
    })
  })

  describe('per-subject keying', () => {
    // Bucket theo sub cần CREDENTIAL_SECRET: PerPluginStore derive khoá mã hoá
    // qua `deriveMultiUserKey` (per-plugin-store.ts:85) và NÉM khi thiếu biến
    // đó, khác hẳn nhánh sub=null vốn tự sinh khoá máy trên đĩa. Đặt ở đây chứ
    // không ở beforeEach ngoài, để những test stdio phía trên vẫn chạy đúng cái
    // môi trường chúng vẫn chạy.
    const originalSecret = process.env.CREDENTIAL_SECRET

    beforeEach(() => {
      process.env.CREDENTIAL_SECRET = 'test-credential-secret-at-least-32-chars'
    })
    afterEach(() => {
      if (originalSecret === undefined) delete process.env.CREDENTIAL_SECRET
      else process.env.CREDENTIAL_SECRET = originalSecret
    })

    it('keeps two subjects in separate credential buckets', async () => {
      const alice = new AccountStore('sub-alice')
      const bob = new AccountStore('sub-bob')

      await alice.put('shared@example.com', { ...REC, access_token: 'alice-token' })
      await bob.put('shared@example.com', { ...REC, access_token: 'bob-token' })

      expect((await alice.get('shared@example.com'))?.record.access_token).toBe('alice-token')
      expect((await bob.get('shared@example.com'))?.record.access_token).toBe('bob-token')
    })

    it('does not let one subject see another subject accounts', async () => {
      const alice = new AccountStore('sub-alice')
      const bob = new AccountStore('sub-bob')

      await alice.put('only-alice@example.com', REC)

      expect((await bob.list()).accounts).toEqual([])
      expect(await bob.get('only-alice@example.com')).toBeNull()
    })

    it('defaults to the single-user bucket when no sub is given (stdio behavior unchanged)', async () => {
      const stdio = new AccountStore()
      await stdio.put('local@example.com', REC)
      expect((await new AccountStore().list()).accounts).toEqual(['local@example.com'])
      // và bucket đó KHÔNG lẫn với bucket của một sub
      expect((await new AccountStore('sub-x').list()).accounts).toEqual([])
    })

    it('rejects a sub that would escape the per-subject directory', async () => {
      // credPath() của hull validate sub (per-plugin-store.ts:34-40) và ném
      // ngay trong constructor. Ghi lại ở đây vì `getAuth()` dựng AccountStore từ
      // một giá trị lấy từ JWT: đường ném đó là đường bảo vệ, không phải tai nạn.
      expect(() => new AccountStore('../escape')).toThrow(/Invalid sub/i)
      expect(() => new AccountStore('has/slash')).toThrow(/Invalid sub/i)
    })
  })
})
