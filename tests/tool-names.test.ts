import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PerPluginStore, setHomeDirForTesting } from '@n24q02m/hull/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STORE_PLUGIN } from '../src/constants.js'

const REPO_ROOT = resolve(__dirname, '..')
const CLI_PATH = resolve(REPO_ROOT, 'bin', 'cli.mjs')
const CLIENT_PREFIX = 'mcp__workspace__'

const EXPECTED_TOOL_NAMES = [
  'calendar',
  'chat',
  'config',
  'docs',
  'drive',
  'forms',
  'gmail',
  'help',
  'people',
  'sheets',
  'slides',
  'tasks',
  'time'
] as const

const RETIRED_TOOL_NAMES: readonly string[] = []

describe('Task 10 live tool-name contract', () => {
  let client: Client
  let testHomeDir: string

  beforeAll(async () => {
    testHomeDir = mkdtempSync(join(tmpdir(), 'bws-tool-names-test-'))
    setHomeDirForTesting(testHomeDir)
    try {
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

    client = new Client({ name: 'task10-tool-name-test', version: '0.0.0' }, { capabilities: {} })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH],
      cwd: REPO_ROOT,
      env: childEnv
    })
    await client.connect(transport)
  }, 90_000)

  afterAll(async () => {
    await client?.close()
    if (testHomeDir) rmSync(testHomeDir, { recursive: true, force: true })
  })

  it('lists exactly the live N+2 names and satisfies R3/R5', async () => {
    const result = await client.listTools()
    const actualNames = result.tools.map((tool) => tool.name).sort()

    expect(actualNames).toEqual([...EXPECTED_TOOL_NAMES].sort())
    expect(actualNames).toHaveLength(13)
    expect(actualNames.filter((name) => RETIRED_TOOL_NAMES.includes(name))).toEqual([])

    for (const name of actualNames) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(name.split('_').length).toBeLessThanOrEqual(2)
      expect(name.length).toBeLessThanOrEqual(20)
      expect(name).not.toMatch(/[A-Z.-]|__|^config__/)
      expect(`${CLIENT_PREFIX}${name}`).toHaveLength(CLIENT_PREFIX.length + name.length)
    }
  })

  it('keeps config and help discoverable as the two non-domain tools', async () => {
    const result = await client.listTools()
    const names = new Set(result.tools.map((tool) => tool.name))

    expect(names.has('config')).toBe(true)
    expect(names.has('help')).toBe(true)
  })
})
