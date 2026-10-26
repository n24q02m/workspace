// Shim implementing the upstream AuthManager contract (getAuthenticatedClient)
// so byte-identical vendored services run unmodified over our hull-backed auth.
// Real credential logic lives in src/auth/WorkspaceAuth. Upstream's
// AuthManager(scopes) + getAuthenticatedClient() surface is preserved -- the
// selected account travels via AsyncLocalStorage (see auth/account-context.ts)
// precisely so this signature stays upstream-compatible.
import type { Auth } from 'googleapis'
import { currentAccount } from '../../auth/account-context.js'
import { getAuth } from '../../auth/credential-state.js'

export class AuthManager {
  constructor(public readonly scopes: string[] = []) {}
  async getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
    return getAuth().getAuthenticatedClient(currentAccount())
  }
}
