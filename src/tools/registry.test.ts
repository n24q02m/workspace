import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ConfigModule from './config.js'

vi.mock('./domains/docs.js', () => ({
  docs: vi.fn(),
  DOCS_ACTIONS: ['getText', 'create', 'writeText', 'getSuggestions', 'replaceText', 'formatText']
}))

vi.mock('./domains/drive.js', () => ({
  drive: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'downloaded' }] })),
  DRIVE_ACTIONS: [
    'findFolder',
    'createFolder',
    'search',
    'trashFile',
    'renameFile',
    'getComments',
    'moveFile',
    'downloadFile'
  ]
}))

// Gmail and Slides keep their real action lists; only the dispatch target is
// replaced, so a test can tell whether a call reached the vendored service.
vi.mock('./domains/gmail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./domains/gmail.js')>()),
  gmail: vi.fn()
}))

vi.mock('./domains/slides.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./domains/slides.js')>()),
  slides: vi.fn()
}))

// `config` is stubbed (no credential store in tests), but CONFIG_ACTIONS comes
// from the real module: it is the list registry.ts builds the schema enum from,
// and a hand copy here would stop catching drift between the two.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('./config.js')
  return { ...actual, config: vi.fn() }
})

vi.mock('../auth/credential-state.js', () => ({
  getState: vi.fn(() => 'configured'),
  resolveCredentialState: vi.fn(async () => 'awaiting_setup')
}))

// Mock node:path to allow simulating path traversal by controlling relative()
const { mockJoin, mockRelative, mockIsAbsolute } = vi.hoisted(() => ({
  mockJoin: vi.fn((...args: string[]) => args.filter(Boolean).join('/')),
  mockRelative: vi.fn((_from: string, to: string) => to.split('/').pop() || ''),
  mockIsAbsolute: vi.fn(() => false)
}))

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...actual, join: mockJoin, relative: mockRelative, isAbsolute: mockIsAbsolute }
})

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('# Mock documentation content')
}))

import { readFile } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { localAuthContext, runWithAuthContext } from '@n24q02m/hull/token-auth'
import { getState } from '../auth/credential-state.js'
import { config } from './config.js'
import { docs } from './domains/docs.js'
import { drive } from './domains/drive.js'
import { gmail } from './domains/gmail.js'
import { DOMAINS } from './domains/index.js'
import { slides } from './domains/slides.js'
import { WorkspaceMCPError } from './helpers/errors.js'
import { registerTools } from './registry.js'

// Derived from the single DOMAINS source of truth: registry builds TOOLS as
// [...DOMAINS, config, help], so adding a domain needs no test edit here.
const EXPECTED_TOOL_NAMES = [...DOMAINS.map((d) => d.name), 'config', 'help']

function createServer() {
  return new Server({ name: 'test-server', version: '0.0.0' }, { capabilities: { tools: {}, resources: {} } })
}

// registerTools stores handlers in the SDK's private _requestHandlers map,
// keyed by JSON-RPC method (e.g. 'tools/list'). There is no public accessor,
// so tests reach in directly -- same trick notion's mock-server test double
// uses, just against a real Server instance for schema-parsing coverage.
function getHandler(server: Server, method: string) {
  return (
    server as unknown as { _requestHandlers: Map<string, (request: unknown) => Promise<any>> }
  )._requestHandlers.get(method)!
}

