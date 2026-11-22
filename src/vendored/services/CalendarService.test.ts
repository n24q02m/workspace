import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const h = vi.hoisted(() => ({
  authClient: { tag: 'oauth-client' },
  getAuthenticatedClient: vi.fn(),
  calendarFactory: vi.fn(),
  calendarApi: {
    calendarList: { list: vi.fn() },
    events: { insert: vi.fn(), list: vi.fn(), get: vi.fn(), delete: vi.fn(), patch: vi.fn() },
    freebusy: { query: vi.fn() }
  }
}))

// Mock the auth shim so no real credentials are needed.
vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: h.getAuthenticatedClient })
}))
// Intercept every Calendar API call the service makes.
vi.mock('googleapis', () => ({ google: { calendar: h.calendarFactory } }))
// Real validation by default; individual tests make it throw a non-Zod error.
vi.mock('./CalendarValidation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CalendarValidation.js')>()
  return {
    ...actual,
    validateCreateEventInput: vi.fn(actual.validateCreateEventInput),
    validateUpdateEventInput: vi.fn(actual.validateUpdateEventInput)
  }
})

import { AuthManager } from '../auth/AuthManager.js'
import { CalendarService } from './CalendarService.js'
import { validateCreateEventInput, validateUpdateEventInput } from './CalendarValidation.js'

const api = h.calendarApi
const newService = () => new CalendarService(new AuthManager(['scope']))
const body = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text)
const googleError = (error: Record<string, unknown>) =>
  Object.assign(new Error('Request failed with status code 400'), { response: { data: { error } } })

// The account's primary calendar, returned by calendarList.list unless a test overrides it.
const PRIMARY = 'me@x.com'
const START = { dateTime: '2026-03-02T09:00:00Z' }
const END = { dateTime: '2026-03-02T10:00:00Z' }

beforeEach(() => {
  h.getAuthenticatedClient.mockReset().mockResolvedValue(h.authClient)
  h.calendarFactory.mockReset().mockReturnValue(api)
  for (const fn of [
    api.calendarList.list,
    api.events.insert,
    api.events.list,
    api.events.get,
    api.events.delete,
    api.events.patch,
    api.freebusy.query
  ]) {
    fn.mockReset()
  }
  api.calendarList.list.mockResolvedValue({ data: { items: [{ id: PRIMARY, primary: true }] } })
  vi.mocked(validateCreateEventInput).mockClear()
  vi.mocked(validateUpdateEventInput).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('CalendarService client wiring', () => {
  it('creates the calendar v3 client with the shared gaxios options and the authenticated OAuth client', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [] } })
    await newService().listCalendars()

    expect(h.calendarFactory).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v3', auth: h.authClient, timeout: 30000 })
    )
  })
})

describe('CalendarService.listCalendars', () => {
  it('returns only id and summary of each calendar', async () => {
    api.calendarList.list.mockResolvedValue({
      data: {
        items: [
          { id: 'a@x.com', summary: 'Work', timeZone: 'UTC', primary: true },
          { id: 'b@x.com', summary: 'Home', accessRole: 'owner' }
        ]
      }
    })

    const res = await newService().listCalendars()

    expect(body(res)).toEqual([
      { id: 'a@x.com', summary: 'Work' },
      { id: 'b@x.com', summary: 'Home' }
    ])
  })

  it('returns an empty list when the account has no calendars', async () => {
    api.calendarList.list.mockResolvedValue({ data: {} })

    expect(body(await newService().listCalendars())).toEqual([])
  })

  it('reports the message of an Error thrown by the API', async () => {
    api.calendarList.list.mockRejectedValue(new Error('quota exceeded'))

    expect(body(await newService().listCalendars())).toEqual({ error: 'quota exceeded' })
  })

  it('stringifies a non-Error rejection', async () => {
    api.calendarList.list.mockRejectedValue('plain failure')

    expect(body(await newService().listCalendars())).toEqual({ error: 'plain failure' })
  })

  it('reports an authentication failure instead of throwing', async () => {
    h.getAuthenticatedClient.mockRejectedValue(new Error('not authenticated'))

    expect(body(await newService().listCalendars())).toEqual({ error: 'not authenticated' })
    expect(api.calendarList.list).not.toHaveBeenCalled()
  })
})

describe('CalendarService primary calendar resolution', () => {
  it('uses the primary calendar id and looks it up only once', async () => {
    api.calendarList.list.mockResolvedValue({
      data: { items: [{ id: 'other@x.com' }, { id: 'me@x.com', primary: true }] }
    })
    api.events.get.mockResolvedValue({ data: { id: 'ev1' } })
    const svc = newService()

    await svc.getEvent({ eventId: 'ev1' })
    await svc.getEvent({ eventId: 'ev2' })

    expect(api.calendarList.list).toHaveBeenCalledTimes(1)
    expect(api.events.get).toHaveBeenNthCalledWith(1, { calendarId: 'me@x.com', eventId: 'ev1' })
    expect(api.events.get).toHaveBeenNthCalledWith(2, { calendarId: 'me@x.com', eventId: 'ev2' })
  })

  it('falls back to "primary" and retries the lookup next time when no calendar is flagged primary', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [{ id: 'other@x.com' }] } })
    api.events.get.mockResolvedValue({ data: {} })
    const svc = newService()

    await svc.getEvent({ eventId: 'ev1' })
    await svc.getEvent({ eventId: 'ev2' })

    expect(api.events.get).toHaveBeenNthCalledWith(1, { calendarId: 'primary', eventId: 'ev1' })
    expect(api.events.get).toHaveBeenNthCalledWith(2, { calendarId: 'primary', eventId: 'ev2' })
    expect(api.calendarList.list).toHaveBeenCalledTimes(2)
  })

  it('falls back to "primary" when the primary calendar has no id', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [{ primary: true }] } })
    api.events.get.mockResolvedValue({ data: {} })

    await newService().getEvent({ eventId: 'ev1' })

    expect(api.events.get).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'ev1' })
  })

  it('falls back to "primary" when the calendar list has no items', async () => {
    api.calendarList.list.mockResolvedValue({ data: {} })
    api.events.get.mockResolvedValue({ data: {} })

    await newService().getEvent({ eventId: 'ev1' })

    expect(api.events.get).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'ev1' })
  })

  it('skips the lookup when the caller names a calendar', async () => {
    api.events.get.mockResolvedValue({ data: {} })

    await newService().getEvent({ eventId: 'ev1', calendarId: 'team@x.com' })

    expect(api.calendarList.list).not.toHaveBeenCalled()
    expect(api.events.get).toHaveBeenCalledWith({ calendarId: 'team@x.com', eventId: 'ev1' })
  })
})

