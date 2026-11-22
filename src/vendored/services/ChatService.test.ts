import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

const h = vi.hoisted(() => ({
  authClient: { id: 'fake-auth-client' },
  getAuthenticatedClient: vi.fn(),
  googleChat: vi.fn(),
  googlePeople: vi.fn(),
  spacesList: vi.fn(),
  spacesSetup: vi.fn(),
  messagesCreate: vi.fn(),
  messagesList: vi.fn(),
  membersList: vi.fn(),
  peopleGet: vi.fn()
}))

// Mock the auth shim so no real credentials are needed.
vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: h.getAuthenticatedClient })
}))
// Mock googleapis to intercept every Chat / People call ChatService makes.
vi.mock('googleapis', () => ({
  google: {
    chat: (options: unknown) => {
      h.googleChat(options)
      return {
        spaces: {
          list: h.spacesList,
          setup: h.spacesSetup,
          messages: { create: h.messagesCreate, list: h.messagesList },
          members: { list: h.membersList }
        }
      }
    },
    people: (options: unknown) => {
      h.googlePeople(options)
      return { people: { get: h.peopleGet } }
    }
  }
}))

import { AuthManager } from '../auth/AuthManager.js'
import { setLoggingEnabled } from '../utils/logger.js'
import { ChatService } from './ChatService.js'

const service = () => new ChatService(new AuthManager(['scope']))
const textOf = (res: { content: Array<{ text: string }> }) => res.content[0].text
const jsonOf = (res: { content: Array<{ text: string }> }) => JSON.parse(textOf(res))

