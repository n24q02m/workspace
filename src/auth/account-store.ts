/**
 * Nhiều Google account trong MỘT blob mã hoá.
 *
 * PerPluginStore (`@n24q02m/hull/storage`) chỉ có đúng một credKey cho mỗi
 * (plugin, sub) — nên layout "một key mỗi account" mà spec §4.2
 * mô tả không dùng được. Gộp vào một blob cũng khiến mỗi lần ghi là atomic:
 * `accounts` và `primary` không bao giờ lệch nhau.
 */
import { PerPluginStore } from '@n24q02m/hull/storage'
import { STORE_PLUGIN } from '../constants.js'

export interface AccountRecord {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  scope?: string
  token_type?: string
  id_token?: string
}

export interface AccountsBlob {
  version: 2
  accounts: Record<string, AccountRecord>
  primary: string
}

/** Đọc claim `email` từ id_token. Không xác thực chữ ký: token do chính Google trả về trong luồng đã hoàn tất. */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (typeof idToken !== 'string') return undefined
  const payload = idToken.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    return typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** Blob phẳng của M1: token nằm ngay ở cấp trên, chưa có `version`. */
export function isLegacyBlob(raw: Record<string, unknown> | null): boolean {
  return raw !== null && raw.version === undefined && typeof raw.access_token === 'string'
}

/**
 * Key giữ blob M1 không xác định được chủ, thay vì xoá nó đi. Không phải email
 * nên không đụng vào không gian tên account thật, và vẫn hiện ra ở
 * `account_list` để người dùng xoá được bằng `account_remove`.
 */
export const UNIDENTIFIED_ACCOUNT = '(unidentified)'

const normalize = (email: string) => email.trim().toLowerCase()

export class AccountStore {
  private store: PerPluginStore

  /**
   * `sub` = namespace của người dùng (chế độ HTTP multi-user). Không truyền =
   * `null` = một bucket duy nhất, đúng cho stdio single-user.
   *
   * PerPluginStore đổi credKey theo sub: `better-workspace/subs/<sub>/config` so
   * với `better-workspace/config`, và khoá mã hoá cũng được derive theo sub
   * (khoá theo user thay cho khoá máy). Nên hai
   * sub khác nhau không đọc được blob của nhau kể cả khi chạm được cùng backend.
   *
   * Nhánh sub cần env `CREDENTIAL_SECRET`; thiếu nó thì lần đọc/ghi đầu tiên ném.
   * Một `sub` chứa ký tự ngoài `[a-zA-Z0-9._-]` bị `credPath()` từ chối NGAY trong
   * constructor này -- đó là hàng rào chặn path traversal, giữ nguyên đừng bọc lại.
   */
  constructor(sub: string | null = null) {
    this.store = new PerPluginStore(STORE_PLUGIN, sub)
  }

  /**
   * Trả blob v2. Nếu trên đĩa còn là blob phẳng M1 thì tự migrate KHI suy ra
   * được email từ id_token; nếu không suy ra được thì trả null và để nguyên
   * blob cũ (không được làm mất token của người dùng) — Task 3 sẽ hỏi Google
   * lấy email rồi gọi `put`.
   */
  async load(): Promise<AccountsBlob | null> {
    const raw = await this.store.load()
    if (raw === null) return null
    if (!isLegacyBlob(raw)) {
      const blob = raw as unknown as AccountsBlob
      return blob.version === 2 && blob.accounts ? blob : null
    }
    const legacy = raw as unknown as AccountRecord
    const email = emailFromIdToken(legacy.id_token)
    if (!email) return null
    const migrated: AccountsBlob = { version: 2, accounts: { [email]: legacy }, primary: email }
    await this.store.save(migrated as unknown as Record<string, unknown>)
    return migrated
  }

  /** Blob phẳng M1 chưa migrate được, hoặc null. */
  async loadLegacy(): Promise<AccountRecord | null> {
    const raw = await this.store.load()
    return isLegacyBlob(raw) ? (raw as unknown as AccountRecord) : null
  }

  /**
   * Nhận blob phẳng M1 về dưới tên `email` -- cửa ra hợp lệ duy nhất của guard
   * trong `put()`. Tách hẳn khỏi `put()` vì hai ý định khác nhau: `put` là
   * "thêm một account MỚI" (và phải từ chối khi làm vậy sẽ đè mất blob cũ),
   * còn đây là "blob cũ đó CHÍNH LÀ account này, ghi lại đúng chỗ".
   *
   * Ghi trong MỘT lần `save()`, không `clear()` rồi `save()`: một cú crash
   * giữa hai bước sẽ xoá sạch refresh_token mà người dùng không lấy lại được
   * mà không OAuth lại.
   *
   * Trả về record đã nhận, hoặc null nếu trên đĩa không (còn) là blob phẳng --
   * nhờ đó gọi lại lần hai là no-op thay vì làm hỏng blob v2 đang có.
   */
  async adoptLegacy(email: string): Promise<AccountRecord | null> {
    const legacy = await this.loadLegacy()
    if (!legacy) return null
    const key = normalize(email)
    await this.store.save({
      version: 2,
      accounts: { [key]: legacy },
      primary: key
    } as unknown as Record<string, unknown>)
    return legacy
  }