describe('CalendarService.createEvent', () => {
  it('inserts a regular event and returns the created resource', async () => {
    api.events.insert.mockResolvedValue({ data: { id: 'new1', htmlLink: 'https://cal/new1' } })

    const res = await newService().createEvent({
      calendarId: 'cal-1',
      summary: 'Standup',
      description: 'Daily sync',
      start: START,
      end: END,
      attendees: ['a@x.com', 'b@x.com']
    })

    expect(api.events.insert).toHaveBeenCalledWith({
      calendarId: 'cal-1',
      sendUpdates: 'all',
      requestBody: {
        summary: 'Standup',
        description: 'Daily sync',
        start: START,
        end: END,
        attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }]
      }
    })
    expect(body(res)).toEqual({ id: 'new1', htmlLink: 'https://cal/new1' })
  })

  it('looks up the primary calendar when no calendarId is given', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [{ id: 'me@x.com', primary: true }] } })
    api.events.insert.mockResolvedValue({ data: { id: 'new1' } })

    await newService().createEvent({ summary: 'Solo', start: START, end: END })

    expect(api.events.insert).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'me@x.com' }))
  })

  it('does not notify anyone by default when the event has no attendees', async () => {
    api.events.insert.mockResolvedValue({ data: { id: 'new1' } })

    await newService().createEvent({ summary: 'Solo', start: START, end: END })
    await newService().createEvent({ summary: 'Solo', start: START, end: END, attendees: [] })

    expect(api.events.insert).toHaveBeenNthCalledWith(1, expect.objectContaining({ sendUpdates: 'none' }))
    expect(api.events.insert).toHaveBeenNthCalledWith(2, expect.objectContaining({ sendUpdates: 'none' }))
  })

  it('still creates the event when the client sends a null sendUpdates', async () => {
    api.events.insert.mockResolvedValue({ data: { id: 'new1' } })

    const res = await newService().createEvent({ summary: 'Solo', start: START, end: END, sendUpdates: null as any })

    expect(body(res)).toEqual({ id: 'new1' })
    expect(api.events.insert).toHaveBeenCalledTimes(1)
    expect(api.events.insert).toHaveBeenCalledWith(expect.objectContaining({ sendUpdates: null }))
  })

  it('keeps an explicit sendUpdates value over the attendee-based default', async () => {
    api.events.insert.mockResolvedValue({ data: { id: 'new1' } })

    await newService().createEvent({
      summary: 'Review',
      start: START,
      end: END,
      attendees: ['a@x.com'],
      sendUpdates: 'externalOnly'
    })

    expect(api.events.insert).toHaveBeenCalledWith(expect.objectContaining({ sendUpdates: 'externalOnly' }))
  })

  it('creates all-day events with a date instead of a dateTime', async () => {
    api.events.insert.mockResolvedValue({ data: { id: 'allday' } })

    await newService().createEvent({
      summary: 'Holiday',
      start: { date: '2026-03-02' },
      end: { date: '2026-03-03' }
    })

    expect(api.events.insert.mock.calls[0][0].requestBody).toMatchObject({
      start: { date: '2026-03-02' },
      end: { date: '2026-03-03' }
    })
  })

  it('does not tag a default event with an eventType', async () => {
    api.events.insert.mockResolvedValue({ data: { id: 'new1' } })

    await newService().createEvent({
      summary: 'Plain',
      eventType: 'default',
      start: START,
      end: END
    })

    const requestBody = api.events.insert.mock.calls[0][0].requestBody
    expect(requestBody).not.toHaveProperty('eventType')
    expect(requestBody.summary).toBe('Plain')
  })

  describe('event types', () => {
    it('applies focus-time defaults and a default summary', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'ft' } })

      await newService().createEvent({ eventType: 'focusTime', start: START, end: END })

      expect(api.events.insert.mock.calls[0][0].requestBody).toEqual({
        summary: 'Focus Time',
        start: START,
        end: END,
        eventType: 'focusTime',
        transparency: 'opaque',
        focusTimeProperties: {
          chatStatus: 'doNotDisturb',
          autoDeclineMode: 'declineOnlyNewConflictingInvitations'
        }
      })
    })

    it('passes explicit focus-time properties and decline message through', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'ft' } })

      await newService().createEvent({
        summary: 'Deep work',
        eventType: 'focusTime',
        start: START,
        end: END,
        focusTimeProperties: {
          chatStatus: 'available',
          autoDeclineMode: 'declineAllConflictingInvitations',
          declineMessage: 'Heads down'
        }
      })

      expect(api.events.insert.mock.calls[0][0].requestBody).toMatchObject({
        summary: 'Deep work',
        focusTimeProperties: {
          chatStatus: 'available',
          autoDeclineMode: 'declineAllConflictingInvitations',
          declineMessage: 'Heads down'
        }
      })
    })

    it('applies out-of-office defaults and a default summary', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'ooo' } })

      await newService().createEvent({ eventType: 'outOfOffice', start: START, end: END })

      expect(api.events.insert.mock.calls[0][0].requestBody).toEqual({
        summary: 'Out of Office',
        start: START,
        end: END,
        eventType: 'outOfOffice',
        transparency: 'opaque',
        outOfOfficeProperties: { autoDeclineMode: 'declineOnlyNewConflictingInvitations' }
      })
    })

    it('passes explicit out-of-office properties and decline message through', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'ooo' } })

      await newService().createEvent({
        eventType: 'outOfOffice',
        start: START,
        end: END,
        outOfOfficeProperties: { autoDeclineMode: 'declineNone', declineMessage: 'On leave' }
      })

      expect(api.events.insert.mock.calls[0][0].requestBody.outOfOfficeProperties).toEqual({
        autoDeclineMode: 'declineNone',
        declineMessage: 'On leave'
      })
    })

    it('builds a home-office working location as a public, transparent all-day event', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'wl' } })

      await newService().createEvent({
        eventType: 'workingLocation',
        start: { date: '2026-03-02' },
        end: { date: '2026-03-03' },
        workingLocationProperties: { type: 'homeOffice' }
      })

      expect(api.events.insert.mock.calls[0][0].requestBody).toEqual({
        summary: 'Working Location',
        start: { date: '2026-03-02' },
        end: { date: '2026-03-03' },
        eventType: 'workingLocation',
        visibility: 'public',
        transparency: 'transparent',
        workingLocationProperties: { type: 'homeOffice', homeOffice: {} }
      })
    })

    it('copies the office location of an office working location', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'wl' } })

      await newService().createEvent({
        eventType: 'workingLocation',
        start: { date: '2026-03-02' },
        end: { date: '2026-03-03' },
        workingLocationProperties: {
          type: 'officeLocation',
          officeLocation: { buildingId: 'HQ', label: 'Headquarters' }
        }
      })

      expect(api.events.insert.mock.calls[0][0].requestBody.workingLocationProperties).toEqual({
        type: 'officeLocation',
        officeLocation: { buildingId: 'HQ', label: 'Headquarters' }
      })
    })

    it('copies the label of a custom working location', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'wl' } })

      await newService().createEvent({
        eventType: 'workingLocation',
        start: { date: '2026-03-02' },
        end: { date: '2026-03-03' },
        workingLocationProperties: { type: 'customLocation', customLocation: { label: 'Cafe' } }
      })

      expect(api.events.insert.mock.calls[0][0].requestBody.workingLocationProperties).toEqual({
        type: 'customLocation',
        customLocation: { label: 'Cafe' }
      })
    })

    it('sends only the type for a working location of an unknown type', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'wl' } })

      await newService().createEvent({
        eventType: 'workingLocation',
        start: { date: '2026-03-02' },
        end: { date: '2026-03-03' },
        workingLocationProperties: { type: 'somewhereNew' as any }
      })

      expect(api.events.insert.mock.calls[0][0].requestBody.workingLocationProperties).toEqual({
        type: 'somewhereNew'
      })
    })

    it('prefers a caller-supplied summary over the event-type default', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'ooo' } })

      await newService().createEvent({
        summary: 'Vacation',
        eventType: 'outOfOffice',
        start: START,
        end: END
      })

      expect(api.events.insert.mock.calls[0][0].requestBody.summary).toBe('Vacation')
    })
  })

  describe('Google Meet and attachments', () => {
    it('requests a Meet conference and bumps conferenceDataVersion', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'meet' } })
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-4333-8444-555555555555')

      await newService().createEvent({
        summary: 'Call',
        start: START,
        end: END,
        addGoogleMeet: true
      })

      const params = api.events.insert.mock.calls[0][0]
      expect(params.conferenceDataVersion).toBe(1)
      expect(params.requestBody.conferenceData).toEqual({
        createRequest: {
          requestId: '11111111-2222-4333-8444-555555555555',
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      })
    })

    it('attaches Drive files and enables supportsAttachments', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'att' } })

      await newService().createEvent({
        summary: 'Review',
        start: START,
        end: END,
        attachments: [
          { fileUrl: 'https://drive.google.com/file/d/1', title: 'Spec', mimeType: 'application/pdf' },
          { fileUrl: 'https://drive.google.com/file/d/2' }
        ]
      })

      const params = api.events.insert.mock.calls[0][0]
      expect(params.supportsAttachments).toBe(true)
      expect(params.requestBody.attachments).toEqual([
        { fileUrl: 'https://drive.google.com/file/d/1', title: 'Spec', mimeType: 'application/pdf' },
        { fileUrl: 'https://drive.google.com/file/d/2' }
      ])
    })

    it('ignores an empty attachment list on create', async () => {
      api.events.insert.mockResolvedValue({ data: { id: 'att' } })

      await newService().createEvent({
        summary: 'Review',
        start: START,
        end: END,
        attachments: []
      })

      const params = api.events.insert.mock.calls[0][0]
      expect(params).not.toHaveProperty('supportsAttachments')
      expect(params.requestBody).not.toHaveProperty('attachments')
      expect(params).not.toHaveProperty('conferenceDataVersion')
    })
  })

  describe('validation errors', () => {
    it('requires a summary for a regular event', async () => {
      const res = await newService().createEvent({ start: START, end: END })

      expect(body(res).details).toBe('summary: summary is required for regular events')
      expect(api.events.insert).not.toHaveBeenCalled()
    })

    it('requires a summary for an explicit default event too', async () => {
      const res = await newService().createEvent({ eventType: 'default', start: START, end: END })

      expect(body(res).details).toBe('summary: summary is required for regular events')
      expect(api.events.insert).not.toHaveBeenCalled()
    })

    it('rejects an event whose start has neither dateTime nor date without calling Google', async () => {
      const res = await newService().createEvent({ summary: 'Bad', start: {}, end: END })

      expect(body(res)).toEqual({
        error: 'Invalid input format',
        details: 'start: start must have exactly one of "dateTime" (for timed events) or "date" (for all-day events)',
        help: 'Please use strict ISO 8601 format with seconds and timezone. Examples: 2024-01-15T10:30:00Z (UTC) or 2024-01-15T10:30:00-05:00 (EST)'
      })
      expect(api.events.insert).not.toHaveBeenCalled()
    })

    it('rejects a dateTime without a timezone', async () => {
      const res = await newService().createEvent({
        summary: 'Bad',
        start: { dateTime: '2026-03-02T09:00:00' },
        end: END
      })

      expect(body(res).details).toContain('Invalid ISO 8601 datetime format')
      expect(api.events.insert).not.toHaveBeenCalled()
    })

    it('points at the attendee list when an attendee email is malformed', async () => {
      const res = await newService().createEvent({
        summary: 'Bad',
        start: START,
        end: END,
        attendees: ['not-an-email']
      })

      expect(body(res)).toEqual({
        error: 'Invalid input format',
        details: '0: Invalid email format',
        help: 'Please ensure all attendee emails are in a valid format.'
      })
      expect(api.events.insert).not.toHaveBeenCalled()
    })

    it('reports an issue without a path as the bare message', async () => {
      const res = await newService().createEvent({
        summary: 'Bad',
        start: START,
        end: END,
        attendees: 'not-an-email' as any
      })

      expect(body(res).details).toBe('Invalid email format')
    })

    it('joins several validation issues with "; ", prefixing the ones that have a path', async () => {
      vi.mocked(validateCreateEventInput).mockImplementationOnce(() => {
        throw new z.ZodError([
          { code: 'custom', path: ['start', 'dateTime'], message: 'bad start' },
          { code: 'custom', path: [], message: 'general problem' }
        ])
      })

      const res = await newService().createEvent({ summary: 'Bad', start: START, end: END })

      expect(body(res)).toMatchObject({
        error: 'Invalid input format',
        details: 'start.dateTime: bad start; general problem'
      })
    })

    it('reports the Error message when validation throws a plain Error', async () => {
      vi.mocked(validateCreateEventInput).mockImplementationOnce(() => {
        throw new Error('custom validation failure')
      })

      const res = await newService().createEvent({ summary: 'Bad', start: START, end: END })

      expect(body(res).details).toBe('custom validation failure')
    })

    it('falls back to a generic message when validation throws something that is not an Error', async () => {
      vi.mocked(validateCreateEventInput).mockImplementationOnce(() => {
        throw 'nope'
      })

      const res = await newService().createEvent({ summary: 'Bad', start: START, end: END })

      expect(body(res).details).toBe('Validation failed')
      expect(api.events.insert).not.toHaveBeenCalled()
    })
  })

  describe('API errors', () => {
    const create = () => newService().createEvent({ summary: 'X', start: START, end: END })

    it('reports a Google error with its code', async () => {
      api.events.insert.mockRejectedValue(googleError({ message: 'Invalid value', code: 400 }))

      expect(body(await create())).toEqual({ error: 'Invalid value (code 400)' })
    })

    it('reports a Google error without a code', async () => {
      api.events.insert.mockRejectedValue(googleError({ message: 'Backend Error' }))

      expect(body(await create())).toEqual({ error: 'Backend Error' })
    })

    it('uses "Unknown Error" when the Google error carries no message', async () => {
      api.events.insert.mockRejectedValue(googleError({ code: 500 }))

      expect(body(await create())).toEqual({ error: 'Unknown Error (code 500)' })
    })

    it('shows a single field error once when it repeats the top-level message', async () => {
      api.events.insert.mockRejectedValue(
        googleError({
          message: 'Bad start',
          code: 400,
          errors: [
            { domain: 'global', reason: 'invalid', message: 'Bad start', locationType: 'parameter', location: 'start' }
          ]
        })
      )

      expect(body(await create())).toEqual({ error: 'global.parameter.start invalid: Bad start (code 400)' })
    })

    it('shows a single field error once when the top-level message contains it', async () => {
      api.events.insert.mockRejectedValue(
        googleError({
          message: 'Invalid value: Bad start',
          errors: [{ domain: 'global', reason: 'invalid', message: 'Bad start' }]
        })
      )

      expect(body(await create())).toEqual({ error: 'global invalid: Bad start' })
    })

    it('prefixes the top-level message when a single field error says something different', async () => {
      api.events.insert.mockRejectedValue(
        googleError({
          message: 'Invalid Value',
          code: 400,
          errors: [{ domain: 'calendar', reason: 'timeRangeEmpty', message: 'The specified time range is empty.' }]
        })
      )

      expect(body(await create())).toEqual({
        error: 'Invalid Value (code 400): calendar timeRangeEmpty: The specified time range is empty.'
      })
    })

    it('lists every field error when there are several', async () => {
      api.events.insert.mockRejectedValue(
        googleError({
          message: 'Multiple problems',
          code: 400,
          errors: [
            { domain: 'global', reason: 'required', message: 'Missing summary', location: 'summary' },
            { message: 'No reason given' }
          ]
        })
      )

      expect(body(await create())).toEqual({
        error: 'Multiple problems (code 400): global.summary required: Missing summary; No reason given'
      })
    })

    it('names the reason after the top-level message when the only field error has no message', async () => {
      api.events.insert.mockRejectedValue(
        googleError({ message: 'Not Found', code: 404, errors: [{ reason: 'notFound' }] })
      )

      expect(body(await create())).toEqual({ error: 'Not Found (code 404): notFound' })
    })

    it('leaves out a field error that has neither a message nor any context', async () => {
      api.events.insert.mockRejectedValue(
        googleError({
          message: 'Multiple problems',
          code: 400,
          errors: [{ domain: 'global', reason: 'required', message: 'Missing summary' }, {}]
        })
      )

      expect(body(await create())).toEqual({ error: 'Multiple problems (code 400): global required: Missing summary' })
    })

    it('shows only the top-level message when no field error carries anything', async () => {
      api.events.insert.mockRejectedValue(googleError({ message: 'Backend Error', code: 503, errors: [{}] }))

      expect(body(await create())).toEqual({ error: 'Backend Error (code 503)' })
    })

    it('shows only the top-level message when errors is not an array', async () => {
      api.events.insert.mockRejectedValue(googleError({ message: 'Bad Request', code: 400, errors: {} }))

      expect(body(await create())).toEqual({ error: 'Bad Request (code 400)' })
    })

    it('falls back to the Error message when the failure is not a Google error response', async () => {
      api.events.insert.mockRejectedValue(new Error('socket hang up'))

      expect(body(await create())).toEqual({ error: 'socket hang up' })
    })

    it('stringifies a rejection that is not an Error', async () => {
      api.events.insert.mockRejectedValue('weird failure')

      expect(body(await create())).toEqual({ error: 'weird failure' })
    })

    it('reports an authentication failure raised while building the client', async () => {
      h.getAuthenticatedClient.mockRejectedValue(new Error('token expired'))

      const res = await newService().createEvent({ calendarId: 'cal-1', summary: 'X', start: START, end: END })

      expect(body(res)).toEqual({ error: 'token expired' })
      expect(api.events.insert).not.toHaveBeenCalled()
    })
  })
})