describe('vendored ChatService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.getAuthenticatedClient.mockResolvedValue(h.authClient)
  })

  describe('client construction', () => {
    it('builds the Chat client with the v1 version and the authenticated client', async () => {
      h.spacesList.mockResolvedValue({ data: {} })

      await service().listSpaces()

      expect(h.googleChat).toHaveBeenCalledTimes(1)
      expect(h.googleChat).toHaveBeenCalledWith(
        expect.objectContaining({ version: 'v1', auth: h.authClient, timeout: 30000 })
      )
    })

    it('builds the People client with the v1 version and the authenticated client', async () => {
      h.peopleGet.mockResolvedValue({ data: { metadata: { sources: [{ type: 'PROFILE', id: '1' }] } } })
      h.membersList.mockResolvedValue({ data: {} })
      h.messagesList.mockResolvedValue({ data: {} })

      await service().getMessages({ spaceName: 'spaces/AAA', unreadOnly: true })

      expect(h.googlePeople).toHaveBeenCalledWith(
        expect.objectContaining({ version: 'v1', auth: h.authClient, timeout: 30000 })
      )
    })

    it('reports an auth failure as an error payload instead of throwing', async () => {
      h.getAuthenticatedClient.mockRejectedValue(new Error('no credentials'))

      const res = await service().listSpaces()

      expect(jsonOf(res)).toEqual({
        error: 'An error occurred while listing chat spaces.',
        details: 'no credentials'
      })
      expect(h.spacesList).not.toHaveBeenCalled()
    })
  })

  describe('listSpaces (fork: pageSize/pageToken and nextPageToken)', () => {
    it('forwards pageSize and pageToken to spaces.list', async () => {
      h.spacesList.mockResolvedValue({ data: { spaces: [] } })

      await service().listSpaces({ pageSize: 25, pageToken: 'cursor-1' })

      expect(h.spacesList).toHaveBeenCalledTimes(1)
      expect(h.spacesList).toHaveBeenCalledWith({ pageSize: 25, pageToken: 'cursor-1' })
    })

    it('returns the spaces together with the cursor of the next page', async () => {
      const spaces = [
        { name: 'spaces/AAA', displayName: 'Team' },
        { name: 'spaces/BBB', displayName: 'Ops' }
      ]
      h.spacesList.mockResolvedValue({ data: { spaces, nextPageToken: 'cursor-2' } })

      const res = await service().listSpaces({ pageSize: 2 })

      expect(res.content[0].type).toBe('text')
      expect(jsonOf(res)).toEqual({ spaces, nextPageToken: 'cursor-2' })
    })

    it('reports a null cursor on the last page', async () => {
      h.spacesList.mockResolvedValue({ data: { spaces: [{ name: 'spaces/AAA' }] } })

      const parsed = jsonOf(await service().listSpaces())

      expect(parsed.nextPageToken).toBeNull()
      expect(parsed.spaces).toEqual([{ name: 'spaces/AAA' }])
    })

    it('sends neither pageSize nor pageToken when the caller gave none', async () => {
      h.spacesList.mockResolvedValue({ data: { spaces: [] } })

      await service().listSpaces()

      expect(Object.keys(h.spacesList.mock.calls[0][0])).toEqual([])
    })

    it('still forwards a pageSize of 0 instead of dropping it as falsy', async () => {
      h.spacesList.mockResolvedValue({ data: { spaces: [] } })

      await service().listSpaces({ pageSize: 0 })

      expect(Object.keys(h.spacesList.mock.calls[0][0])).toEqual(['pageSize'])
      expect(h.spacesList.mock.calls[0][0].pageSize).toBe(0)
    })

    it('forwards only the pageToken when pageSize is absent', async () => {
      h.spacesList.mockResolvedValue({ data: { spaces: [] } })

      await service().listSpaces({ pageToken: 'cursor-9' })

      expect(h.spacesList.mock.calls[0][0]).toEqual({ pageToken: 'cursor-9' })
      expect(Object.keys(h.spacesList.mock.calls[0][0])).toEqual(['pageToken'])
    })

    it('returns an empty list when the API omits spaces', async () => {
      h.spacesList.mockResolvedValue({ data: {} })

      expect(jsonOf(await service().listSpaces())).toEqual({ spaces: [], nextPageToken: null })
    })
  })

  describe('sendMessage', () => {
    it('posts plain text to the space without a thread', async () => {
      h.messagesCreate.mockResolvedValue({ data: { name: 'spaces/AAA/messages/m1', text: 'hello' } })

      const res = await service().sendMessage({ spaceName: 'spaces/AAA', message: 'hello' })

      expect(h.messagesCreate).toHaveBeenCalledTimes(1)
      const request = h.messagesCreate.mock.calls[0][0]
      expect(request.parent).toBe('spaces/AAA')
      expect(request.messageReplyOption).toBeUndefined()
      expect(request.requestBody.text).toBe('hello')
      expect(request.requestBody.thread).toBeUndefined()
      expect(jsonOf(res)).toEqual({ name: 'spaces/AAA/messages/m1', text: 'hello' })
    })

    it('replies inside the given thread and falls back to a new thread', async () => {
      h.messagesCreate.mockResolvedValue({ data: { name: 'spaces/AAA/messages/m2' } })

      await service().sendMessage({
        spaceName: 'spaces/AAA',
        message: 'reply',
        threadName: 'spaces/AAA/threads/T1'
      })

      expect(h.messagesCreate).toHaveBeenCalledWith({
        parent: 'spaces/AAA',
        messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
        requestBody: { text: 'reply', thread: { name: 'spaces/AAA/threads/T1' } }
      })
    })
  })

  describe('findSpaceByName', () => {
    it('walks every page and returns the spaces whose displayName matches exactly', async () => {
      h.spacesList
        .mockResolvedValueOnce({
          data: {
            spaces: [
              { name: 'spaces/A', displayName: 'Team' },
              { name: 'spaces/B', displayName: 'Team Lead' }
            ],
            nextPageToken: 'page-2'
          }
        })
        .mockResolvedValueOnce({
          data: { spaces: [{ name: 'spaces/C', displayName: 'Team' }], nextPageToken: 'page-3' }
        })
        .mockResolvedValueOnce({ data: { spaces: [{ name: 'spaces/D', displayName: 'Other' }] } })

      const res = await service().findSpaceByName({ displayName: 'Team' })

      expect(h.spacesList).toHaveBeenCalledTimes(3)
      expect(h.spacesList.mock.calls[0][0].pageToken).toBeUndefined()
      expect(h.spacesList.mock.calls[1][0]).toEqual({ pageToken: 'page-2' })
      expect(h.spacesList.mock.calls[2][0]).toEqual({ pageToken: 'page-3' })
      expect(jsonOf(res)).toEqual([
        { name: 'spaces/A', displayName: 'Team' },
        { name: 'spaces/C', displayName: 'Team' }
      ])
    })

    it('reports an error naming the display name when no space matches', async () => {
      h.spacesList.mockResolvedValue({ data: { spaces: [{ name: 'spaces/A', displayName: 'Team' }] } })

      const res = await service().findSpaceByName({ displayName: 'Nope' })

      expect(jsonOf(res)).toEqual({ error: 'No space found with display name: Nope' })
    })

    it('treats a page without a spaces field as empty', async () => {
      h.spacesList.mockResolvedValue({ data: {} })

      const res = await service().findSpaceByName({ displayName: 'Team' })

      expect(jsonOf(res)).toEqual({ error: 'No space found with display name: Team' })
    })
  })

  describe('getMessages', () => {
    it('lists messages with the paging options and no filter by default', async () => {
      const messages = [{ name: 'spaces/AAA/messages/m1' }]
      h.messagesList.mockResolvedValue({ data: { messages, nextPageToken: 'next-1' } })

      const res = await service().getMessages({
        spaceName: 'spaces/AAA',
        pageSize: 10,
        pageToken: 'tok',
        orderBy: 'createTime desc'
      })

      expect(h.peopleGet).not.toHaveBeenCalled()
      expect(h.membersList).not.toHaveBeenCalled()
      const request = h.messagesList.mock.calls[0][0]
      expect(request.filter).toBeUndefined()
      expect(request).toEqual({
        parent: 'spaces/AAA',
        pageSize: 10,
        pageToken: 'tok',
        orderBy: 'createTime desc'
      })
      expect(jsonOf(res)).toEqual({ messages, nextPageToken: 'next-1' })
    })

    it('filters by thread name', async () => {
      h.messagesList.mockResolvedValue({ data: { messages: [] } })

      await service().getMessages({ spaceName: 'spaces/AAA', threadName: 'spaces/AAA/threads/T1' })

      expect(h.messagesList.mock.calls[0][0].filter).toBe('thread.name = "spaces/AAA/threads/T1"')
    })

    it('returns an empty list when the API omits messages', async () => {
      h.messagesList.mockResolvedValue({ data: {} })

      const parsed = jsonOf(await service().getMessages({ spaceName: 'spaces/AAA' }))

      expect(parsed.messages).toEqual([])
    })

    describe('unreadOnly', () => {
      const profile = { data: { metadata: { sources: [{ type: 'PROFILE', id: '42' }] } } }

      it('resolves the caller and filters to messages after their last read time', async () => {
        h.peopleGet.mockResolvedValue({
          data: {
            metadata: {
              sources: [
                { type: 'CONTACT', id: '7' },
                { type: 'PROFILE', id: '42' }
              ]
            }
          }
        })
        h.membersList.mockResolvedValue({
          data: {
            memberships: [
              { member: { name: 'users/99' }, lastReadTime: '2020-01-01T00:00:00Z' },
              { member: { name: 'users/42' }, lastReadTime: '2024-05-06T07:08:09Z' }
            ]
          }
        })
        h.messagesList.mockResolvedValue({ data: { messages: [{ name: 'spaces/AAA/messages/m9' }] } })

        const res = await service().getMessages({ spaceName: 'spaces/AAA', unreadOnly: true })

        expect(h.peopleGet).toHaveBeenCalledWith({ resourceName: 'people/me', personFields: 'metadata' })
        expect(h.membersList).toHaveBeenCalledWith({ parent: 'spaces/AAA' })
        expect(h.messagesList.mock.calls[0][0].filter).toBe('createTime > "2024-05-06T07:08:09Z"')
        expect(jsonOf(res).messages).toEqual([{ name: 'spaces/AAA/messages/m9' }])
      })

      it('joins the thread filter and the unread filter with AND', async () => {
        h.peopleGet.mockResolvedValue(profile)
        h.membersList.mockResolvedValue({
          data: { memberships: [{ member: { name: 'users/42' }, lastReadTime: '2024-05-06T07:08:09Z' }] }
        })
        h.messagesList.mockResolvedValue({ data: { messages: [] } })

        await service().getMessages({
          spaceName: 'spaces/AAA',
          unreadOnly: true,
          threadName: 'spaces/AAA/threads/T1'
        })

        expect(h.messagesList.mock.calls[0][0].filter).toBe(
          'thread.name = "spaces/AAA/threads/T1" AND createTime > "2024-05-06T07:08:09Z"'
        )
      })

      it('applies no time filter when the caller has never read the space', async () => {
        h.peopleGet.mockResolvedValue(profile)
        h.membersList.mockResolvedValue({ data: { memberships: [{ member: { name: 'users/42' } }] } })
        h.messagesList.mockResolvedValue({ data: { messages: [{ name: 'spaces/AAA/messages/m1' }] } })

        const res = await service().getMessages({ spaceName: 'spaces/AAA', unreadOnly: true })

        expect(h.messagesList.mock.calls[0][0].filter).toBeUndefined()
        expect(jsonOf(res).messages).toEqual([{ name: 'spaces/AAA/messages/m1' }])
      })

      it('applies no time filter when the caller is not a member of the space', async () => {
        h.peopleGet.mockResolvedValue(profile)
        h.membersList.mockResolvedValue({
          data: { memberships: [{ member: { name: 'users/99' }, lastReadTime: '2020-01-01T00:00:00Z' }] }
        })
        h.messagesList.mockResolvedValue({ data: { messages: [] } })

        await service().getMessages({ spaceName: 'spaces/AAA', unreadOnly: true })

        expect(h.messagesList.mock.calls[0][0].filter).toBeUndefined()
      })

      it('tolerates a members response without memberships', async () => {
        h.peopleGet.mockResolvedValue(profile)
        h.membersList.mockResolvedValue({ data: {} })
        h.messagesList.mockResolvedValue({ data: { messages: [] } })

        await service().getMessages({ spaceName: 'spaces/AAA', unreadOnly: true })

        expect(h.messagesList.mock.calls[0][0].filter).toBeUndefined()
      })

      it.each([
        ['no metadata', { data: {} }],
        ['metadata without sources', { data: { metadata: {} } }],
        ['no PROFILE source', { data: { metadata: { sources: [{ type: 'CONTACT', id: '7' }] } } }],
        ['a PROFILE source without an id', { data: { metadata: { sources: [{ type: 'PROFILE' }] } } }]
      ])('fails before listing members when the user id is unknown (%s)', async (_label, person) => {
        h.peopleGet.mockResolvedValue(person)

        const res = await service().getMessages({ spaceName: 'spaces/AAA', unreadOnly: true })

        expect(jsonOf(res)).toEqual({
          error: 'An error occurred while listing messages.',
          details: 'Could not determine user ID.'
        })
        expect(h.membersList).not.toHaveBeenCalled()
        expect(h.messagesList).not.toHaveBeenCalled()
      })
    })
  })

  describe('sendDm', () => {
    it('opens a direct-message space with the user and posts the message to it', async () => {
      h.spacesSetup.mockResolvedValue({ data: { name: 'spaces/DM1' } })
      h.messagesCreate.mockResolvedValue({ data: { name: 'spaces/DM1/messages/m1', text: 'hi' } })

      const res = await service().sendDm({ email: 'ann@example.com', message: 'hi' })

      expect(h.spacesSetup).toHaveBeenCalledWith({
        requestBody: {
          space: { spaceType: 'DIRECT_MESSAGE' },
          memberships: [{ member: { name: 'users/ann@example.com', type: 'HUMAN' } }]
        }
      })
      const request = h.messagesCreate.mock.calls[0][0]
      expect(request.parent).toBe('spaces/DM1')
      expect(request.messageReplyOption).toBeUndefined()
      expect(request.requestBody.text).toBe('hi')
      expect(request.requestBody.thread).toBeUndefined()
      expect(jsonOf(res)).toEqual({ name: 'spaces/DM1/messages/m1', text: 'hi' })
    })

    it('replies inside the given thread of the DM space', async () => {
      h.spacesSetup.mockResolvedValue({ data: { name: 'spaces/DM1' } })
      h.messagesCreate.mockResolvedValue({ data: { name: 'spaces/DM1/messages/m2' } })

      await service().sendDm({ email: 'ann@example.com', message: 'again', threadName: 'spaces/DM1/threads/T9' })

      expect(h.messagesCreate).toHaveBeenCalledWith({
        parent: 'spaces/DM1',
        messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
        requestBody: { text: 'again', thread: { name: 'spaces/DM1/threads/T9' } }
      })
    })

    it('does not post when the DM space comes back without a name', async () => {
      h.spacesSetup.mockResolvedValue({ data: {} })

      const res = await service().sendDm({ email: 'ann@example.com', message: 'hi' })

      expect(jsonOf(res)).toEqual({
        error: 'An error occurred while sending the DM.',
        details: 'Could not determine the space name for the DM.'
      })
      expect(h.messagesCreate).not.toHaveBeenCalled()
    })

    it('does not post when the setup call returns no space at all', async () => {
      h.spacesSetup.mockResolvedValue({ data: undefined })

      const res = await service().sendDm({ email: 'ann@example.com', message: 'hi' })

      expect(jsonOf(res)).toEqual({
        error: 'An error occurred while sending the DM.',
        details: 'Could not find or create a DM space.'
      })
      expect(h.messagesCreate).not.toHaveBeenCalled()
    })
  })

  describe('findDmByEmail', () => {
    it('returns the DM space set up for the given email', async () => {
      const space = { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' }
      h.spacesSetup.mockResolvedValue({ data: space })

      const res = await service().findDmByEmail({ email: 'bob@example.com' })

      expect(h.spacesSetup).toHaveBeenCalledWith({
        requestBody: {
          space: { spaceType: 'DIRECT_MESSAGE' },
          memberships: [{ member: { name: 'users/bob@example.com', type: 'HUMAN' } }]
        }
      })
      expect(jsonOf(res)).toEqual(space)
    })

    it('reports an error when no DM space can be found or created', async () => {
      h.spacesSetup.mockResolvedValue({ data: undefined })

      const res = await service().findDmByEmail({ email: 'bob@example.com' })

      expect(jsonOf(res)).toEqual({
        error: 'An error occurred while finding the DM space.',
        details: 'Could not find or create a DM space.'
      })
    })
  })

  describe('listThreads', () => {
    it('keeps the first message of each thread, newest first, and skips unthreaded messages', async () => {
      const messages = [
        { name: 'm1', thread: { name: 'spaces/AAA/threads/T1' } },
        { name: 'm2', thread: { name: 'spaces/AAA/threads/T2' } },
        { name: 'm3', thread: { name: 'spaces/AAA/threads/T1' } },
        { name: 'm4' },
        { name: 'm5', thread: {} }
      ]
      h.messagesList.mockResolvedValue({ data: { messages, nextPageToken: 'more' } })

      const res = await service().listThreads({ spaceName: 'spaces/AAA', pageSize: 5, pageToken: 'tok' })

      expect(h.messagesList).toHaveBeenCalledWith({
        parent: 'spaces/AAA',
        pageSize: 5,
        pageToken: 'tok',
        orderBy: 'createTime desc'
      })
      expect(jsonOf(res)).toEqual({ threads: [messages[0], messages[1]], nextPageToken: 'more' })
    })

    it('returns no threads when the API omits messages', async () => {
      h.messagesList.mockResolvedValue({ data: {} })

      const parsed = jsonOf(await service().listThreads({ spaceName: 'spaces/AAA' }))

      expect(parsed.threads).toEqual([])
      expect(parsed.nextPageToken).toBeUndefined()
    })
  })

  describe('setUpSpace', () => {
    it('creates a named space with one HUMAN membership per user', async () => {
      h.spacesSetup.mockResolvedValue({ data: { name: 'spaces/NEW', displayName: 'Launch' } })

      const res = await service().setUpSpace({ displayName: 'Launch', userNames: ['users/1', 'users/2'] })

      expect(h.spacesSetup).toHaveBeenCalledWith({
        requestBody: {
          space: { spaceType: 'SPACE', displayName: 'Launch' },
          memberships: [{ member: { name: 'users/1', type: 'HUMAN' } }, { member: { name: 'users/2', type: 'HUMAN' } }]
        }
      })
      expect(jsonOf(res)).toEqual({ name: 'spaces/NEW', displayName: 'Launch' })
    })

    it('creates a space with no memberships when no users are given', async () => {
      h.spacesSetup.mockResolvedValue({ data: { name: 'spaces/NEW' } })

      await service().setUpSpace({ displayName: 'Solo', userNames: [] })

      expect(h.spacesSetup.mock.calls[0][0].requestBody.memberships).toEqual([])
    })
  })

  describe('API failures', () => {
    // Every method wraps its Google call in the same catch: it must return an
    // { error, details } payload and never throw to the MCP layer.
    const cases: Array<{
      method: string
      error: string
      fail: (reason: unknown) => void
      call: (svc: ChatService) => Promise<{ content: Array<{ text: string }> }>
    }> = [
      {
        method: 'listSpaces',
        error: 'An error occurred while listing chat spaces.',
        fail: (reason) => h.spacesList.mockRejectedValue(reason),
        call: (svc) => svc.listSpaces({ pageSize: 1 })
      },
      {
        method: 'sendMessage',
        error: 'An error occurred while sending the message.',
        fail: (reason) => h.messagesCreate.mockRejectedValue(reason),
        call: (svc) => svc.sendMessage({ spaceName: 'spaces/AAA', message: 'hi' })
      },
      {
        method: 'findSpaceByName',
        error: 'An error occurred while finding the space.',
        fail: (reason) => h.spacesList.mockRejectedValue(reason),
        call: (svc) => svc.findSpaceByName({ displayName: 'Team' })
      },
      {
        method: 'getMessages',
        error: 'An error occurred while listing messages.',
        fail: (reason) => h.messagesList.mockRejectedValue(reason),
        call: (svc) => svc.getMessages({ spaceName: 'spaces/AAA' })
      },
      {
        method: 'sendDm',
        error: 'An error occurred while sending the DM.',
        fail: (reason) => h.spacesSetup.mockRejectedValue(reason),
        call: (svc) => svc.sendDm({ email: 'ann@example.com', message: 'hi' })
      },
      {
        method: 'findDmByEmail',
        error: 'An error occurred while finding the DM space.',
        fail: (reason) => h.spacesSetup.mockRejectedValue(reason),
        call: (svc) => svc.findDmByEmail({ email: 'ann@example.com' })
      },
      {
        method: 'listThreads',
        error: 'An error occurred while listing threads.',
        fail: (reason) => h.messagesList.mockRejectedValue(reason),
        call: (svc) => svc.listThreads({ spaceName: 'spaces/AAA' })
      },
      {
        method: 'setUpSpace',
        error: 'An error occurred while creating the space.',
        fail: (reason) => h.spacesSetup.mockRejectedValue(reason),
        call: (svc) => svc.setUpSpace({ displayName: 'Launch', userNames: ['users/1'] })
      }
    ]

    describe.each(cases)('$method', ({ error, fail, call }) => {
      it('returns the Error message as details', async () => {
        fail(new Error('quota exceeded'))

        const res = await call(service())

        expect(jsonOf(res)).toEqual({ error, details: 'quota exceeded' })
      })

      it('returns the text of a non-Error rejection as details', async () => {
        fail('backend unavailable')

        const res = await call(service())

        expect(jsonOf(res)).toEqual({ error, details: 'backend unavailable' })
      })

      it('survives an Error that carries no stack', async () => {
        fail(Object.assign(new Error('stackless'), { stack: undefined }))

        const res = await call(service())

        expect(jsonOf(res)).toEqual({ error, details: 'stackless' })
      })
    })

    describe('error logging', () => {
      let stderr: MockInstance<typeof process.stderr.write>

      beforeEach(() => {
        setLoggingEnabled(true)
        stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      })

      afterEach(() => {
        stderr.mockRestore()
        setLoggingEnabled(false)
      })

      const logged = () => stderr.mock.calls.map((call) => String(call[0])).join('')

      it('logs the stack trace of an Error that has one', async () => {
        const failure = new Error('with stack')
        h.spacesList.mockRejectedValue(failure)

        await service().listSpaces()

        expect(logged()).toContain('Error during chat.listSpaces: with stack')
        expect(logged()).toContain(`Stack trace: ${failure.stack}`)
      })

      it('omits the stack trace line when the Error has no stack', async () => {
        h.spacesList.mockRejectedValue(Object.assign(new Error('no stack'), { stack: undefined }))

        await service().listSpaces()

        expect(logged()).toContain('Error during chat.listSpaces: no stack')
        expect(logged()).not.toContain('Stack trace:')
      })
    })
  })
})
