import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// startServer/bootstrap need every I/O-touching dependency mocked so the
// suite stays hermetic: no real Google OAuth, no real stdio transport.
vi.mock('./auth/credential-state.js', () => ({
  getState: vi.fn(),
  resolveCredentialState: vi.fn()
}))
vi.mock('./auth/oauth-setup.js', () => ({ runOAuthSetup: vi.fn() }))
vi.mock('./tools/registry.js', () => ({ registerTools: vi.fn() }))
// main.ts loads the http transport through a static import; vi.mock replaces it here.
vi.mock('./transports/http.js', () => ({ startHttp: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  // Must be `new`-able (main.ts does `new StdioServerTransport()`) -- an
  // arrow-function mock implementation cannot be a constructor.
  StdioServerTransport: vi.fn(function StdioServerTransport(this: { start: () => Promise<void> }) {
    this.start = vi.fn().mockResolvedValue(undefined)
  })
}))

import { getState, resolveCredentialState } from './auth/credential-state.js'
import { runOAuthSetup } from './auth/oauth-setup.js'
import { bootstrap, getTransportMode, startServer } from './main.js'
import { registerTools } from './tools/registry.js'
import { startHttp } from './transports/http.js'

describe('getTransportMode', () => {
  const originalEnv = process.env
  const originalArgv = process.argv

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
  })

  afterEach(() => {
    process.env = originalEnv
    process.argv = originalArgv
    vi.unstubAllEnvs()
  })

  it('defaults to stdio when no flag or env is set', () => {
    expect(getTransportMode({}, [])).toBe('stdio')
  })

  it('selects http via the --http flag', () => {
    expect(getTransportMode({}, ['--http'])).toBe('http')
  })

  it('does not match a flag that merely starts with --http', () => {
    expect(getTransportMode({}, ['--http-proxy'])).toBe('stdio')
  })

  it('selects http via MCP_TRANSPORT=http', () => {
    expect(getTransportMode({ MCP_TRANSPORT: 'http' }, [])).toBe('http')
  })

  it('selects http via TRANSPORT_MODE=http', () => {
    expect(getTransportMode({ TRANSPORT_MODE: 'http' }, [])).toBe('http')
  })

  it('reads current process.env / process.argv when no arguments are provided', () => {
    vi.stubEnv('TRANSPORT_MODE', 'http')
    expect(getTransportMode()).toBe('http')
  })
})

describe('startServer', () => {
  const originalEnv = process.env
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Fresh copy each test -- startServer mutates BETTER_WORKSPACE_MCP_BOOTSTRAPPED
    // as a side effect, so this must not leak between tests.
    process.env = { ...originalEnv }
    vi.clearAllMocks()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = originalEnv
    errorSpy.mockRestore()
  })

  it('hands http mode to the http transport without touching the stdio OAuth path', async () => {
    vi.mocked(startHttp).mockResolvedValue(undefined)

    await startServer('http')

    expect(startHttp).toHaveBeenCalledOnce()
    // The stdio branch runs the Google consent in the browser. Over HTTP that consent is
    // handled by the host CLI `auth` command, so it must NOT run in http mode.
    expect(runOAuthSetup).not.toHaveBeenCalled()
    expect(resolveCredentialState).not.toHaveBeenCalled()
    expect(registerTools).not.toHaveBeenCalled()
  })

  it('serves directly without OAuth setup when already configured', async () => {
    vi.mocked(resolveCredentialState).mockResolvedValue('configured')
    vi.mocked(getState).mockReturnValue('configured')

    await startServer('stdio')

    expect(runOAuthSetup).not.toHaveBeenCalled()
    expect(resolveCredentialState).toHaveBeenCalledOnce()
    expect(registerTools).toHaveBeenCalledWith(expect.any(Server))
  })

  it('runs OAuth setup before serving when not yet configured', async () => {
    vi.mocked(resolveCredentialState).mockResolvedValue('awaiting_setup')
    vi.mocked(getState).mockReturnValue('awaiting_setup')
    vi.mocked(runOAuthSetup).mockResolvedValue(undefined)

    await startServer('stdio')

    expect(runOAuthSetup).toHaveBeenCalledOnce()
    expect(resolveCredentialState).toHaveBeenCalledTimes(2)
    expect(registerTools).toHaveBeenCalledWith(expect.any(Server))
  })

  it('returns early on a second call in the same process (fork-bomb guard)', async () => {
    process.env.BETTER_WORKSPACE_MCP_BOOTSTRAPPED = 'true'

    await expect(startServer('http')).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Startup aborted'))
    // Không transport nào được dựng: guard phải chặn TRƯỚC cả nhánh mode. `startHttp`
    // là bằng chứng cho nhánh http (trước đây là cái throw Milestone-3, nay không còn).
    expect(startHttp).not.toHaveBeenCalled()
    expect(resolveCredentialState).not.toHaveBeenCalled()
    expect(registerTools).not.toHaveBeenCalled()
  })
})

describe('bootstrap', () => {
  const originalEnv = process.env
  let exitSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = originalEnv
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('catches a thrown error and exits the process with code 1', async () => {
    // A transport that cannot start (for example http mode without CREDENTIAL_SECRET) must
    // surface through bootstrap. The throw is simulated here: startHttp is mocked.
    vi.mocked(startHttp).mockRejectedValue(
      new Error(
        'CREDENTIAL_SECRET is required for http mode: per-user credential stores derive their encryption key from it.'
      )
    )

    await bootstrap('http')

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to start server:',
      'CREDENTIAL_SECRET is required for http mode: per-user credential stores derive their encryption key from it.'
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
