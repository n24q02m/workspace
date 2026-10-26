export const SERVER_NAME = 'workspace'

// Credential namespace for hull PerPluginStore. Deliberately NOT renamed with SERVER_NAME:
// hull keys the on-disk directory off this slug (~/.better-workspace/), and reads the
// legacy mcp-core location (~/.better-workspace-mcp/) as a fallback, so existing
// credentials keep resolving after the cutover. Renaming the slug would move the store.
export const STORE_PLUGIN = 'better-workspace'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// openid+email → id_token with a stable `sub`. Workspace domains added per-service.
export const BASE_SCOPES = ['openid', 'email', 'profile']