describe('registerTools', () => {
  let server: Server

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getState).mockReturnValue('configured')
    server = createServer()
    registerTools(server)
  })

  describe('ListTools handler', () => {
    it('returns exactly the DOMAINS-derived domain tools + config + help', async () => {
      const handler = getHandler(server, 'tools/list')
      const result = await handler({ method: 'tools/list' })

      expect(result.tools.map((t: any) => t.name)).toEqual(EXPECTED_TOOL_NAMES)
    })

    it('gives every tool a name, description, and object inputSchema with a required field', async () => {
      const handler = getHandler(server, 'tools/list')
      const result = await handler({ method: 'tools/list' })

      for (const tool of result.tools) {
        expect(typeof tool.name).toBe('string')
        expect(typeof tool.description).toBe('string')
        expect(tool.inputSchema.type).toBe('object')
        // domain tools + config require 'action'; help requires 'topic'
        const req = tool.name === 'help' ? 'topic' : 'action'
        expect(tool.inputSchema.required).toContain(req)
      }
    })

    it('lists all 6 DocsService methods in the docs action enum', async () => {
      const handler = getHandler(server, 'tools/list')
      const result = await handler({ method: 'tools/list' })
      const docsTool = result.tools.find((t: any) => t.name === 'docs')

      expect(docsTool.inputSchema.properties.action.enum).toEqual([
        'getText',
        'create',
        'writeText',
        'getSuggestions',
        'replaceText',
        'formatText'
      ])
    })
    it('advertises bounded pagination and payload controls for list/read operations', async () => {
      const handler = getHandler(server, 'tools/list')
      const result = await handler({ method: 'tools/list' })
      const tools = result.tools as Array<{
        name: string
        inputSchema: { properties: Record<string, unknown> }
      }>
      const byName: Record<string, (typeof tools)[number]> = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

      expect(byName.drive.inputSchema.properties).toMatchObject({
        pageSize: { type: 'integer' },
        pageToken: { type: 'string' }
      })
      expect(byName.gmail.inputSchema.properties).toMatchObject({
        maxResults: { type: 'integer' },
        pageToken: { type: 'string' },
        format: { enum: ['minimal', 'full', 'raw', 'metadata'] }
      })
      expect(byName.chat.inputSchema.properties).toMatchObject({
        pageSize: { type: 'integer' },
        pageToken: { type: 'string' }
      })
      expect(byName.tasks.inputSchema.properties).toMatchObject({
        maxResults: { type: 'integer' },
        pageToken: { type: 'string' }
      })
      expect(byName.docs.inputSchema.properties).toMatchObject({
        limit: { type: 'integer' },
        preview: { type: 'boolean' }
      })
    })

    // The factory clamps every paged listing to 1-100 and fills in 20 when the
    // page size is left out (normalizePageSize), whatever default the vendored
    // service declares, and rejects a value that is not an integer.
    it.each([
      ['drive', 'pageSize'],
      ['gmail', 'maxResults'],
      ['chat', 'pageSize'],
      ['tasks', 'maxResults'],
      ['calendar', 'maxResults'],
      ['forms', 'pageSize']
    ])('advertises the %s %s bounds the factory enforces', async (name, field) => {
      const result = await getHandler(server, 'tools/list')({ method: 'tools/list' })
      const tool = result.tools.find((candidate: any) => candidate.name === name)

      expect(tool.inputSchema.properties[field]).toMatchObject({
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: expect.stringContaining('default 20')
      })
    })

    it('advertises max_chars as the integer range resolveResponseBudget accepts', async () => {
      const result = await getHandler(server, 'tools/list')({ method: 'tools/list' })
      const withBudget = result.tools.filter((tool: any) => tool.inputSchema.properties.max_chars)

      expect(withBudget.length).toBe(DOMAINS.length - 1)
      for (const tool of withBudget) {
        expect(tool.inputSchema.properties.max_chars, tool.name).toMatchObject({
          type: 'integer',
          minimum: 1,
          maximum: 100000
        })
      }
    })

    it('advertises Gmail recipients as one address or an array of addresses', async () => {
      const result = await getHandler(server, 'tools/list')({ method: 'tools/list' })
      const gmailTool = result.tools.find((tool: any) => tool.name === 'gmail')

      for (const field of ['to', 'cc', 'bcc']) {
        expect(gmailTool.inputSchema.properties[field], field).toMatchObject({
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
        })
      }
    })

    it('advertises the formatText styles DocsService applies', async () => {
      const result = await getHandler(server, 'tools/list')({ method: 'tools/list' })
      const docsTool = result.tools.find((tool: any) => tool.name === 'docs')

      expect(docsTool.inputSchema.properties.formats.items.properties.style.enum).toEqual([
        'heading1',
        'heading2',
        'heading3',
        'heading4',
        'heading5',
        'heading6',
        'normalText',
        'bold',
        'italic',
        'underline',
        'strikethrough',
        'code',
        'link'
      ])
    })

    // The action enum and the properties drop local-only entries for a remote
    // client; the description must not name them either, or a model reads about
    // an action it cannot call.
    it('names no local-only action or parameter in a remote tool description', async () => {
      const remoteServer = createServer()
      registerTools(remoteServer, { allowLocalFilesystem: false })

      const result = await getHandler(remoteServer, 'tools/list')({ method: 'tools/list' })
      const byName = Object.fromEntries(result.tools.map((tool: any) => [tool.name, tool]))

      const checked = DOMAINS.filter((domain) => domain.localOnlyActions || domain.localOnlyInputProps)
      expect(checked.map((domain) => domain.name).sort()).toEqual(['drive', 'gmail', 'slides'])
      for (const domain of checked) {
        for (const word of [...(domain.localOnlyActions ?? []), ...(domain.localOnlyInputProps ?? [])]) {
          expect(byName[domain.name].description, `${domain.name} names ${word}`).not.toContain(word)
        }
      }
    })

    it('describes the local-only actions to local stdio clients', async () => {
      const result = await getHandler(server, 'tools/list')({ method: 'tools/list' })
      const byName = Object.fromEntries(result.tools.map((tool: any) => [tool.name, tool]))

      expect(byName.gmail.description).toContain('downloadAttachment')
      expect(byName.slides.description).toContain('getImages')
      expect(byName.slides.description).toContain('getSlideThumbnail')
    })

    it('does not advertise Drive filesystem writes to remote clients', async () => {
      const remoteServer = createServer()
      registerTools(remoteServer, { allowLocalFilesystem: false })

      const result = await getHandler(remoteServer, 'tools/list')({ method: 'tools/list' })
      const driveTool = result.tools.find((tool: any) => tool.name === 'drive')

      expect(driveTool.inputSchema.properties.action.enum).not.toContain('downloadFile')
    })

    it('does not advertise Gmail or Slides filesystem writes to remote clients', async () => {
      const remoteServer = createServer()
      registerTools(remoteServer, { allowLocalFilesystem: false })

      const result = await getHandler(remoteServer, 'tools/list')({ method: 'tools/list' })
      const byName = Object.fromEntries(result.tools.map((tool: any) => [tool.name, tool]))

      expect(byName.gmail.inputSchema.properties.action.enum).not.toContain('downloadAttachment')
      expect(byName.slides.inputSchema.properties.action.enum).not.toContain('getImages')
      expect(byName.slides.inputSchema.properties.action.enum).not.toContain('getSlideThumbnail')
      expect(byName.gmail.inputSchema.properties).not.toHaveProperty('localPath')
      expect(byName.gmail.inputSchema.properties).not.toHaveProperty('attachments')
      expect(byName.slides.inputSchema.properties).not.toHaveProperty('localPath')
    })

    it('advertises Gmail draft attachments to local stdio clients', async () => {
      const result = await getHandler(server, 'tools/list')({ method: 'tools/list' })
      const gmailTool = result.tools.find((tool: any) => tool.name === 'gmail')

      expect(gmailTool.inputSchema.properties.attachments).toMatchObject({
        type: 'array',
        items: { type: 'object', required: ['filePath'] }
      })
    })

    it('advertises the calendar time window in the format listEvents and findFreeTime accept', async () => {
      const result = await getHandler(server, 'tools/list')({ method: 'tools/list' })
      const calendarTool = result.tools.find((tool: any) => tool.name === 'calendar')

      for (const field of ['timeMin', 'timeMax']) {
        expect(calendarTool.inputSchema.properties[field]).toMatchObject({
          type: 'string',
          description: expect.stringContaining('2026-03-01T09:00:00Z')
        })
      }
    })
  })

  describe('ListResources / ReadResource handlers', () => {
    it('lists a markdown doc resource for every domain', async () => {
      const handler = getHandler(server, 'resources/list')
      const result = await handler({ method: 'resources/list' })

      const uris = result.resources.map((r: any) => r.uri)
      for (const d of DOMAINS) expect(uris).toContain(`workspace://docs/${d.name}`)
      for (const resource of result.resources) {
        expect(resource.mimeType).toBe('text/markdown')
      }
    })

    it('reads doc content for a valid uri', async () => {
      const handler = getHandler(server, 'resources/read')
      const result = await handler({ method: 'resources/read', params: { uri: 'workspace://docs/docs' } })

      expect(result.contents[0]).toEqual({
        uri: 'workspace://docs/docs',
        mimeType: 'text/markdown',
        text: '# Mock documentation content'
      })
      expect(readFile).toHaveBeenCalledWith(expect.stringContaining('docs.md'), 'utf-8')
    })

    it('throws for an unknown uri', async () => {
      const handler = getHandler(server, 'resources/read')

      await expect(
        handler({ method: 'resources/read', params: { uri: 'workspace://docs/bogus' } })
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' })
    })

    it('blocks path traversal in the resource uri', async () => {
      const handler = getHandler(server, 'resources/read')
      vi.mocked(relative).mockReturnValueOnce(['..', '..', 'etc', 'passwd'].join(sep))

      await expect(
        handler({ method: 'resources/read', params: { uri: 'workspace://docs/docs' } })
      ).rejects.toMatchObject({ code: 'SECURITY_ERROR' })
    })

    it('throws DOC_NOT_FOUND when the file is missing', async () => {
      const handler = getHandler(server, 'resources/read')
      vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))

      await expect(
        handler({ method: 'resources/read', params: { uri: 'workspace://docs/docs' } })
      ).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' })
    })
  })

  describe('CallTool handler', () => {
    it('errors when no arguments are provided', async () => {
      const handler = getHandler(server, 'tools/call')
      const result = await handler({ method: 'tools/call', params: { name: 'docs', arguments: undefined } })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: No arguments provided' }],
        isError: true
      })
    })

    it('blocks the docs tool when the Google account is not configured', async () => {
      vi.mocked(getState).mockReturnValue('awaiting_setup')
      const handler = getHandler(server, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name: 'docs', arguments: { action: 'getText', documentId: 'd' } }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Google account not configured')
      expect(docs).not.toHaveBeenCalled()
    })

    it('points an HTTP caller blocked by the credential guard at its own namespace', async () => {
      vi.mocked(getState).mockReturnValue('awaiting_setup')
      const handler = getHandler(server, 'tools/call')

      const result = await runWithAuthContext(
        { ...localAuthContext(), uid: 'sub-bob', namespace: 'sub-bob', mode: 'multi' },
        () =>
          handler({ method: 'tools/call', params: { name: 'docs', arguments: { action: 'getText', documentId: 'd' } } })
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Run `workspace auth --user sub-bob` on the host')
    })

    it('allows config and help through the credential guard when not configured', async () => {
      vi.mocked(getState).mockReturnValue('awaiting_setup')
      vi.mocked(config).mockResolvedValue({ content: [{ type: 'text' as const, text: 'ok' }] })
      const handler = getHandler(server, 'tools/call')

      const configResult = await handler({
        method: 'tools/call',
        params: { name: 'config', arguments: { action: 'status' } }
      })
      const helpResult = await handler({ method: 'tools/call', params: { name: 'help', arguments: { topic: 'docs' } } })

      expect(configResult.isError).toBeUndefined()
      expect(helpResult.isError).toBeUndefined()
    })

    it('dispatches to docs and returns its result directly (no re-wrapping)', async () => {
      const mockResult = { content: [{ type: 'text' as const, text: 'doc text' }] }
      vi.mocked(docs).mockResolvedValue(mockResult)
      const handler = getHandler(server, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name: 'docs', arguments: { action: 'getText', documentId: 'd' } }
      })

      expect(docs).toHaveBeenCalledWith({ action: 'getText', documentId: 'd' })
      expect(result).toEqual(mockResult)
    })

    it('preserves factory unknown-action validation for local stdio calls', async () => {
      const handler = getHandler(server, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name: 'time', arguments: { action: 'bogus' } }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown action: bogus')
      expect(result.content[0].text).toContain('Valid actions')
    })

    it('rejects a raw remote downloadFile request before it reaches DriveService', async () => {
      const remoteServer = createServer()
      registerTools(remoteServer, { allowLocalFilesystem: false })
      const handler = getHandler(remoteServer, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: {
          name: 'drive',
          arguments: { action: 'downloadFile', fileId: 'file-id', localPath: '../../outside.txt' }
        }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('downloadFile is only available in local stdio mode')
      expect(drive).not.toHaveBeenCalled()
    })

    it.each([
      ['gmail', 'downloadAttachment', { messageId: 'm-1', attachmentId: 'a-1', localPath: '/srv/out.bin' }],
      ['slides', 'getImages', { presentationId: 'p-1', localPath: '/srv/images' }],
      ['slides', 'getSlideThumbnail', { presentationId: 'p-1', slideObjectId: 's-1', localPath: '/srv/thumb.png' }]
    ])('rejects a raw remote %s %s request before it reaches the service', async (name, action, args) => {
      const remoteServer = createServer()
      registerTools(remoteServer, { allowLocalFilesystem: false })
      const handler = getHandler(remoteServer, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name, arguments: { action, ...args } }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain(`Action not available in this transport: ${action}`)
      expect(gmail).not.toHaveBeenCalled()
      expect(slides).not.toHaveBeenCalled()
    })

    // createDraft reads each attachments[].filePath from the server's disk and
    // mails it into the caller's draft, so over HTTP it would hand a remote
    // client any file the server process can read.
    it('rejects a raw remote gmail createDraft that attaches server files', async () => {
      const remoteServer = createServer()
      registerTools(remoteServer, { allowLocalFilesystem: false })
      const handler = getHandler(remoteServer, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: {
          name: 'gmail',
          arguments: {
            action: 'createDraft',
            to: 'someone@example.com',
            subject: 's',
            body: 'b',
            attachments: [{ filePath: '/etc/passwd' }]
          }
        }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Parameter not available in this transport: attachments')
      expect(gmail).not.toHaveBeenCalled()
    })

    it('still sends a remote gmail createDraft without attachments to the service', async () => {
      vi.mocked(gmail).mockResolvedValue({ content: [{ type: 'text' as const, text: 'draft created' }] })
      const remoteServer = createServer()
      registerTools(remoteServer, { allowLocalFilesystem: false })
      const handler = getHandler(remoteServer, 'tools/call')

      const args = { action: 'createDraft', to: 'someone@example.com', subject: 's', body: 'b' }
      const result = await handler({ method: 'tools/call', params: { name: 'gmail', arguments: args } })

      expect(result.isError).toBeFalsy()
      expect(gmail).toHaveBeenCalledWith(args)
    })

    it('dispatches to config and returns its result directly (no re-wrapping)', async () => {
      const mockResult = {
        content: [{ type: 'text' as const, text: JSON.stringify({ state: 'configured', configured: true }) }]
      }
      vi.mocked(config).mockResolvedValue(mockResult)
      const handler = getHandler(server, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name: 'config', arguments: { action: 'status' } }
      })

      expect(config).toHaveBeenCalledWith({ action: 'status' })
      expect(result).toEqual(mockResult)
    })

    it('reads the matching doc file for a valid help topic', async () => {
      vi.mocked(readFile).mockResolvedValueOnce('# Docs Documentation')
      const handler = getHandler(server, 'tools/call')

      const result = await handler({ method: 'tools/call', params: { name: 'help', arguments: { topic: 'docs' } } })

      expect(readFile).toHaveBeenCalledWith(expect.stringContaining('docs.md'), 'utf-8')
      expect(result.content[0].text).toBe('# Docs Documentation')
      expect(result.isError).toBeUndefined()
    })

    it('errors for an invalid help topic', async () => {
      const handler = getHandler(server, 'tools/call')

      const result = await handler({ method: 'tools/call', params: { name: 'help', arguments: { topic: 'bogus' } } })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Invalid topic: bogus')
      expect(result.content[0].text).toContain('Valid topics:')
    })

    it('errors for a help call without a topic, before reading any doc file', async () => {
      const handler = getHandler(server, 'tools/call')

      const result = await handler({ method: 'tools/call', params: { name: 'help', arguments: {} } })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error: help requires a topic')
      expect(result.content[0].text).toContain('Valid topics:')
      expect(readFile).not.toHaveBeenCalled()
    })

    it('errors when the help doc file is missing', async () => {
      vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
      const handler = getHandler(server, 'tools/call')

      const result = await handler({ method: 'tools/call', params: { name: 'help', arguments: { topic: 'overview' } } })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Documentation not found for: overview')
    })

    it('blocks path traversal in the help topic even if the allowlist is bypassed downstream', async () => {
      vi.mocked(relative).mockReturnValueOnce(['..', '..', 'etc', 'passwd'].join(sep))
      const handler = getHandler(server, 'tools/call')

      const result = await handler({ method: 'tools/call', params: { name: 'help', arguments: { topic: 'docs' } } })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Path traversal attempt detected')
    })

    it('errors for an unknown tool with a close-match suggestion', async () => {
      const handler = getHandler(server, 'tools/call')

      const result = await handler({ method: 'tools/call', params: { name: 'doc', arguments: { action: 'getText' } } })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown tool: doc')
      expect(result.content[0].text).toContain("Did you mean 'docs'?")
    })

    it('errors for an unknown tool with no close match (no suggestion appended)', async () => {
      const handler = getHandler(server, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name: 'zzzzzzzzz', arguments: { action: 'getText' } }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown tool: zzzzzzzzz.')
      expect(result.content[0].text).not.toContain('Did you mean')
    })

    it('wraps a WorkspaceMCPError thrown by a domain tool into an isError response', async () => {
      vi.mocked(docs).mockRejectedValue(new WorkspaceMCPError('Document not found', 'NOT_FOUND', 'Check the ID'))
      const handler = getHandler(server, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name: 'docs', arguments: { action: 'getText', documentId: 'bad' } }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error: Document not found')
      expect(result.content[0].text).toContain('Suggestion: Check the ID')
    })

    it('wraps a generic thrown error with TOOL_ERROR', async () => {
      vi.mocked(config).mockRejectedValue(new Error('boom'))
      const handler = getHandler(server, 'tools/call')

      const result = await handler({
        method: 'tools/call',
        params: { name: 'config', arguments: { action: 'status' } }
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error: boom')
      expect(result.content[0].text).toContain('Check the error details and try again')
    })
  })
})
