import { type Auth, google } from 'googleapis'
import { type AccountRecord, AccountStore, emailFromIdToken } from './account-store.js'

export interface GoogleTokens {
  access_token: string
  refresh_token?: string
  expiry_date?: number
  scope?: string
  token_type?: string
  id_token?: string
}

export class WorkspaceAuth {
  private accounts: AccountStore

  // scopes kept for parity with the upstream AuthManager(scopes) contract; not currently read
  // by the OAuth setup flow, which uses its own WORKSPACE_SCOPES (see oauth-setup.ts).
  //
  // `sub` là JWT subject của chế độ HTTP multi-user; nó chỉ đi thẳng xuống store.
  // Không truyền = null = bucket single-user của stdio.
  constructor(
    public readonly scopes: string[],
    sub: string | null = null
  ) {
    this.accounts = new AccountStore(sub)
  }

  /** Lưu token cho một account. Trả về email đã dùng làm key. */
  async saveTokens(tokens: GoogleTokens, opts: { email?: string; makePrimary?: boolean } = {}): Promise<string> {
    // Google's raw token response carries expires_in (relative seconds), not expiry_date
    // (absolute ms). Compute it here so getAuthenticatedClient can refresh proactively
    // instead of only reacting to a 401.
    const record = { ...tokens } as AccountRecord
    const rawExpiresIn = (tokens as unknown as Record<string, unknown>).expires_in
    if (record.expiry_date === undefined && typeof rawExpiresIn === 'number') {
      record.expiry_date = Date.now() + rawExpiresIn * 1000
    }
    const email = opts.email?.trim().toLowerCase() ?? emailFromIdToken(tokens.id_token)
    if (!email) {
      throw new Error('Cannot store Google tokens without an account email (no id_token email claim and none passed).')
    }
    // absorbLegacy: hai caller ngoài (runOAuthSetup, startAddAccount) đều đứng ngay
    // sau một lần consent người dùng vừa hoàn tất, nên ghi là đúng ý họ -- và nếu
    // KHÔNG hấp thụ thì một lần adopt thất bại (cần mạng) sẽ khoá người dùng ngoài
    // server: guard chặn chính lần ghi này, mà setup_reset lại cần server đang chạy.
    // Caller thứ ba là listener 'tokens' của buildClient (auto-refresh, không phải
    // consent); đường đó chỉ chạy khi blob v2 đã tồn tại, nên cờ này không tới lượt
    // được đọc ở đó.
    await this.accounts.put(email, record, { makePrimary: opts.makePrimary, absorbLegacy: true })
    return email
  }

  async listAccounts(): Promise<{ accounts: string[]; primary: string | null }> {
    return this.accounts.list()
  }

  async removeAccount(email: string): Promise<{ removed: boolean; newPrimary: string | null }> {
    return this.accounts.remove(email)
  }

  async setPrimary(email: string): Promise<void> {
    return this.accounts.setPrimary(email)
  }

  async clear(): Promise<void> {
    await this.accounts.clear()
  }

  /** Hỏi Google email của account đang giữ token. Tách thành method để test thay được. */
  protected async fetchAccountEmail(client: Auth.OAuth2Client): Promise<string | undefined> {
    try {
      const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get()
      return typeof data.email === 'string' ? data.email.toLowerCase() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * OAuth2Client mang đúng `record`, KHÔNG gắn listener ghi lại token. Dùng cho
   * lần probe blob legacy: lúc đó ta còn chưa biết account tên gì, nên nếu
   * library refresh token giữa lúc probe thì listener sẽ ghi vào store một
   * account mang tên placeholder (hoặc đâm vào guard của `put()` thành unhandled
   * rejection, vì listener là fire-and-forget).
   */
  private buildBareClient(record: AccountRecord): Auth.OAuth2Client {
    const client = new google.auth.OAuth2({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET
    })
    client.setCredentials({
      access_token: record.access_token,
      refresh_token: record.refresh_token,
      expiry_date: record.expiry_date,
      scope: record.scope,
      token_type: record.token_type
    })
    return client
  }

  private buildClient(email: string, record: AccountRecord): Auth.OAuth2Client {
    const client = this.buildBareClient(record)
    // Persist auto-refreshed tokens so a fresh access_token survives restarts.
    // Merge order matters: {...record, ...t} keeps the stored refresh_token because
    // google-auth-library's 'tokens' event omits refresh_token on a refresh grant
    // (it's re-attached by the library AFTER this emit). Never flip to {...t, ...record}.
    client.on('tokens', (t) => {
      void this.saveTokens({ ...record, ...t } as GoogleTokens, { email })
    })
    return client
  }

  /**
   * Client cho `account` (không truyền = primary). Luôn tạo client MỚI: cache
   * dùng chung sẽ giữ snapshot record cũ trong closure của listener và làm rò
   * credential giữa các account.
   */
  async getAuthenticatedClient(account?: string): Promise<Auth.OAuth2Client> {
    const hit = await this.accounts.get(account)
    if (hit) return this.buildClient(hit.email, hit.record)

    // Chưa có blob v2. Có thể là blob phẳng M1 không suy được email từ id_token
    // -- nhận nó về bằng cách hỏi Google, thay vì bắt người dùng OAuth lại. Chỉ
    // làm khi caller không chỉ định account: một account cụ thể mà không nằm
    // trong store thì không thể là chủ của blob cũ.
    if (!account) {
      const legacy = await this.accounts.loadLegacy()
      if (legacy) {
        const email = await this.fetchAccountEmail(this.buildBareClient(legacy))
        if (email) {
          await this.accounts.adoptLegacy(email)
          return this.buildClient(email, legacy)
        }
        throw new Error(
          'Stored Google credentials are from an older single-account layout and the account email could not be resolved. Run config(action="account_add") to re-authorize, or re-authorize the existing account.'
        )
      }
    }

    if (account) {
      const { accounts } = await this.accounts.list()
      const known = accounts.length > 0 ? ` Configured accounts: ${accounts.join(', ')}.` : ''
      throw new Error(`Account ${account.trim().toLowerCase()} is not configured.${known}`)
    }
    throw new Error(
      'Google account not configured. Run `workspace auth` on the host to complete the Google consent (see setup docs).'
    )
  }
}
