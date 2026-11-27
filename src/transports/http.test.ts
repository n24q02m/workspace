import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { hashToken } from '@n24q02m/hull/token-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { skillsAttachMock } = vi.hoisted(() => ({
  skillsAttachMock: vi.fn((mcp: { server: unknown }) => {
    void mcp
  })
}))

vi.mock('../skills.js', () => ({
  loadWorkspaceSkillsCatalog: vi.fn().mockResolvedValue({ attach: skillsAttachMock })
}))
vi.mock('../tools/registry.js', () => ({ registerTools: vi.fn() }))

import { registerTools } from '../tools/registry.js'
import { createWorkspaceHttpServer, startHttp, USERS_FILE_ENV } from './http.js'

describe('HTTP transport (2026-07-28 Streamable HTTP + hull multi auth)', () => {
  const originalEnv = process.env
  const tempDirs: string[] = []

  const makeUsersFile = async (token = 'valid-token'): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'bws-http-unit-'))
    tempDirs.push(dir)
    const usersFile = join(dir, 'users.toml')
    const tokenHash = await hashToken(token)
    writeFileSync(
      usersFile,
      [
        '[users.alice]',
        `token_hash = "${tokenHash}"`,
        'enabled = true',
        'namespace = "alice"',
        'allowed_roots = []'
      ].join('\n'),
      'utf8'
    )
    return usersFile
  }

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.CREDENTIAL_SECRET
    delete process.env[USERS_FILE_ENV]
    delete process.env.PORT
    delete process.env.HOST
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to start without CREDENTIAL_SECRET', async () => {
    await expect(startHttp()).rejects.toThrow(
      'CREDENTIAL_SECRET is required for http mode: per-user credential stores derive their encryption key from it.'
    )
  })

  it('serves /health, enforces multi-user bearer auth on /mcp, returns 404 on unknown routes, and negotiates 2026-07-28', async () => {
    const usersFile = await makeUsersFile('unit-bearer-secret')
    const handle = await createWorkspaceHttpServer({ port: 0, host: '127.0.0.1', usersFile })

    try {
      const baseUrl = `http://${handle.host}:${handle.port}`

      const healthRes = await fetch(`${baseUrl}/health`)
      expect(healthRes.status).toBe(200)
      expect(await healthRes.json()).toEqual({ status: 'ok', server: 'workspace' })

      const unknownRes = await fetch(`${baseUrl}/unknown`)
      expect(unknownRes.status).toBe(404)
      expect(await unknownRes.json()).toEqual({ error: 'not_found' })

      const unauthRes = await fetch(`${baseUrl}/mcp`, { method: 'POST', body: '{}' })
      expect(unauthRes.status).toBe(401)

      const client = new Client(
        { name: 'http-unit-client', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } }
      )
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { Authorization: 'Bearer unit-bearer-secret' } }
        })
      )
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
      expect(skillsAttachMock).toHaveBeenCalled()
      expect(registerTools).toHaveBeenCalledWith(expect.anything(), { allowLocalFilesystem: false })
      expect(new SkillsClient(client).supported).toBe(false) // skillsAttachMock is a stub in this unit suite
      await client.close()
    } finally {
      await handle.close()
    }
  })

  it('binds PORT, HOST, WORKSPACE_USERS_FILE via startHttp and closes cleanly on SIGINT', async () => {
    const usersFile = await makeUsersFile('sigint-token')
    process.env.CREDENTIAL_SECRET = 'test-credential-secret'
    process.env[USERS_FILE_ENV] = usersFile
    process.env.PORT = '0'
    process.env.HOST = '127.0.0.1'

    const running = startHttp()
    await vi.waitFor(() => {
      const calls = vi.mocked(console.error).mock.calls.flat().join(' ')
      expect(calls).toContain('http mode on http://127.0.0.1:')
    })

    process.emit('SIGINT')
    await running
  })
})
