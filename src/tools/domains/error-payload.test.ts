import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A vendored service reports most failures by returning `{error}` as its text
 * payload instead of throwing. Each case below runs a real vendored service
 * through its real domain run with a Google API call that fails, and checks
 * that the result reaches the MCP client flagged `isError: true`.
 */
const api = vi.hoisted(() => ({
  calendarListList: vi.fn(),
  spacesList: vi.fn(),
  documentsCreate: vi.fn(),
  filesList: vi.fn(),
  messagesList: vi.fn(),
  peopleGet: vi.fn(),
  spreadsheetsGet: vi.fn(),
  presentationsGet: vi.fn(),
  tasklistsList: vi.fn()
}))

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))

vi.mock('googleapis', () => ({
  google: {
    calendar: () => ({
      calendarList: { list: api.calendarListList },
      calendars: { get: vi.fn() },
      events: { list: vi.fn() }
    }),
    chat: () => ({ spaces: { list: api.spacesList } }),
    docs: () => ({ documents: { create: api.documentsCreate } }),
    drive: () => ({ files: { list: api.filesList } }),
    gmail: () => ({ users: { messages: { list: api.messagesList } } }),
    people: () => ({ people: { get: api.peopleGet } }),
    sheets: () => ({ spreadsheets: { get: api.spreadsheetsGet } }),
    slides: () => ({ presentations: { get: api.presentationsGet } }),
    tasks: () => ({ tasklists: { list: api.tasklistsList } })
  }
}))

import { calendar } from './calendar.js'
import { chat } from './chat.js'
import { docs } from './docs.js'
import { drive } from './drive.js'
import type { DomainRunInput } from './factory.js'
import { gmail } from './gmail.js'
import { people } from './people.js'
import { sheets } from './sheets.js'
import { slides } from './slides.js'
import { tasks } from './tasks.js'
import { time } from './time.js'

const API_ERROR = 'Requested entity was not found.'

beforeEach(() => {
  vi.clearAllMocks()
  for (const call of Object.values(api)) call.mockRejectedValue(new Error(API_ERROR))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0]
  if (item.type !== 'text' || typeof item.text !== 'string') throw new Error('expected text result')
  return item.text
}

type Run = (input: DomainRunInput) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>

const CASES: Array<[string, Run, DomainRunInput, keyof typeof api]> = [
  ['calendar', calendar, { action: 'listCalendars' }, 'calendarListList'],
  ['chat', chat, { action: 'listSpaces' }, 'spacesList'],
  ['docs', docs, { action: 'create', title: 'Notes' }, 'documentsCreate'],
  ['drive', drive, { action: 'search', query: 'report' }, 'filesList'],
  ['gmail', gmail, { action: 'search', query: 'from:a@example.com' }, 'messagesList'],
  ['people', people, { action: 'getUserProfile', userId: 'people/123' }, 'peopleGet'],
  ['sheets', sheets, { action: 'getText', spreadsheetId: 's1' }, 'spreadsheetsGet'],
  ['slides', slides, { action: 'getText', presentationId: 'p1' }, 'presentationsGet'],
  ['tasks', tasks, { action: 'listTaskLists' }, 'tasklistsList']
]

describe('a vendored {error} payload is flagged isError', () => {
  it.each(CASES)('%s', async (_name, run, input, call) => {
    const result = await run(input)

    expect(api[call]).toHaveBeenCalled()
    expect(result.isError).toBe(true)
    const payload = JSON.parse(textOf(result))
    expect(payload.error).toEqual(expect.any(String))
    // The text is the service's own payload, passed through unchanged.
    expect(textOf(result)).toContain(API_ERROR)
  })

  it('time', async () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no time zone data')
    })

    const result = await time({ action: 'getTimeZone' })

    expect(result.isError).toBe(true)
    expect(JSON.parse(textOf(result))).toEqual({ error: 'no time zone data' })
  })
})
