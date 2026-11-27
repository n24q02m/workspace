/**
 * W11 protocol E2E suite verifying MCP 2026-07-28 + Anthropic Nov 2026 features
 * across REAL `@modelcontextprotocol/client` transports (`stdio` and Streamable HTTP):
 *   1. Version negotiation (`2026-07-28` via `server/discover` + legacy `2025-11-25` compat)
 *   2. `io.modelcontextprotocol/skills` (`skills/list`, `skills/get`, `skill://...` read)
 *      coexisting with `workspace://docs/*` resources
 *   3. `elicitWithFallback`: interactive 2026-07-28 MRTR elicitation (with `requestState`
 *      propagation, decline, and confirm) + headless fallback without elicitation capability
 *   4. `io.modelcontextprotocol/files` payload compatibility vs legacy fallback
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { FILES_EXTENSION_ID } from '@n24q02m/hull/extensions'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { hashToken } from '@n24q02m/hull/token-auth'
import { google } from 'googleapis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as credentialState from '../../src/auth/credential-state.js'
import { STORE_PLUGIN } from '../../src/constants.js'
import { registerTools } from '../../src/tools/registry.js'

const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_PATH = resolve(REPO_ROOT, 'bin', 'cli.mjs')
const PERSONAL = 'personal@example.com'
const WORK = 'work@example.com'

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0]
  return first?.type === 'text' ? (first.text ?? '') : ''
}

function buildChildEnv(homeDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.HOME = homeDir
  env.USERPROFILE = homeDir
  env.GOOGLE_OAUTH_CLIENT_ID = 'dummy-client-id.apps.googleusercontent.com'
  env.GOOGLE_OAUTH_CLIENT_SECRET = 'dummy-client-secret'
  env.NODE_ENV = 'production'
  delete env.BETTER_WORKSPACE_MCP_BOOTSTRAPPED
  return { ...env, ...extra }
}

async function seedTwoAccounts(homeDir: string): Promise<void> {
  setHomeDirForTesting(homeDir)
  try {
    await new PerPluginStore(STORE_PLUGIN).save({
      version: 2,
      accounts: {
        [PERSONAL]: {
          access_token: 'fake-personal',
          refresh_token: 'fake-personal-rt',
          expiry_date: Date.now() + 3600_000
        },
        [WORK]: {
          access_token: 'fake-work',
          refresh_token: 'fake-work-rt',
          expiry_date: Date.now() + 3600_000
        }
      },
      primary: PERSONAL
    })
  } finally {
    setHomeDirForTesting(null)
  }
}

describe('W11 MCP 2026-07-28 E2E — stdio transport', () => {
  let client: Client
  let testHomeDir: string
  const capturedMessages: string[] = []
  let confirmAction: 'accept-true' | 'decline' = 'accept-true'

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`bin/cli.mjs not found at ${CLI_PATH} -- run \`bun run build\` first.`)
    }
    testHomeDir = mkdtempSync(join(tmpdir(), 'bws-w11-stdio-'))
    await seedTwoAccounts(testHomeDir)

    client = new Client(
      { name: 'w11-stdio-e2e', version: '1.0.0' },
      {
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: 60_000 } },
        capabilities: {
          elicitation: { form: {} },
          extensions: { [FILES_EXTENSION_ID]: {} }
        }
      }
    )

    client.setRequestHandler(
      'elicitation/create',
      async (
        request
      ): Promise<{
        action: 'accept' | 'decline' | 'cancel'
        content?: Record<string, string | number | boolean | string[]>
      }> => {
        const params = request.params as {
          message: string
          requestedSchema?: { properties?: Record<string, unknown> }
        }
        capturedMessages.push(params.message)
        if (params.requestedSchema?.properties?.account) {
          return { action: 'accept', content: { account: WORK } }
        }
        if (confirmAction === 'decline') {
          return { action: 'decline' }
        }
        return { action: 'accept', content: { confirmed: true } }
      }
    )

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH],
      cwd: REPO_ROOT,
      env: buildChildEnv(testHomeDir)
    })
    await client.connect(transport, { timeout: 60_000 })
  }, 150_000)

  afterAll(async () => {
    await client?.close()
    if (testHomeDir) rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('negotiates MCP 2026-07-28 over stdio', () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
  })

  it('serves skills/list and skill:// manifests alongside workspace://docs/*', async () => {
    const skillsClient = new SkillsClient(client)
    expect(skillsClient.supported).toBe(true)

    const listing = await skillsClient.list()
    const names = listing.skills.map((s) => s.frontmatter.name)
    expect(names).toEqual(expect.arrayContaining(['calendar-agenda', 'drive-audit']))

    const agenda = await skillsClient.get('skill://calendar-agenda/SKILL.md')
    const agendaFile = await skillsClient.read(agenda.skill)
    expect(agendaFile.verified).toBe(true)
    expect(agendaFile.text).toContain('calendar-agenda')

    const audit = await skillsClient.get('skill://drive-audit/SKILL.md')
    const auditFile = await skillsClient.read(audit.skill)
    expect(auditFile.verified).toBe(true)
    expect(auditFile.text).toContain('drive-audit')

    const docRes = await client.readResource({ uri: 'workspace://docs/calendar' })
    expect(docRes.contents[0]).toMatchObject({ uri: 'workspace://docs/calendar', mimeType: 'text/markdown' })
  }, 30_000)

  it('runs 2-round MRTR elicitation (account selection -> carried requestState confirmation) and honors decline', async () => {
    capturedMessages.length = 0
    confirmAction = 'decline'

    const res = await client.callTool({
      name: 'gmail',
      arguments: { action: 'send', to: 'alice@example.com', subject: 'Quarterly Update', body: 'Hello' }
    })

    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('declined by user')
    expect(capturedMessages).toHaveLength(2)
    expect(capturedMessages[0]).toContain('Select which account to use for gmail.send')
    expect(capturedMessages[1]).toContain(`account=${WORK}`)
    expect(capturedMessages[1]).toContain('to=alice@example.com')
  }, 30_000)

  it('elicits confirmation on config.account_remove: decline keeps account, accept removes it', async () => {
    confirmAction = 'decline'
    const declined = await client.callTool({
      name: 'config',
      arguments: { action: 'account_remove', account: WORK }
    })
    expect(declined.isError).toBe(true)
    expect(textOf(declined)).toContain('declined by user')

    const beforeRemove = JSON.parse(
      textOf(await client.callTool({ name: 'config', arguments: { action: 'account_list' } }))
    )
    expect(beforeRemove.accounts).toEqual([PERSONAL, WORK])

    confirmAction = 'accept-true'
    const accepted = await client.callTool({
      name: 'config',
      arguments: { action: 'account_remove', account: WORK }
    })
    expect(accepted.isError).toBeFalsy()

    const afterRemove = JSON.parse(
      textOf(await client.callTool({ name: 'config', arguments: { action: 'account_list' } }))
    )
    expect(afterRemove.accounts).toEqual([PERSONAL])
  }, 30_000)
})

describe('W11 MCP 2026-07-28 E2E — Streamable HTTP transport', () => {
  let httpHomeDir: string
  let usersFile: string
  let child: ChildProcess
  let mcpUrl: string
  const bearerToken = 'w11-http-e2e-token'
  let httpClient: Client
  let headlessClient: Client
  let httpConfirmAction: 'accept-true' | 'decline' = 'decline'

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`bin/cli.mjs not found at ${CLI_PATH} -- run \`bun run build\` first.`)
    }
    httpHomeDir = mkdtempSync(join(tmpdir(), 'bws-w11-http-'))
    usersFile = join(httpHomeDir, 'users.toml')
    const tokenHash = await hashToken(bearerToken)
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

    const env = buildChildEnv(httpHomeDir, {
      HOST: '127.0.0.1',
      PORT: '0',
      CREDENTIAL_SECRET: 'w11-http-credential-secret',
      WORKSPACE_USERS_FILE: usersFile
    })

    child = spawn(process.execPath, [CLI_PATH, '--http'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    mcpUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
      const timer = setTimeout(() => rejectUrl(new Error('Timed out waiting for HTTP server port')), 60_000)
      let stderrBuf = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8')
        const match = /http mode on (http:\/\/[^\s]+\/mcp)/.exec(stderrBuf)
        if (match?.[1]) {
          clearTimeout(timer)
          resolveUrl(match[1])
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        rejectUrl(new Error(`HTTP child exited early (${String(code)}): ${stderrBuf}`))
      })
    })

    httpClient = new Client(
      { name: 'w11-http-interactive', version: '1.0.0' },
      {
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: 30_000 } },
        capabilities: {
          elicitation: { form: {} },
          extensions: { [FILES_EXTENSION_ID]: {} }
        }
      }
    )
    httpClient.setRequestHandler('elicitation/create', async () =>
      httpConfirmAction === 'decline' ? { action: 'decline' } : { action: 'accept', content: { confirmed: true } }
    )
    await httpClient.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } }
      })
    )

    headlessClient = new Client({ name: 'w11-http-headless', version: '1.0.0' }, { capabilities: {} })
    await headlessClient.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } }
      })
    )
  }, 90_000)

  afterAll(async () => {
    await httpClient?.close().catch(() => undefined)
    await headlessClient?.close().catch(() => undefined)
    if (child && !child.killed) {
      child.kill('SIGTERM')
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          done()
        }, 3_000)
        child.once('exit', () => {
          clearTimeout(timer)
          done()
        })
      })
    }
    if (httpHomeDir) rmSync(httpHomeDir, { recursive: true, force: true })
  })

  it('negotiates 2026-07-28 and serves skills + doc resources over Streamable HTTP', async () => {
    expect(httpClient.getNegotiatedProtocolVersion()).toBe('2026-07-28')

    const skillsClient = new SkillsClient(httpClient)
    expect(skillsClient.supported).toBe(true)
    const { skills } = await skillsClient.list()
    expect(skills.map((s) => s.frontmatter.name)).toEqual(expect.arrayContaining(['calendar-agenda', 'drive-audit']))

    const entry = await skillsClient.get('skill://drive-audit/SKILL.md')
    const file = await skillsClient.read(entry.skill)
    expect(file.verified).toBe(true)
    expect(file.text).toContain('drive-audit')

    const docRes = await httpClient.readResource({ uri: 'workspace://docs/drive' })
    expect(docRes.contents[0]).toMatchObject({ uri: 'workspace://docs/drive', mimeType: 'text/markdown' })
  }, 20_000)

  it('supports interactive elicitation AND headless fallback on Streamable HTTP, while enforcing allowLocalFilesystem=false', async () => {
    httpConfirmAction = 'decline'
    const declined = await httpClient.callTool({ name: 'config', arguments: { action: 'setup_reset' } })
    expect(declined.isError).toBe(true)
    expect(textOf(declined)).toContain('declined by user')

    httpConfirmAction = 'accept-true'
    const accepted = await httpClient.callTool({ name: 'config', arguments: { action: 'setup_reset' } })
    expect(accepted.isError).toBeFalsy()

    // Legacy / headless client without elicitation falls back to defaultValue cleanly
    expect(headlessClient.getNegotiatedProtocolVersion()).toBe('2025-11-25')
    const headlessReset = await headlessClient.callTool({ name: 'config', arguments: { action: 'setup_reset' } })
    expect(headlessReset.isError).toBeFalsy()

    // Remote HTTP transport blocks server-local filesystem parameters
    const localBlocked = await httpClient.callTool({
      name: 'gmail',
      arguments: { action: 'downloadAttachment', messageId: 'm1', attachmentId: 'a1', localPath: '/tmp/secret' }
    })
    expect(localBlocked.isError).toBe(true)
  }, 20_000)
})

describe('W11 io.modelcontextprotocol/files payload compatibility E2E', () => {
  it('emits FilePayload only to clients declaring io.modelcontextprotocol/files and falls back cleanly for legacy clients', async () => {
    vi.spyOn(credentialState, 'getState').mockReturnValue('configured')
    vi.spyOn(credentialState, 'getAuth').mockReturnValue({
      listAccounts: async () => ({ accounts: [PERSONAL], primary: PERSONAL }),
      getAuthenticatedClient: async () => ({}) as never
    } as never)
    vi.spyOn(google, 'docs').mockReturnValue({
      documents: {
        get: async () => ({
          data: {
            title: 'W11 Spec',
            tabs: [
              {
                tabProperties: { tabId: 't1', title: 'Main' },
                documentTab: {
                  body: {
                    content: [{ paragraph: { elements: [{ textRun: { content: 'Hello W11 Files' } }] } }]
                  }
                }
              }
            ]
          }
        })
      }
    } as never)

    const mcpHandler = createMcpHandler(() => {
      const s = new McpServer({ name: 'files-test', version: '1.0.0' }, { capabilities: { resources: {} } })
      registerTools(s)
      return s
    })
    const nodeHandler = toNodeHandler(mcpHandler)
    const httpServer = createServer((req, res) => {
      void nodeHandler(req, res)
    })
    await new Promise<void>((resolveListen) => {
      httpServer.listen(0, '127.0.0.1', resolveListen)
    })
    const addr = httpServer.address() as { port: number }
    const url = new URL(`http://127.0.0.1:${addr.port}/mcp`)

    try {
      const modernClient = new Client(
        { name: 'files-capable', version: '1.0.0' },
        {
          versionNegotiation: { mode: 'auto' },
          capabilities: { extensions: { [FILES_EXTENSION_ID]: {} } }
        }
      )
      await modernClient.connect(new StreamableHTTPClientTransport(url))
      const modernRes = await modernClient.callTool({
        name: 'docs',
        arguments: { action: 'getText', documentId: 'doc-w11' }
      })
      expect(modernClient.getNegotiatedProtocolVersion()).toBe('2026-07-28')
      expect(modernRes._meta?.[FILES_EXTENSION_ID]).toMatchObject({
        extension: FILES_EXTENSION_ID,
        name: 'doc-w11.txt',
        mimeType: 'text/plain; charset=utf-8',
        uri: 'workspace://docs-file/doc-w11'
      })
      expect(modernRes.structuredContent).toMatchObject({ documentId: 'doc-w11' })
      expect(textOf(modernRes)).toContain('Hello W11 Files')
      await modernClient.close()

      const legacyClient = new Client({ name: 'legacy-client', version: '1.0.0' }, { capabilities: {} })
      await legacyClient.connect(new StreamableHTTPClientTransport(url))
      const legacyRes = await legacyClient.callTool({
        name: 'docs',
        arguments: { action: 'getText', documentId: 'doc-w11' }
      })
      expect(legacyClient.getNegotiatedProtocolVersion()).toBe('2025-11-25')
      expect(legacyRes._meta?.[FILES_EXTENSION_ID]).toBeUndefined()
      expect(legacyRes.structuredContent).toBeUndefined()
      expect(textOf(legacyRes)).toContain('Hello W11 Files')
      await legacyClient.close()
    } finally {
      await mcpHandler.close().catch(() => undefined)
      await new Promise<void>((done) => {
        httpServer.close(() => done())
      })
      vi.restoreAllMocks()
    }
  }, 20_000)
})
