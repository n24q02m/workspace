import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// startHttp hands the MCP surface to hull's runHttpServer. Mock it so the suite
// never binds a socket; the captured options and factory are what this module owns.
vi.mock('@n24q02m/hull/transport', () => ({
  runHttpServer: vi.fn()
}))
vi.mock('../tools/registry.js', () => ({ registerTools: vi.fn() }))

import { runHttpServer } from '@n24q02m/hull/transport'
import { registerTools } from '../tools/registry.js'
import { startHttp, USERS_FILE_ENV } from './http.js'

type HttpOptions = {
  serverName: string
  port: number
  host: string | undefined
  auth: { mode: string; usersFile: string | undefined }
}

const mockedRunHttpServer = vi.mocked(runHttpServer)

describe('startHttp', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.CREDENTIAL_SECRET
    delete process.env[USERS_FILE_ENV]
    delete process.env.PORT
    delete process.env.HOST
    vi.clearAllMocks()
    mockedRunHttpServer.mockResolvedValue({ port: 0, host: '127.0.0.1', close: vi.fn() } as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('refuses to start without CREDENTIAL_SECRET and never reaches hull', async () => {
    await expect(startHttp()).rejects.toThrow(
      'CREDENTIAL_SECRET is required for http mode: per-user credential stores derive their encryption key from it.'
    )
    expect(mockedRunHttpServer).not.toHaveBeenCalled()
  })

  it('passes multi auth with no users file when WORKSPACE_USERS_FILE is unset', () => {
    process.env.CREDENTIAL_SECRET = 'test-credential-secret'

    void startHttp()

    expect(mockedRunHttpServer).toHaveBeenCalledOnce()
    const options = mockedRunHttpServer.mock.calls[0]?.[1] as unknown as HttpOptions
    expect(options.serverName).toBe('workspace')
    expect(options.auth).toEqual({ mode: 'multi', usersFile: undefined })
  })

  it('passes WORKSPACE_USERS_FILE through as the multi-auth users file', () => {
    process.env.CREDENTIAL_SECRET = 'test-credential-secret'
    process.env[USERS_FILE_ENV] = '/etc/workspace/users.toml'

    void startHttp()

    const options = mockedRunHttpServer.mock.calls[0]?.[1] as unknown as HttpOptions
    expect(options.auth).toEqual({ mode: 'multi', usersFile: '/etc/workspace/users.toml' })
  })

  it('parses PORT and HOST into the hull server options', () => {
    process.env.CREDENTIAL_SECRET = 'test-credential-secret'
    process.env.PORT = '8123'
    process.env.HOST = '0.0.0.0'

    void startHttp()

    const options = mockedRunHttpServer.mock.calls[0]?.[1] as unknown as HttpOptions
    expect(options.port).toBe(8123)
    expect(options.host).toBe('0.0.0.0')
  })

  it('builds one Server per MCP session with the registry tools and no local filesystem', async () => {
    process.env.CREDENTIAL_SECRET = 'test-credential-secret'

    void startHttp()

    const factory = mockedRunHttpServer.mock.calls[0]?.[0] as unknown as () => { connect: unknown }
    const server = factory()
    expect(typeof server.connect).toBe('function')
    expect(registerTools).toHaveBeenCalledWith(server, { allowLocalFilesystem: false })
  })
})