describe('CalendarService.listEvents', () => {
  const FIELDS =
    'nextPageToken, items(id,summary,start,end,description,htmlLink,attendees,status,eventType,focusTimeProperties,outOfOfficeProperties,workingLocationProperties,attachments(fileId,fileUrl,title,mimeType,iconLink))'
  const ids = (res: { content: { text: string }[] }) => body(res).events.map((e: { id: string }) => e.id)

  it('requests expanded single events with the caller time window and returns them', async () => {
    api.events.list.mockResolvedValue({
      data: {
        items: [
          { id: 'e1', summary: 'Standup' },
          { id: 'e2', summary: 'Review' }
        ]
      }
    })

    const res = await newService().listEvents({
      calendarId: 'cal-1',
      timeMin: '2026-03-01T00:00:00Z',
      timeMax: '2026-03-08T00:00:00Z'
    })

    expect(api.events.list).toHaveBeenCalledWith({
      calendarId: 'cal-1',
      timeMin: '2026-03-01T00:00:00Z',
      timeMax: '2026-03-08T00:00:00Z',
      singleEvents: true,
      fields: FIELDS
    })
    expect(body(res)).toEqual({
      events: [
        { id: 'e1', summary: 'Standup' },
        { id: 'e2', summary: 'Review' }
      ],
      nextPageToken: null
    })
  })

  it('defaults the window to now through thirty days from now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-10T08:30:00.000Z'))
    api.events.list.mockResolvedValue({ data: { items: [] } })

    await newService().listEvents({ calendarId: 'cal-1' })

    expect(api.events.list).toHaveBeenCalledWith(
      expect.objectContaining({
        timeMin: '2026-01-10T08:30:00.000Z',
        timeMax: '2026-02-09T08:30:00.000Z'
      })
    )
  })

  it('looks up the primary calendar when no calendarId is given', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [{ id: 'me@x.com', primary: true }] } })
    api.events.list.mockResolvedValue({ data: { items: [] } })

    await newService().listEvents({ timeMin: '2026-03-01T00:00:00Z', timeMax: '2026-03-08T00:00:00Z' })

    expect(api.events.list).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'me@x.com' }))
  })

  describe('validation', () => {
    it('rejects a timeMin of February 30 without calling Google', async () => {
      const res = await newService().listEvents({ timeMin: '2026-02-30T00:00:00Z', timeMax: '2026-03-08T00:00:00Z' })

      expect(body(res)).toMatchObject({ error: 'Invalid input format' })
      expect(body(res).details).toContain('Invalid ISO 8601 datetime format')
      expect(api.calendarList.list).not.toHaveBeenCalled()
      expect(api.events.list).not.toHaveBeenCalled()
    })

    it('rejects a timeMax that is not ISO 8601', async () => {
      const res = await newService().listEvents({
        calendarId: 'cal-1',
        timeMin: '2026-03-01T00:00:00Z',
        timeMax: 'next week'
      })

      expect(body(res)).toMatchObject({ error: 'Invalid input format' })
      expect(api.events.list).not.toHaveBeenCalled()
    })

    it('rejects an empty timeMin instead of sending it', async () => {
      const res = await newService().listEvents({ calendarId: 'cal-1', timeMin: '', timeMax: '2026-03-08T00:00:00Z' })

      expect(body(res)).toMatchObject({ error: 'Invalid input format' })
      expect(api.events.list).not.toHaveBeenCalled()
    })

    it('rejects six fraction digits, which the shared schema does not take', async () => {
      const res = await newService().listEvents({
        calendarId: 'cal-1',
        timeMin: '2026-03-01T09:00:00.123456Z',
        timeMax: '2026-03-08T00:00:00Z'
      })

      expect(body(res)).toMatchObject({ error: 'Invalid input format' })
      expect(api.events.list).not.toHaveBeenCalled()
    })

    it('sends milliseconds and a +HH:MM or -HH:MM offset unchanged', async () => {
      api.events.list.mockResolvedValue({ data: { items: [] } })

      await newService().listEvents({
        calendarId: 'cal-1',
        timeMin: '2026-03-01T09:00:00.123+07:00',
        timeMax: '2026-03-08T09:00:00-05:00'
      })

      expect(api.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ timeMin: '2026-03-01T09:00:00.123+07:00', timeMax: '2026-03-08T09:00:00-05:00' })
      )
    })
  })

  describe('pagination (fork: maxResults/pageToken in, nextPageToken out)', () => {
    it('forwards maxResults and pageToken to the API', async () => {
      api.events.list.mockResolvedValue({ data: { items: [] } })

      await newService().listEvents({
        calendarId: 'cal-1',
        timeMin: '2026-03-01T00:00:00Z',
        timeMax: '2026-03-08T00:00:00Z',
        maxResults: 25,
        pageToken: 'cursor-2'
      })

      expect(api.events.list).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 25, pageToken: 'cursor-2' }))
    })

    it('forwards a maxResults of 0 rather than treating it as unset', async () => {
      api.events.list.mockResolvedValue({ data: { items: [] } })

      await newService().listEvents({ calendarId: 'cal-1', maxResults: 0 })

      expect(api.events.list.mock.calls[0][0].maxResults).toBe(0)
    })

    it('leaves maxResults and pageToken out of the request when not given', async () => {
      api.events.list.mockResolvedValue({ data: { items: [] } })

      await newService().listEvents({ calendarId: 'cal-1' })

      const params = api.events.list.mock.calls[0][0]
      expect(params).not.toHaveProperty('maxResults')
      expect(params).not.toHaveProperty('pageToken')
    })

    it('returns the next page cursor alongside the events', async () => {
      api.events.list.mockResolvedValue({ data: { items: [{ id: 'e1', summary: 'A' }], nextPageToken: 'cursor-3' } })

      const res = await newService().listEvents({ calendarId: 'cal-1' })

      expect(body(res)).toEqual({ events: [{ id: 'e1', summary: 'A' }], nextPageToken: 'cursor-3' })
    })

    it('returns an empty page and a null cursor when the response has no items', async () => {
      api.events.list.mockResolvedValue({ data: {} })

      const res = await newService().listEvents({ calendarId: 'cal-1' })

      expect(body(res)).toEqual({ events: [], nextPageToken: null })
    })
  })

  describe('event type filter', () => {
    it('passes a non-empty eventTypes list to the API', async () => {
      api.events.list.mockResolvedValue({ data: { items: [] } })

      await newService().listEvents({ calendarId: 'cal-1', eventTypes: ['focusTime', 'birthday'] })

      expect(api.events.list.mock.calls[0][0].eventTypes).toEqual(['focusTime', 'birthday'])
    })

    it('omits eventTypes when the list is empty or missing', async () => {
      api.events.list.mockResolvedValue({ data: { items: [] } })

      await newService().listEvents({ calendarId: 'cal-1', eventTypes: [] })
      await newService().listEvents({ calendarId: 'cal-1' })

      expect(api.events.list.mock.calls[0][0]).not.toHaveProperty('eventTypes')
      expect(api.events.list.mock.calls[1][0]).not.toHaveProperty('eventTypes')
    })
  })

  describe('result filtering', () => {
    it('drops cancelled events', async () => {
      api.events.list.mockResolvedValue({
        data: {
          items: [
            { id: 'ok', summary: 'Kept', status: 'confirmed' },
            { id: 'gone', summary: 'Dropped', status: 'cancelled' }
          ]
        }
      })

      expect(ids(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual(['ok'])
    })

    it('drops untitled events unless they have a non-default event type', async () => {
      api.events.list.mockResolvedValue({
        data: {
          items: [
            { id: 'untitled' },
            { id: 'untitled-default', eventType: 'default' },
            { id: 'ooo', eventType: 'outOfOffice' },
            { id: 'titled', summary: 'Named' }
          ]
        }
      })

      expect(ids(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual(['ooo', 'titled'])
    })

    it('keeps events without attendees', async () => {
      api.events.list.mockResolvedValue({
        data: {
          items: [
            { id: 'none', summary: 'A' },
            { id: 'empty', summary: 'B', attendees: [] }
          ]
        }
      })

      expect(ids(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual(['none', 'empty'])
    })

    it('keeps an event where the user is the only attendee, whatever their response', async () => {
      api.events.list.mockResolvedValue({
        data: { items: [{ id: 'solo', summary: 'A', attendees: [{ self: true, responseStatus: 'declined' }] }] }
      })

      expect(ids(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual(['solo'])
    })

    it('keeps an event the user is not an attendee of', async () => {
      api.events.list.mockResolvedValue({
        data: {
          items: [
            {
              id: 'other',
              summary: 'A',
              attendees: [{ email: 'a@x.com', responseStatus: 'declined' }, { email: 'b@x.com' }]
            }
          ]
        }
      })

      expect(ids(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual(['other'])
    })

    it('filters by the user response status, treating a missing status as needsAction', async () => {
      const attendees = (status?: string) => [{ email: 'o@x.com' }, { self: true, responseStatus: status }]
      api.events.list.mockResolvedValue({
        data: {
          items: [
            { id: 'accepted', summary: 'A', attendees: attendees('accepted') },
            { id: 'tentative', summary: 'B', attendees: attendees('tentative') },
            { id: 'pending', summary: 'C', attendees: attendees('needsAction') },
            { id: 'unset', summary: 'D', attendees: attendees(undefined) },
            { id: 'declined', summary: 'E', attendees: attendees('declined') }
          ]
        }
      })

      expect(ids(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual([
        'accepted',
        'tentative',
        'pending',
        'unset'
      ])
    })

    it('honours a custom attendeeResponseStatus list', async () => {
      const attendees = (status: string) => [{ email: 'o@x.com' }, { self: true, responseStatus: status }]
      api.events.list.mockResolvedValue({
        data: {
          items: [
            { id: 'accepted', summary: 'A', attendees: attendees('accepted') },
            { id: 'declined', summary: 'B', attendees: attendees('declined') }
          ]
        }
      })

      const res = await newService().listEvents({ calendarId: 'cal-1', attendeeResponseStatus: ['declined'] })

      expect(ids(res)).toEqual(['declined'])
    })
  })

  it('reports an API failure as an error', async () => {
    api.events.list.mockRejectedValue(new Error('rate limited'))

    expect(body(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual({ error: 'rate limited' })
  })

  it('stringifies a non-Error rejection', async () => {
    api.events.list.mockRejectedValue('boom')

    expect(body(await newService().listEvents({ calendarId: 'cal-1' }))).toEqual({ error: 'boom' })
  })
})

describe('CalendarService.getEvent', () => {
  it('fetches the event by id and returns its resource', async () => {
    api.events.get.mockResolvedValue({ data: { id: 'ev1', summary: 'Standup' } })

    const res = await newService().getEvent({ eventId: 'ev1', calendarId: 'cal-1' })

    expect(api.events.get).toHaveBeenCalledWith({ calendarId: 'cal-1', eventId: 'ev1' })
    expect(body(res)).toEqual({ id: 'ev1', summary: 'Standup' })
  })

  it('prefers the Google error message over the generic Error message', async () => {
    api.events.get.mockRejectedValue(googleError({ message: 'Not Found', code: 404 }))

    expect(body(await newService().getEvent({ eventId: 'missing', calendarId: 'cal-1' }))).toEqual({
      error: 'Not Found'
    })
  })

  it('falls back to the Error message', async () => {
    api.events.get.mockRejectedValue(new Error('network down'))

    expect(body(await newService().getEvent({ eventId: 'ev1', calendarId: 'cal-1' }))).toEqual({
      error: 'network down'
    })
  })

  it('stringifies a non-Error rejection', async () => {
    api.events.get.mockRejectedValue('odd')

    expect(body(await newService().getEvent({ eventId: 'ev1', calendarId: 'cal-1' }))).toEqual({ error: 'odd' })
  })
})

describe('CalendarService.deleteEvent', () => {
  it('deletes the event and confirms it by id', async () => {
    api.events.delete.mockResolvedValue({})

    const res = await newService().deleteEvent({ eventId: 'ev1', calendarId: 'cal-1' })

    expect(api.events.delete).toHaveBeenCalledWith({ calendarId: 'cal-1', eventId: 'ev1' })
    expect(body(res)).toEqual({ message: 'Successfully deleted event ev1' })
  })

  it('deletes from the primary calendar when no calendarId is given', async () => {
    api.events.delete.mockResolvedValue({})

    const res = await newService().deleteEvent({ eventId: 'ev1' })

    expect(api.events.delete).toHaveBeenCalledWith({ calendarId: PRIMARY, eventId: 'ev1' })
    expect(body(res)).toEqual({ message: 'Successfully deleted event ev1' })
  })

  it('prefers the Google error message over the generic Error message', async () => {
    api.events.delete.mockRejectedValue(googleError({ message: 'Resource has been deleted', code: 410 }))

    expect(body(await newService().deleteEvent({ eventId: 'ev1', calendarId: 'cal-1' }))).toEqual({
      error: 'Resource has been deleted'
    })
  })

  it('falls back to the Error message', async () => {
    api.events.delete.mockRejectedValue(new Error('forbidden'))

    expect(body(await newService().deleteEvent({ eventId: 'ev1', calendarId: 'cal-1' }))).toEqual({
      error: 'forbidden'
    })
  })

  it('stringifies a non-Error rejection', async () => {
    api.events.delete.mockRejectedValue('odd')

    expect(body(await newService().deleteEvent({ eventId: 'ev1', calendarId: 'cal-1' }))).toEqual({ error: 'odd' })
  })
})

describe('CalendarService.updateEvent', () => {
  it('patches only the fields the caller provided', async () => {
    api.events.patch.mockResolvedValue({ data: { id: 'ev1', summary: 'Renamed' } })

    const res = await newService().updateEvent({ eventId: 'ev1', calendarId: 'cal-1', summary: 'Renamed' })

    expect(api.events.patch).toHaveBeenCalledWith({
      calendarId: 'cal-1',
      eventId: 'ev1',
      requestBody: { summary: 'Renamed' }
    })
    expect(api.events.patch.mock.calls[0][0].requestBody).not.toHaveProperty('description')
    expect(body(res)).toEqual({ id: 'ev1', summary: 'Renamed' })
  })

  it('sends description, times and attendees when provided', async () => {
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().updateEvent({
      eventId: 'ev1',
      description: 'New notes',
      start: START,
      end: END,
      attendees: ['a@x.com']
    })

    expect(api.events.patch.mock.calls[0][0].requestBody).toEqual({
      description: 'New notes',
      start: START,
      end: END,
      attendees: [{ email: 'a@x.com' }]
    })
  })

  it('clears the description and the attendee list when given empty values', async () => {
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().updateEvent({ eventId: 'ev1', summary: '', description: '', attendees: [] })

    expect(api.events.patch.mock.calls[0][0].requestBody).toEqual({ summary: '', description: '', attendees: [] })
  })

  it('looks up the primary calendar when no calendarId is given', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [{ id: 'me@x.com', primary: true }] } })
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().updateEvent({ eventId: 'ev1', summary: 'X' })

    expect(api.events.patch).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'me@x.com' }))
  })

  it('adds a Meet conference when asked', async () => {
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().updateEvent({ eventId: 'ev1', addGoogleMeet: true })

    const params = api.events.patch.mock.calls[0][0]
    expect(params.conferenceDataVersion).toBe(1)
    expect(params.requestBody.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' })
  })

  it('replaces attachments with the given list', async () => {
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().updateEvent({
      eventId: 'ev1',
      attachments: [{ fileUrl: 'https://drive.google.com/file/d/1', title: 'Spec' }]
    })

    const params = api.events.patch.mock.calls[0][0]
    expect(params.supportsAttachments).toBe(true)
    expect(params.requestBody.attachments).toEqual([{ fileUrl: 'https://drive.google.com/file/d/1', title: 'Spec' }])
  })

  it('removes every attachment when given an empty list (unlike create)', async () => {
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().updateEvent({ eventId: 'ev1', attachments: [] })

    const params = api.events.patch.mock.calls[0][0]
    expect(params.supportsAttachments).toBe(true)
    expect(params.requestBody.attachments).toEqual([])
  })

  it('leaves attachments and conference data untouched when neither is given', async () => {
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().updateEvent({ eventId: 'ev1', summary: 'X' })

    const params = api.events.patch.mock.calls[0][0]
    expect(params).not.toHaveProperty('supportsAttachments')
    expect(params).not.toHaveProperty('conferenceDataVersion')
    expect(params.requestBody).not.toHaveProperty('attachments')
  })

  it('rejects a start with both dateTime and date without calling Google', async () => {
    const res = await newService().updateEvent({
      eventId: 'ev1',
      start: { dateTime: '2026-03-02T09:00:00Z', date: '2026-03-02' }
    })

    expect(body(res)).toMatchObject({ error: 'Invalid input format' })
    expect(body(res).details).toContain('start must have exactly one of')
    expect(api.events.patch).not.toHaveBeenCalled()
  })

  it('rejects a malformed attendee email with the attendee help text', async () => {
    const res = await newService().updateEvent({ eventId: 'ev1', attendees: ['nope'] })

    expect(body(res).help).toBe('Please ensure all attendee emails are in a valid format.')
    expect(api.events.patch).not.toHaveBeenCalled()
  })

  it('falls back to a generic message when validation throws something that is not an Error', async () => {
    vi.mocked(validateUpdateEventInput).mockImplementationOnce(() => {
      throw 42
    })

    const res = await newService().updateEvent({ eventId: 'ev1', summary: 'X' })

    expect(body(res).details).toBe('Validation failed')
  })

  it('reports the Error message when validation throws a plain Error', async () => {
    vi.mocked(validateUpdateEventInput).mockImplementationOnce(() => {
      throw new Error('custom validation failure')
    })

    const res = await newService().updateEvent({ eventId: 'ev1', summary: 'X' })

    expect(body(res).details).toBe('custom validation failure')
  })

  it('formats a Google API error with its field errors', async () => {
    api.events.patch.mockRejectedValue(
      googleError({
        message: 'Invalid Value',
        code: 400,
        errors: [{ domain: 'calendar', reason: 'timeRangeEmpty', message: 'The specified time range is empty.' }]
      })
    )

    const res = await newService().updateEvent({ eventId: 'ev1', summary: 'X' })

    expect(body(res)).toEqual({
      error: 'Invalid Value (code 400): calendar timeRangeEmpty: The specified time range is empty.'
    })
  })
})

describe('CalendarService.respondToEvent', () => {
  const eventWithSelf = () => ({
    data: {
      id: 'ev1',
      attendees: [
        { email: 'org@x.com', responseStatus: 'accepted' },
        { email: 'me@x.com', self: true, responseStatus: 'needsAction' }
      ]
    }
  })

  it('updates only the user attendee entry and notifies by default', async () => {
    api.events.get.mockResolvedValue(eventWithSelf())
    api.events.patch.mockResolvedValue({ data: { id: 'ev1', summary: 'Planning' } })

    const res = await newService().respondToEvent({ eventId: 'ev1', calendarId: 'cal-1', responseStatus: 'accepted' })

    expect(api.events.get).toHaveBeenCalledWith({ calendarId: 'cal-1', eventId: 'ev1' })
    expect(api.events.patch).toHaveBeenCalledWith({
      calendarId: 'cal-1',
      eventId: 'ev1',
      sendNotifications: true,
      requestBody: {
        attendees: [
          { email: 'org@x.com', responseStatus: 'accepted' },
          { email: 'me@x.com', self: true, responseStatus: 'accepted' }
        ]
      }
    })
    expect(body(res)).toEqual({
      eventId: 'ev1',
      summary: 'Planning',
      responseStatus: 'accepted',
      message: 'Successfully accepted the meeting invitation'
    })
  })

  it('attaches the response message as a comment and says so', async () => {
    api.events.get.mockResolvedValue(eventWithSelf())
    api.events.patch.mockResolvedValue({ data: { id: 'ev1', summary: 'Planning' } })

    const res = await newService().respondToEvent({
      eventId: 'ev1',
      responseStatus: 'declined',
      responseMessage: 'Clash with another meeting'
    })

    const sent = api.events.patch.mock.calls[0][0].requestBody.attendees
    expect(sent[1]).toEqual({
      email: 'me@x.com',
      self: true,
      responseStatus: 'declined',
      comment: 'Clash with another meeting'
    })
    expect(body(res).message).toBe('Successfully declined the meeting invitation with message')
  })

  it('does not set a comment when no response message is given', async () => {
    api.events.get.mockResolvedValue(eventWithSelf())
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().respondToEvent({ eventId: 'ev1', responseStatus: 'tentative' })

    expect(api.events.patch.mock.calls[0][0].requestBody.attendees[1]).not.toHaveProperty('comment')
  })

  it('can respond without notifying the organizer', async () => {
    api.events.get.mockResolvedValue(eventWithSelf())
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().respondToEvent({
      eventId: 'ev1',
      responseStatus: 'accepted',
      sendNotification: false
    })

    expect(api.events.patch).toHaveBeenCalledWith(expect.objectContaining({ sendNotifications: false }))
  })

  it('looks up the primary calendar when no calendarId is given', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [{ id: 'me@x.com', primary: true }] } })
    api.events.get.mockResolvedValue(eventWithSelf())
    api.events.patch.mockResolvedValue({ data: { id: 'ev1' } })

    await newService().respondToEvent({ eventId: 'ev1', responseStatus: 'accepted' })

    expect(api.events.get).toHaveBeenCalledWith({ calendarId: 'me@x.com', eventId: 'ev1' })
  })

  it('refuses an event without attendees and does not patch', async () => {
    api.events.get.mockResolvedValue({ data: { id: 'ev1' } })

    const res = await newService().respondToEvent({ eventId: 'ev1', responseStatus: 'accepted' })

    expect(body(res)).toEqual({ error: 'Event has no attendees' })
    expect(api.events.patch).not.toHaveBeenCalled()
  })

  it('refuses an event with an empty attendee list', async () => {
    api.events.get.mockResolvedValue({ data: { id: 'ev1', attendees: [] } })

    const res = await newService().respondToEvent({ eventId: 'ev1', responseStatus: 'accepted' })

    expect(body(res)).toEqual({ error: 'Event has no attendees' })
    expect(api.events.patch).not.toHaveBeenCalled()
  })

  it('refuses an event the user is not invited to and does not patch', async () => {
    api.events.get.mockResolvedValue({
      data: { id: 'ev1', attendees: [{ email: 'org@x.com' }, { email: 'other@x.com', self: false }] }
    })

    const res = await newService().respondToEvent({ eventId: 'ev1', responseStatus: 'accepted' })

    expect(body(res)).toEqual({ error: 'You are not an attendee of this event' })
    expect(api.events.patch).not.toHaveBeenCalled()
  })

  it('reports a failure to read the event', async () => {
    api.events.get.mockRejectedValue(new Error('event not found'))

    const res = await newService().respondToEvent({ eventId: 'ev1', responseStatus: 'accepted' })

    expect(body(res)).toEqual({ error: 'event not found' })
    expect(api.events.patch).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error rejection from the patch call', async () => {
    api.events.get.mockResolvedValue(eventWithSelf())
    api.events.patch.mockRejectedValue('patch failed')

    const res = await newService().respondToEvent({ eventId: 'ev1', responseStatus: 'accepted' })

    expect(body(res)).toEqual({ error: 'patch failed' })
  })
})

describe('CalendarService.findFreeTime', () => {
  const TIME_MIN = '2026-03-02T09:00:00Z'
  const TIME_MAX = '2026-03-02T17:00:00Z'
  const busyFor = (...busy: { start?: string; end?: string }[]) => ({
    data: { calendars: { 'a@x.com': { busy } } }
  })
  const find = (duration: number, timeMin = TIME_MIN, timeMax = TIME_MAX) =>
    newService().findFreeTime({ attendees: ['a@x.com'], timeMin, timeMax, duration })

  it('queries free/busy for every attendee over the window', async () => {
    api.freebusy.query.mockResolvedValue(busyFor())

    await newService().findFreeTime({
      attendees: ['a@x.com', 'b@x.com'],
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
      duration: 30
    })

    expect(api.freebusy.query).toHaveBeenCalledWith({
      requestBody: { items: [{ id: 'a@x.com' }, { id: 'b@x.com' }], timeMin: TIME_MIN, timeMax: TIME_MAX }
    })
  })

  it('resolves the attendee "me" to the primary calendar id', async () => {
    api.calendarList.list.mockResolvedValue({ data: { items: [{ id: 'me@x.com', primary: true }] } })
    api.freebusy.query.mockResolvedValue(busyFor())

    await newService().findFreeTime({
      attendees: ['me', 'b@x.com'],
      timeMin: TIME_MIN,
      timeMax: TIME_MAX,
      duration: 30
    })

    expect(api.freebusy.query.mock.calls[0][0].requestBody.items).toEqual([{ id: 'me@x.com' }, { id: 'b@x.com' }])
  })

  describe('validation', () => {
    it('rejects a timeMin that is not ISO 8601 without calling Google', async () => {
      const res = await find(30, 'tomorrow')

      expect(body(res)).toMatchObject({ error: 'Invalid input format' })
      expect(body(res).details).toContain('Invalid ISO 8601 datetime format')
      expect(api.freebusy.query).not.toHaveBeenCalled()
    })

    it('rejects a timeMax without a timezone', async () => {
      const res = await find(30, TIME_MIN, '2026-03-02T17:00:00')

      expect(body(res)).toMatchObject({ error: 'Invalid input format' })
      expect(api.freebusy.query).not.toHaveBeenCalled()
    })

    it('rejects a well-formed timestamp that is not a real date', async () => {
      const res = await find(30, '2026-13-45T09:00:00Z')

      expect(body(res).error).toBe('Invalid input format')
      expect(api.freebusy.query).not.toHaveBeenCalled()
    })
  })

  describe('with no busy time', () => {
    it('offers the start of the window when every calendar is free', async () => {
      api.freebusy.query.mockResolvedValue(busyFor())

      expect(body(await find(30))).toEqual({ start: TIME_MIN, end: '2026-03-02T09:30:00.000Z' })
    })

    it('offers the start of the window when the response has no calendars', async () => {
      api.freebusy.query.mockResolvedValue({ data: {} })

      expect(body(await find(45))).toEqual({ start: TIME_MIN, end: '2026-03-02T09:45:00.000Z' })
    })

    it('treats a calendar without a busy list as free', async () => {
      api.freebusy.query.mockResolvedValue({ data: { calendars: { 'a@x.com': {} } } })

      expect(body(await find(30))).toEqual({ start: TIME_MIN, end: '2026-03-02T09:30:00.000Z' })
    })

    it('computes the slot end from a timeMin carrying a UTC offset (Date.parse)', async () => {
      api.freebusy.query.mockResolvedValue(busyFor())

      const res = await find(90, '2026-03-02T09:00:00+07:00', '2026-03-02T17:00:00+07:00')

      expect(body(res)).toEqual({ start: '2026-03-02T09:00:00+07:00', end: '2026-03-02T03:30:00.000Z' })
    })

    it('treats busy entries missing a start or an end as no busy time', async () => {
      api.freebusy.query.mockResolvedValue(
        busyFor({ start: '2026-03-02T10:00:00Z' }, { end: '2026-03-02T11:00:00Z' }, {})
      )

      expect(body(await find(30))).toEqual({ start: TIME_MIN, end: '2026-03-02T09:30:00.000Z' })
    })
  })

  describe('with busy time', () => {
    it('offers the start of the window when the meeting fits before the first busy slot', async () => {
      api.freebusy.query.mockResolvedValue(busyFor({ start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z' }))

      expect(body(await find(30))).toEqual({ start: TIME_MIN, end: '2026-03-02T09:30:00.000Z' })
    })

    it('offers the start of the window when the meeting ends exactly as the first busy slot starts', async () => {
      api.freebusy.query.mockResolvedValue(busyFor({ start: '2026-03-02T09:30:00Z', end: '2026-03-02T11:00:00Z' }))

      expect(body(await find(30))).toEqual({ start: TIME_MIN, end: '2026-03-02T09:30:00.000Z' })
    })

    it('offers the first gap between busy slots that is long enough', async () => {
      api.freebusy.query.mockResolvedValue(
        busyFor(
          { start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' },
          { start: '2026-03-02T10:30:00Z', end: '2026-03-02T12:00:00Z' }
        )
      )

      expect(body(await find(30))).toEqual({
        start: '2026-03-02T10:00:00.000Z',
        end: '2026-03-02T10:30:00.000Z'
      })
    })

    it('skips a gap that is too short and takes the next one', async () => {
      api.freebusy.query.mockResolvedValue(
        busyFor(
          { start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' },
          { start: '2026-03-02T10:15:00Z', end: '2026-03-02T11:00:00Z' },
          { start: '2026-03-02T12:00:00Z', end: '2026-03-02T13:00:00Z' }
        )
      )

      expect(body(await find(30))).toEqual({
        start: '2026-03-02T11:00:00.000Z',
        end: '2026-03-02T11:30:00.000Z'
      })
    })

    it('offers the time right after the last busy slot when no earlier gap fits', async () => {
      api.freebusy.query.mockResolvedValue(busyFor({ start: '2026-03-02T09:00:00Z', end: '2026-03-02T16:00:00Z' }))

      expect(body(await find(60))).toEqual({
        start: '2026-03-02T16:00:00.000Z',
        end: '2026-03-02T17:00:00.000Z'
      })
    })

    it('merges overlapping, adjacent and nested busy slots given out of order', async () => {
      api.freebusy.query.mockResolvedValue(
        busyFor(
          { start: '2026-03-02T11:00:00Z', end: '2026-03-02T12:00:00Z' },
          { start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:30:00Z' },
          { start: '2026-03-02T09:30:00Z', end: '2026-03-02T10:00:00Z' },
          { start: '2026-03-02T10:00:00Z', end: '2026-03-02T11:00:00Z' }
        )
      )

      expect(body(await find(30))).toEqual({
        start: '2026-03-02T12:00:00.000Z',
        end: '2026-03-02T12:30:00.000Z'
      })
    })

    it('merges the busy slots of several calendars', async () => {
      api.freebusy.query.mockResolvedValue({
        data: {
          calendars: {
            'a@x.com': { busy: [{ start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' }] },
            'b@x.com': { busy: [{ start: '2026-03-02T09:30:00Z', end: '2026-03-02T11:00:00Z' }] }
          }
        }
      })

      expect(body(await find(30))).toEqual({
        start: '2026-03-02T11:00:00.000Z',
        end: '2026-03-02T11:30:00.000Z'
      })
    })

    it('ignores busy entries that lack a start or an end', async () => {
      api.freebusy.query.mockResolvedValue(
        busyFor({ start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' }, { start: '2026-03-02T10:00:00Z' })
      )

      expect(body(await find(30))).toEqual({
        start: '2026-03-02T10:00:00.000Z',
        end: '2026-03-02T10:30:00.000Z'
      })
    })

    it('orders busy slots by instant, not by text, when they carry different UTC offsets (Date.parse)', async () => {
      // 09:00+07:00 is 02:00Z: earlier than 04:00Z although its text sorts after "2026-03-02T04:00:00Z".
      api.freebusy.query.mockResolvedValue(
        busyFor(
          { start: '2026-03-02T04:00:00Z', end: '2026-03-02T05:00:00Z' },
          { start: '2026-03-02T09:00:00+07:00', end: '2026-03-02T10:00:00+07:00' }
        )
      )

      const res = await find(30, '2026-03-02T01:45:00Z', '2026-03-02T10:00:00Z')

      expect(body(res)).toEqual({ start: '2026-03-02T03:00:00.000Z', end: '2026-03-02T03:30:00.000Z' })
    })

    it('reports no availability when the window is fully booked', async () => {
      api.freebusy.query.mockResolvedValue(busyFor({ start: '2026-03-02T08:00:00Z', end: '2026-03-02T18:00:00Z' }))

      expect(body(await find(30))).toEqual({ error: 'No available free time found' })
    })

    it('reports no availability when no gap and no tail is long enough', async () => {
      api.freebusy.query.mockResolvedValue(
        busyFor(
          { start: '2026-03-02T09:00:00Z', end: '2026-03-02T12:00:00Z' },
          { start: '2026-03-02T12:30:00Z', end: '2026-03-02T17:00:00Z' }
        )
      )

      expect(body(await find(60))).toEqual({ error: 'No available free time found' })
    })

    it('does not offer a slot that would run past the end of the window', async () => {
      api.freebusy.query.mockResolvedValue(busyFor({ start: '2026-03-02T09:00:00Z', end: '2026-03-02T16:30:00Z' }))

      expect(body(await find(60))).toEqual({ error: 'No available free time found' })
    })
  })

  describe('unparseable busy timestamps (Date.parse yields NaN)', () => {
    it('reports no availability instead of throwing on an invalid time value', async () => {
      api.freebusy.query.mockResolvedValue(busyFor({ start: 'not-a-date', end: 'also-not-a-date' }))

      expect(body(await find(30))).toEqual({ error: 'No available free time found' })
    })

    it('never offers a slot after a busy entry whose end is unparseable', async () => {
      // 09:00 + 120 min overruns the 09:30 start, so only the (NaN) end of the busy entry could free a slot.
      api.freebusy.query.mockResolvedValue(busyFor({ start: '2026-03-02T09:30:00Z', end: 'garbage' }))

      expect(body(await find(120))).toEqual({ error: 'No available free time found' })
    })
  })

  describe('API errors', () => {
    it('reports the Error message when the free/busy query fails', async () => {
      api.freebusy.query.mockRejectedValue(new Error('freebusy unavailable'))

      expect(body(await find(30))).toEqual({ error: 'freebusy unavailable' })
    })

    it('stringifies a non-Error rejection', async () => {
      api.freebusy.query.mockRejectedValue('odd')

      expect(body(await find(30))).toEqual({ error: 'odd' })
    })

    it('reports a failure to resolve the primary calendar for "me"', async () => {
      api.calendarList.list.mockRejectedValue(new Error('calendar list down'))

      const res = await newService().findFreeTime({
        attendees: ['me'],
        timeMin: TIME_MIN,
        timeMax: TIME_MAX,
        duration: 30
      })

      expect(body(res)).toEqual({ error: 'calendar list down' })
      expect(api.freebusy.query).not.toHaveBeenCalled()
    })
  })
})
