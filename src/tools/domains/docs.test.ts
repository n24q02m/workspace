import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock() factories are hoisted above regular const declarations, so the
// mocks referenced inside must be created via vi.hoisted() to avoid a
// temporal-dead-zone error.
const { getTextMock, createMock, mockMethods, constructed } = vi.hoisted(() => {
  const getTextMock = vi.fn()
  const createMock = vi.fn()
  // makeDomainRun builds the service ONCE at module load and hands it the
  // AuthManager. Capturing that instance is what lets the account-plumbing
  // tests below drive the real shim instead of asserting against a mock.
  const constructed: { auth?: { getAuthenticatedClient: () => Promise<unknown> } } = {}
  return { getTextMock, createMock, mockMethods: { getText: getTextMock, create: createMock }, constructed }
})

vi.mock('../../vendored/services/DocsService.js', () => ({
  // `new` requires a real function (not an arrow function) as the implementation.
  DocsService: vi.fn().mockImplementation(function DocsServiceMock(auth: {
    getAuthenticatedClient: () => Promise<unknown>
  }) {
    constructed.auth = auth
    return mockMethods
  })
}))

// NOTE: AuthManager is deliberately NOT mocked. Its shim is what reads the
// per-request account out of AsyncLocalStorage, so mocking it away would make
// the account tests below assert against a stub and pass no matter how the
// dispatch is wired. The real shim's constructor only stores `scopes`.

import { FILES_EXTENSION_ID } from '@n24q02m/hull/extensions'
import { runWithAccount } from '../../auth/account-context.js'
import { getAuth } from '../../auth/credential-state.js'
import { runWithMcpContext } from '../helpers/mcp-context.js'
import { DOCS_ACTIONS, docs } from './docs.js'

/** Records the account each getAuthenticatedClient() call resolves to. */
function recordResolvedAccounts(): Array<string | undefined> {
  const seen: Array<string | undefined> = []
  vi.spyOn(getAuth(), 'getAuthenticatedClient').mockImplementation(async (account?: string) => {
    seen.push(account)
    return {} as never
  })
  // The vendored service is what asks for a client mid-call; stand in for it.
  getTextMock.mockImplementation(async () => {
    await constructed.auth?.getAuthenticatedClient()
    return { content: [{ type: 'text', text: 'ok' }] }
  })
  return seen
}

describe('docs mega-tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes the 6 DocsService methods as actions', () => {
    expect(DOCS_ACTIONS).toEqual(['getText', 'create', 'writeText', 'getSuggestions', 'replaceText', 'formatText'])
  })

  it('dispatches to the matching DocsService method and returns its result unchanged', async () => {
    const svcResult = { content: [{ type: 'text', text: 'hello' }] }
    getTextMock.mockResolvedValue(svcResult)

    const result = await docs({ action: 'getText', documentId: 'doc-1' })

    expect(getTextMock).toHaveBeenCalledWith({ documentId: 'doc-1' })
    expect(result).toBe(svcResult)
  })

  it('passes an isError result through unchanged (no re-wrapping)', async () => {
    const svcResult = { content: [{ type: 'text', text: '{"error":"boom"}' }], isError: true }
    getTextMock.mockResolvedValue(svcResult)

    const result = await docs({ action: 'getText', documentId: 'doc-1' })

    expect(result).toBe(svcResult)
  })

  it('does not forward the account param to the service method', async () => {
    getTextMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    await docs({ action: 'getText', documentId: 'doc-1', account: 'someone@example.com' })

    // account selects credentials (see the tests below); it is not a service param.
    expect(getTextMock).toHaveBeenCalledWith({ documentId: 'doc-1' })
  })

  it('forwards all non-action, non-account params to the method', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })

    await docs({ action: 'create', title: 'New Doc', content: 'body text' })

    expect(createMock).toHaveBeenCalledWith({ title: 'New Doc', content: 'body text' })
  })

  it('throws a WorkspaceMCPError listing valid actions for an unknown action', async () => {
    await expect(docs({ action: 'bogus' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Unknown action: bogus',
      suggestion: `Valid actions: ${DOCS_ACTIONS.join(', ')}`
    })
  })

  it('passes the account from the tool input down to credential resolution', async () => {
    const seen = recordResolvedAccounts()

    await docs({ action: 'getText', account: 'work@example.com', documentId: 'doc-1' })

    expect(seen).toEqual(['work@example.com'])
  })

  it('leaves the account unset when the tool input omits it', async () => {
    const seen = recordResolvedAccounts()

    await docs({ action: 'getText', documentId: 'doc-1' })

    expect(seen).toEqual([undefined])
  })

  it('does not leak an account across sibling scopes', async () => {
    const seen = recordResolvedAccounts()

    await runWithAccount('outer@example.com', async () => {
      await docs({ action: 'getText', account: 'inner@example.com', documentId: 'd' })
    })
    await docs({ action: 'getText', documentId: 'd' })

    expect(seen).toEqual(['inner@example.com', undefined])
  })

  it('keeps concurrent calls on their own account', async () => {
    const seen = recordResolvedAccounts()

    await Promise.all([
      docs({ action: 'getText', account: 'a@example.com', documentId: 'd' }),
      docs({ action: 'getText', account: 'b@example.com', documentId: 'd' }),
      docs({ action: 'getText', documentId: 'd' })
    ])

    expect(seen.sort()).toEqual(['a@example.com', 'b@example.com', undefined])
  })

  it('attaches io.modelcontextprotocol/files payload on getText when client supports files extension', async () => {
    const body = JSON.stringify({ title: 'Spec', tabs: [{ title: 'Tab 1', content: 'Hello' }] })
    getTextMock.mockResolvedValueOnce({ content: [{ type: 'text', text: body }] })

    const res = await runWithMcpContext({ clientCapabilities: { extensions: { [FILES_EXTENSION_ID]: {} } } }, () =>
      docs({ action: 'getText', documentId: 'doc-123' })
    )

    expect(res._meta?.[FILES_EXTENSION_ID]).toMatchObject({
      extension: FILES_EXTENSION_ID,
      name: 'doc-123.json',
      mimeType: 'application/json',
      uri: 'workspace://docs-file/doc-123',
      text: body
    })
    expect(res.structuredContent).toMatchObject({ documentId: 'doc-123' })

    // Skips attaching when DocsService returns a JSON error or invalid JSON
    getTextMock.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ error: 'Not found' }) }] })
    const errRes = await runWithMcpContext({ clientCapabilities: { extensions: { [FILES_EXTENSION_ID]: {} } } }, () =>
      docs({ action: 'getText', documentId: 'doc-123' })
    )
    expect(errRes._meta).toBeUndefined()

    getTextMock.mockResolvedValueOnce({ content: [{ type: 'text', text: 'plain single-tab body' }] })
    const plainRes = await runWithMcpContext({ clientCapabilities: { extensions: { [FILES_EXTENSION_ID]: {} } } }, () =>
      docs({ action: 'getText', documentId: 'doc-123' })
    )
    expect(plainRes._meta?.[FILES_EXTENSION_ID]).toMatchObject({
      extension: FILES_EXTENSION_ID,
      name: 'doc-123.txt',
      mimeType: 'text/plain; charset=utf-8',
      uri: 'workspace://docs-file/doc-123',
      text: 'plain single-tab body'
    })
  })
})