  /**
   * `absorbLegacy` dành cho caller đứng ngay sau một lần consent người dùng vừa
   * hoàn tất. Không có cờ đó, một blob M1 chưa nhận về sẽ khiến `put` từ chối.
   */
  async put(
    email: string,
    record: AccountRecord,
    opts: { makePrimary?: boolean; absorbLegacy?: boolean } = {}
  ): Promise<void> {
    const key = normalize(email)
    const existing = await this.load()
    let carried: Record<string, AccountRecord> = {}
    if (!existing) {
      // load() trả null cho CẢ "chưa có gì" lẫn "có blob M1 nhưng chưa nhận về
      // được". Ghi đè ở trường hợp thứ hai sẽ xoá refresh_token của người dùng,
      // nên dừng lại thật to thay vì mất dữ liệu: caller nhận blob cũ về trước
      // (WorkspaceAuth.getAuthenticatedClient làm việc đó), hoặc người dùng chủ
      // động bỏ nó bằng config(action="setup_reset").
      const legacy = await this.loadLegacy()
      if (legacy) {
        if (!opts.absorbLegacy) {
          throw new Error(
            'Refusing to overwrite credentials stored in the older single-account layout. Adopt them first, or clear them deliberately with config(action="setup_reset") before adding a new account.'
          )
        }
        // Người dùng vừa hoàn tất consent, nên ghi là đúng ý họ -- nhưng vẫn không
        // xoá blob cũ: giữ nó dưới UNIDENTIFIED_ACCOUNT để account_list thấy được và
        // account_remove xoá được. Chặn ở đây thay vì hấp thụ sẽ làm startup không
        // thoát được: guard chặn chính lần ghi đó, mà setup_reset lại cần server đang chạy.
        carried = { [UNIDENTIFIED_ACCOUNT]: legacy }
      }
    }
    const base = existing ?? { version: 2 as const, accounts: carried, primary: key }
    const accounts = { ...base.accounts, [key]: record }
    const primary = opts.makePrimary || !base.accounts[base.primary] ? key : base.primary
    await this.store.save({ version: 2, accounts, primary } as unknown as Record<string, unknown>)
  }

  /** `email` không truyền = primary. Account lạ trả null (KHÔNG âm thầm rơi về primary). */
  async get(email?: string): Promise<{ email: string; record: AccountRecord } | null> {
    const blob = await this.load()
    if (!blob) return null
    const key = email ? normalize(email) : blob.primary
    const record = blob.accounts[key]
    return record ? { email: key, record } : null
  }

  async list(): Promise<{ accounts: string[]; primary: string | null }> {
    const blob = await this.load()
    if (!blob) return { accounts: [], primary: null }
    return { accounts: Object.keys(blob.accounts).sort(), primary: blob.primary }
  }

  async remove(email: string): Promise<{ removed: boolean; newPrimary: string | null }> {
    const blob = await this.load()
    if (!blob) return { removed: false, newPrimary: null }
    const key = normalize(email)
    if (!blob.accounts[key]) return { removed: false, newPrimary: blob.primary }
    const accounts = { ...blob.accounts }
    delete accounts[key]
    const remaining = Object.keys(accounts)
    if (remaining.length === 0) {
      await this.store.clear()
      return { removed: true, newPrimary: null }
    }
    // Đề account khác lên trước UNIDENTIFIED_ACCOUNT: nó là credential không biết
    // của ai, thường đã hết hiệu lực. Để nó thành primary là âm thầm đưa mọi lời
    // gọi không truyền `account` sang một mailbox không xác định -- đúng cái mà
    // "account lạ = lỗi, không rơi về primary" tồn tại để tránh.
    const promoted = remaining.find((k) => k !== UNIDENTIFIED_ACCOUNT) ?? (remaining[0] as string)
    const primary = blob.primary === key ? promoted : blob.primary
    await this.store.save({ version: 2, accounts, primary } as unknown as Record<string, unknown>)
    return { removed: true, newPrimary: primary }
  }

  async setPrimary(email: string): Promise<void> {
    const blob = await this.load()
    const key = normalize(email)
    if (!blob?.accounts[key]) {
      throw new Error(`Account ${key} is not configured.`)
    }
    await this.store.save({ ...blob, primary: key } as unknown as Record<string, unknown>)
  }

  async clear(): Promise<void> {
    await this.store.clear()
  }
}
