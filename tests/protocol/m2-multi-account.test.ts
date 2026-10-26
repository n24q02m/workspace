/**
 * M2 protocol E2E -- spawns the real built CLI and drives it over the MCP SDK
 * stdio transport with two accounts seeded. Hermetic: no Google calls. What it
 * proves is the protocol surface of multi-account (config account_*, the account
 * param being advertised and honored, an unknown account named in the error) --
 * not googleapis behavior, which needs real credentials (see Task 9).
 *
 * Seeding works the same way as m1-stdio.test.ts: write the blob through
 * setHomeDirForTesting() in this process, then hand the child the same directory
 * via HOME/USERPROFILE so it resolves the identical on-disk paths. The blob here
 * is the v2 shape with two accounts.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STORE_PLUGIN } from '../../src/constants.js'
import { DOMAINS } from '../../src/tools/domains/index.js'

const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_PATH = resolve(REPO_ROOT, 'bin', 'cli.mjs')
const PERSONAL = 'personal@example.com'
const WORK = 'work@example.com'

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0]
  return first?.type === 'text' ? (first.text ?? '') : ''
}

describe('M2 multi-account protocol E2E', () => {
  let client: Client
  let testHomeDir: string

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`bin/cli.mjs not found at ${CLI_PATH} -- run \`bun run build\` before this test.`)
    }
    testHomeDir = mkdtempSync(join(tmpdir(), 'bws-m2-protocol-test-'))
    setHomeDirForTesting(testHomeDir)
    try {
      await new PerPluginStore(STORE_PLUGIN).save({
        version: 2,
        accounts: {
          [PERSONAL]: {
            access_token: 'fake-personal',
            refresh_token: 'fake-personal-rt',
            expiry_date: Date.now() + 3600_000
          },
          [WORK]: { access_token: 'fake-work', refresh_token: 'fake-work-rt', expiry_date: Date.now() + 3600_000 }
        },
        primary: PERSONAL
      })
    } finally {
      setHomeDirForTesting(null)
    }

    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value
    }
    childEnv.HOME = testHomeDir
    childEnv.USERPROFILE = testHomeDir
    childEnv.GOOGLE_OAUTH_CLIENT_ID = 'dummy-client-id.apps.googleusercontent.com'
    childEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'dummy-client-secret'
    childEnv.NODE_ENV = 'production'
    delete childEnv.BETTER_WORKSPACE_MCP_BOOTSTRAPPED

    client = new Client({ name: 'm2-multi-account-test', version: '0.0.0' }, { capabilities: {} })
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI_PATH], cwd: REPO_ROOT, env: childEnv })
    )
    // 90s như m1-stdio: hook spawn `bin/cli.mjs` thật, đo trên máy rảnh ~25s
    // (chạy riêng: 26.7s), nên ngân sách 30s chỉ còn biên 5s và đỏ theo tải máy
    // chứ không theo code. Xem comment dài hơn ở m1-stdio.test.ts.
  }, 90_000)

  afterAll(async () => {
    await client?.close()
    if (testHomeDir) rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('account_list shows both seeded accounts with the primary marked', async () => {
    const body = JSON.parse(textOf(await client.callTool({ name: 'config', arguments: { action: 'account_list' } })))
    expect(body).toEqual({ accounts: [PERSONAL, WORK], primary: PERSONAL })
  })

  it('every domain tool advertises the account parameter', async () => {
    const { tools } = await client.listTools()
    const domains = tools.filter((t) => !['config', 'help'].includes(t.name))
    // Derived from DOMAINS so a new domain cannot pass by being filtered out
    // here, and so adding one does not fail on an arithmetic mismatch that says
    // nothing about the account parameter this test is actually about.
    expect(domains.map((t) => t.name).sort()).toEqual(DOMAINS.map((d) => d.name).sort())
    for (const tool of domains) {
      expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).toContain('account')
    }
  })

  it('a call naming an unknown account fails with that account named, not a silent primary fallback', async () => {
    const result = await client.callTool({
      name: 'docs',
      arguments: { action: 'getText', account: 'ghost@example.com', documentId: 'doc-1' }
    })
    // No isError to assert on: the vendored services convert a thrown error into a
    // NORMAL result whose text is {"error": "..."} (see DocsService.getText's catch),
    // and that file is byte-identical upstream code. The contract that matters is
    // which credential the call tried to use -- the account is named, and the other
    // account's token never shows up.
    const body = JSON.parse(textOf(result)) as { error?: string }
    expect(body.error).toContain('ghost@example.com')
    expect(body.error).toContain('not configured')
    expect(textOf(result)).not.toContain('fake-personal')
  })

  it('account_set_default switches primary and account_list reflects it', async () => {
    await client.callTool({ name: 'config', arguments: { action: 'account_set_default', account: WORK } })
    const body = JSON.parse(textOf(await client.callTool({ name: 'config', arguments: { action: 'account_list' } })))
    expect(body.primary).toBe(WORK)
    await client.callTool({ name: 'config', arguments: { action: 'account_set_default', account: PERSONAL } })
  })

  it('account_remove drops one account and leaves the other serving', async () => {
    await client.callTool({ name: 'config', arguments: { action: 'account_remove', account: WORK } })
    const body = JSON.parse(textOf(await client.callTool({ name: 'config', arguments: { action: 'account_list' } })))
    expect(body).toEqual({ accounts: [PERSONAL], primary: PERSONAL })
    const status = JSON.parse(textOf(await client.callTool({ name: 'config', arguments: { action: 'status' } })))
    expect(status.configured).toBe(true)
  })

  it('the server is still alive after the account churn', async () => {
    await expect(client.ping()).resolves.toBeDefined()
  })
})
