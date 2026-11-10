export const SERVER_NAME = 'workspace'

// Credential namespace for hull PerPluginStore. hull keys the on-disk directory off this slug,
// so the store lives in ~/.workspace/ (hull adds the leading dot). Earlier releases wrote
// ~/.better-workspace/ and, before that, ~/.better-workspace-mcp/; hull still reads the latter
// as a read-only fallback, and src/data-dir-migration.ts copies the former forward on startup.
export const STORE_PLUGIN = 'workspace'

// Slug every release up to 0.4.x passed to hull. It is a migration source only: the
// credential store under ~/.better-workspace/ is re-encrypted into STORE_PLUGIN's store.
export const LEGACY_STORE_PLUGIN = 'better-workspace'

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

// openid+email → id_token with a stable `sub`. Workspace domains added per-service.
export const BASE_SCOPES = ['openid', 'email', 'profile']
