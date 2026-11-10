import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end bounds: a real vendored service, a real domain run, a mocked
 * Google API. These prove the bound is applied on the path a caller actually
 * uses, not only in the helper's own unit tests.
 */
const { messagesGet, presentationsGet, spacesList, commentsList, eventsList } = vi.hoisted(() => ({
  messagesGet: vi.fn(),
  presentationsGet: vi.fn(),
  spacesList: vi.fn(),
  commentsList: vi.fn(),
  eventsList: vi.fn()
}))

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))

vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({ users: { messages: { get: messagesGet } } }),
    slides: () => ({ presentations: { get: presentationsGet } }),
    chat: () => ({ spaces: { list: spacesList } }),
    drive: () => ({ comments: { list: commentsList } }),
    calendar: () => ({
      events: { list: eventsList },
      calendarList: { list: vi.fn() },
      calendars: { get: vi.fn() }
    })
  }
}))

import { calendar } from './calendar.js'
import { chat } from './chat.js'
import { drive } from './drive.js'
import { gmail } from './gmail.js'
import { slides } from './slides.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0]
  if (item.type !== 'text' || typeof item.text !== 'string') throw new Error('expected text result')
  return item.text
}

const MESSAGE = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX'],
  snippet: 'snippet',
  payload: {
    headers: [
      { name: 'Subject', value: 'Big message' },
      { name: 'From', value: 'a@example.com' },
      { name: 'To', value: 'b@example.com' },
      { name: 'Date', value: '2026-01-01' }
    ],
    body: { data: Buffer.from('x'.repeat(40_000), 'utf8').toString('base64') },
    mimeType: 'text/plain'
  }
}

describe('gmail.get bounds', () => {
  it('caps a long message body by default and names the true size', async () => {
    messagesGet.mockResolvedValue({ data: MESSAGE })

    const text = textOf(await gmail({ action: 'get', messageId: 'm1' }))
    const parsed = JSON.parse(text)

    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(parsed.id).toBe('m1')
    expect(parsed.subject).toBe('Big message')
    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed._truncation.note).toMatch(/\[Content truncated: showing \d+ of \d+ characters \(\d+ omitted\)\./)
    expect(parsed._truncation.note).toContain('Pass full: true')
  })

  it('returns the whole body with full true', async () => {
    messagesGet.mockResolvedValue({ data: MESSAGE })

    const parsed = JSON.parse(textOf(await gmail({ action: 'get', messageId: 'm1', full: true })))

    expect(parsed._truncation).toBeUndefined()
    expect(parsed.body).toContain('x'.repeat(40_000))
  })

  it('raises the budget with max_chars', async () => {
    messagesGet.mockResolvedValue({ data: MESSAGE })

    const text = textOf(await gmail({ action: 'get', messageId: 'm1', max_chars: 60_000 }))

    expect(text).not.toContain('[Content truncated:')
    expect(text).toContain('x'.repeat(40_000))
  })

  it('rejects a bad max_chars without calling Gmail', async () => {
    messagesGet.mockResolvedValue({ data: MESSAGE })

    await expect(gmail({ action: 'get', messageId: 'm1', max_chars: 0 })).rejects.toThrow(
      /max_chars must be an integer between 1 and 100000/
    )
    expect(messagesGet).not.toHaveBeenCalled()
  })
})

describe('slides.getText bounds', () => {
  it('caps a long deck by default and marks the cut', async () => {
    const textRun = { textElements: [{ textRun: { content: 'slide text '.repeat(2_000) } }] }
    presentationsGet.mockResolvedValue({
      data: { title: 'Deck', slides: [{ pageElements: [{ shape: { text: textRun } }] }] }
    })

    const text = textOf(await slides({ action: 'getText', presentationId: 'p1' }))

    expect(text.length).toBeLessThanOrEqual(21_000)
    expect(text).toContain('[Content truncated: showing 20000 of')
    expect(text).toContain('Pass full: true')
  })

  it('returns the whole deck with full true', async () => {
    const textRun = { textElements: [{ textRun: { content: 'slide text '.repeat(2_000) } }] }
    presentationsGet.mockResolvedValue({
      data: { title: 'Deck', slides: [{ pageElements: [{ shape: { text: textRun } }] }] }
    })

    const text = textOf(await slides({ action: 'getText', presentationId: 'p1', full: true }))

    expect(text).not.toContain('[Content truncated:')
    expect(text.length).toBeGreaterThan(20_000)
  })

  it('caps an unpaged image listing by item count', async () => {
    const images = Array.from({ length: 120 }, (_, index) => ({
      objectId: `img${index}`,
      image: { sourceUrl: `https://example.com/${index}.png` }
    }))
    presentationsGet.mockResolvedValue({ data: { slides: [{ objectId: 's1', pageElements: images }] } })

    const parsed = JSON.parse(textOf(await slides({ action: 'getImages', presentationId: 'p1', localPath: '/tmp' })))

    expect(parsed.images).toHaveLength(100)
    expect(parsed._truncation.omitted_items[0]).toEqual({ path: '$.images', returned: 100, total: 120 })
  })
})

describe('paged listings keep their cursor', () => {
  it('chat.listSpaces forwards the page and returns nextPageToken', async () => {
    spacesList.mockResolvedValue({
      data: {
        spaces: Array.from({ length: 20 }, (_, i) => ({ name: `spaces/${i}`, displayName: 'd'.repeat(2_000) })),
        nextPageToken: 'spaces-page-2'
      }
    })

    const parsed = JSON.parse(textOf(await chat({ action: 'listSpaces', pageSize: 20, pageToken: 'p1' })))

    expect(spacesList).toHaveBeenCalledWith({ pageSize: 20, pageToken: 'p1' })
    expect(parsed._truncation.truncated).toBe(true)
    expect(parsed.nextPageToken).toBe('spaces-page-2')
    expect(parsed.spaces).toHaveLength(20)
  })

  it('drive.getComments forwards the page and returns nextPageToken', async () => {
    commentsList.mockResolvedValue({
      data: {
        comments: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, content: 'c'.repeat(2_000) })),
        nextPageToken: 'comments-page-2'
      }
    })

    const parsed = JSON.parse(textOf(await drive({ action: 'getComments', fileId: 'f1', pageSize: 20 })))

    expect(commentsList).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'f1', pageSize: 20 }))
    expect(parsed.nextPageToken).toBe('comments-page-2')
    expect(parsed._truncation.truncated).toBe(true)
  })

  it('calendar.listEvents forwards maxResults and returns nextPageToken', async () => {
    eventsList.mockResolvedValue({
      data: {
        items: Array.from({ length: 20 }, (_, i) => ({
          id: `e${i}`,
          summary: `Event ${i}`,
          description: 'd'.repeat(2_000),
          start: { dateTime: '2026-01-01T10:00:00Z' },
          end: { dateTime: '2026-01-01T11:00:00Z' }
        })),
        nextPageToken: 'events-page-2'
      }
    })

    const parsed = JSON.parse(textOf(await calendar({ action: 'listEvents', calendarId: 'primary', maxResults: 20 })))

    expect(eventsList).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 20 }))
    expect(parsed.nextPageToken).toBe('events-page-2')
    expect(parsed._truncation.truncated).toBe(true)
  })
})
