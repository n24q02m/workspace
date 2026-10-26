/**
 * M1 protocol-level E2E test -- spawns the REAL built CLI (bin/cli.mjs) as a
 * child process and drives it over the REAL MCP SDK stdio transport
 * (@modelcontextprotocol/sdk Client + StdioClientTransport), the same way an
 * actual MCP client does. Real-Google functional behavior (docs round-trip +
 * 6 new-domain read-only calls) was already validated live; this test commits
 * the automated protocol-surface check: tool listing, help docs, config
 * status, and the credential-gate/dispatch machinery -- hermetically, no
 * real Google network calls.
 *
 * Hermetic OAuth: hull's PerPluginStore encrypts tokens with a
 * machine-bound key file (~/.<plugin>/.secret) that lives under
 * getHomeDir(). setHomeDirForTesting() only overrides getHomeDir() in THIS
 * process, so seeding a fake token here would be invisible to the spawned
 * child (a separate OS process) unless both agree on the same home dir. We
 * seed via setHomeDirForTesting() (writes the real .secret + config.json
 * files into a temp dir), then pass that same temp dir to the child via
 * HOME/USERPROFILE env vars -- os.homedir() (the store's fallback once the
 * in-process override is cleared) honors HOME on POSIX and USERPROFILE on
 * Windows, so the child resolves the identical on-disk paths and decrypts
 * the token we already wrote. No browser OAuth, no network.
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

// Same derivation registry.ts uses for TOOLS/HELP_TOPICS -- kept in sync via
// import rather than a hand-duplicated literal list.
const EXPECTED_TOOL_NAMES = [...DOMAINS.map((d) => d.name), 'config', 'help']
const HELP_TOPICS = [...DOMAINS.map((d) => d.name), 'config', 'overview']

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0]
  return first?.type === 'text' ? (first.text ?? '') : ''
}

describe('M1 stdio protocol E2E', () => {
  let client: Client
  let testHomeDir: string

  beforeAll(async () => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`bin/cli.mjs not found at ${CLI_PATH} -- run \`bun run build\` before this test.`)
    }

    testHomeDir = mkdtempSync(join(tmpdir(), 'bws-protocol-test-'))
    setHomeDirForTesting(testHomeDir)
    try {
      // Structurally-valid fake token in the current v2 multi-account blob. A blob without
      // an email would make the server look up the token owner on Google userinfo, a real
      // network call; the seeded email keeps the server 'configured' and the test hermetic.
      await new PerPluginStore(STORE_PLUGIN).save({
        version: 2,
        accounts: {
          'seed@example.com': {
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            expiry_date: Date.now() + 3600_000,
            scope: 'openid email profile',
            token_type: 'Bearer'
          }
        },
        primary: 'seed@example.com'
      })
    } finally {
      setHomeDirForTesting(null) // seeding done; the child gets its own home via env below
    }

    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value
    }
    childEnv.HOME = testHomeDir // POSIX os.homedir()
    childEnv.USERPROFILE = testHomeDir // Windows os.homedir()
    childEnv.GOOGLE_OAUTH_CLIENT_ID = 'dummy-client-id.apps.googleusercontent.com'
    childEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'dummy-client-secret'
    // Must NOT be 'test' -- vitest sets NODE_ENV=test on THIS process, but
    // main.ts's bootstrap() early-returns without starting the server when
    // NODE_ENV==='test' (so unit tests importing main.ts don't self-start).
    // The spawned child needs to actually run.
    childEnv.NODE_ENV = 'production'
    delete childEnv.BETTER_WORKSPACE_MCP_BOOTSTRAPPED // never inherit the parent's bootstrap guard

    client = new Client({ name: 'm1-stdio-protocol-test', version: '0.0.0' }, { capabilities: {} })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH],
      cwd: REPO_ROOT,
      env: childEnv
    })
    await client.connect(transport)
    // 90s, không phải 30s: hook này spawn `bin/cli.mjs` THẬT rồi bắt tay MCP, nên
    // chi phí là tốc độ máy (nạp bundle có googleapis) chứ không phải logic. Đo
    // trên máy rảnh: ~25s. Ngân sách 30s = biên 5s, tức flaky theo CẤU TRÚC chứ
    // không theo may mắn -- nó đỏ khi runner chậm hoặc khi máy đang chạy việc
    // khác, và lần đỏ đó không nói gì về code. 90s cho biên ~3.5x mà vẫn báo lỗi
    // trong thời gian người xem chấp nhận được nếu handshake treo thật.
  }, 90_000)

  afterAll(async () => {
    await client?.close()
    if (testHomeDir) rmSync(testHomeDir, { recursive: true, force: true })
  })

  // Count derived, not written down: every new domain used to make this line
  // fail with an arithmetic complaint ("expected 12, got 13") that says nothing
  // about what broke. The assertion that carries weight is the name comparison
  // below -- it fails with the actual missing or unexpected tool name.
  it('identifies itself as `workspace` in the initialize handshake', () => {
    expect(client.getServerVersion()?.name).toBe('workspace')
  })

  it(`lists exactly the ${EXPECTED_TOOL_NAMES.length} N+2 tools (${DOMAINS.length} domains + config + help)`, async () => {
    const result = await client.listTools()

    expect(result.tools).toHaveLength(EXPECTED_TOOL_NAMES.length)
    expect(result.tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort())
  })

  it.each(HELP_TOPICS)('help(topic="%s") returns non-empty markdown', async (topic) => {
    const result = await client.callTool({ name: 'help', arguments: { topic } })

    expect(result.isError).toBeFalsy()
    expect(textOf(result).length).toBeGreaterThan(0)
  })

  it('help with an invalid topic returns a clean error mentioning valid topics', async () => {
    const result = await client.callTool({ name: 'help', arguments: { topic: 'not-a-real-topic' } })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Invalid topic')
    expect(textOf(result)).toContain('Valid topics')
  })

  it('config(status) reports configured (hermetic fake-token seeding worked) without throwing', async () => {
    const result = await client.callTool({ name: 'config', arguments: { action: 'status' } })

    expect(result.isError).toBeFalsy()
    const body = JSON.parse(textOf(result)) as { state: string; configured: boolean }
    // status also reports the account summary since M2 -- the seeded blob has one.
    expect(body).toEqual({
      state: 'configured',
      configured: true,
      accounts: ['seed@example.com'],
      primary: 'seed@example.com'
    })
  })

  // Every domain, not just docs: this is what proves a newly added DomainDef is
  // actually reachable end to end -- registered, past the credential gate, and
  // dispatched into its factory. The unknown action is what keeps it hermetic;
  // the factory rejects it before any service method (and so any Google call)
  // runs, so the assertion needs no network and no real credentials.
  it.each(DOMAINS.map((d) => d.name))(
    '%s with an unknown action returns a clean error listing valid actions (no crash)',
    async (domain) => {
      const result = await client.callTool({ name: domain, arguments: { action: 'bogus' } })

      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('Unknown action: bogus')
      expect(textOf(result)).toContain('Valid actions')
    }
  )

  it('a hermetic domain call (time, no Google network needed) reaches past the credential gate and returns data', async () => {
    const result = await client.callTool({ name: 'time', arguments: { action: 'getCurrentTime' } })

    expect(result.isError).toBeFalsy()
    expect(textOf(result).length).toBeGreaterThan(0)
    expect(() => JSON.parse(textOf(result))).not.toThrow()
  })

  it('the server process is still alive and responsive after all prior calls (no unhandled crash)', async () => {
    await expect(client.ping()).resolves.toBeDefined()
  })
})
