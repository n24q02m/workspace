import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { validateCreateEventInput, validateUpdateEventInput } from './CalendarValidation.js'

const START = { dateTime: '2026-03-02T09:00:00Z' }
const END = { dateTime: '2026-03-02T10:00:00Z' }

const EXACTLY_ONE = (field: 'start' | 'end') =>
  `${field} must have exactly one of "dateTime" (for timed events) or "date" (for all-day events)`
const BAD_DATETIME = 'Invalid ISO 8601 datetime format. Expected format: YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]'
const BAD_DATE = 'Invalid date format. Expected YYYY-MM-DD'

/** Runs a validator and returns the issues of the ZodError it throws; fails if it does not throw one. */
function issuesOf(run: () => void): { path: PropertyKey[]; message: string }[] {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(z.ZodError)
    return (error as z.ZodError).issues.map((issue) => ({ path: issue.path, message: issue.message }))
  }
  throw new Error('expected the validator to throw')
}

describe('validateCreateEventInput', () => {
  describe('accepted input', () => {
    it('accepts a timed event with a summary', () => {
      expect(() => validateCreateEventInput({ summary: 'Standup', start: START, end: END })).not.toThrow()
    })

    it('accepts an all-day event', () => {
      expect(() =>
        validateCreateEventInput({ summary: 'Holiday', start: { date: '2026-03-02' }, end: { date: '2026-03-03' } })
      ).not.toThrow()
    })

    it('accepts fractional seconds and numeric UTC offsets', () => {
      expect(() =>
        validateCreateEventInput({
          summary: 'Call',
          start: { dateTime: '2026-03-02T09:00:00.000+07:00' },
          end: { dateTime: '2026-03-02T10:00:00.500-05:30' }
        })
      ).not.toThrow()
    })

    it('accepts a leap day', () => {
      expect(() =>
        validateCreateEventInput({ summary: 'Leap', start: { date: '2024-02-29' }, end: { date: '2024-03-01' } })
      ).not.toThrow()
    })

    it('accepts typed events without a summary', () => {
      for (const eventType of ['focusTime', 'outOfOffice'] as const) {
        expect(() => validateCreateEventInput({ eventType, start: START, end: END })).not.toThrow()
      }
    })

    it('accepts valid attendees, an empty attendee list, and no attendees', () => {
      const base = { summary: 'Sync', start: START, end: END }
      expect(() => validateCreateEventInput({ ...base, attendees: ['a@x.com', 'b@example.org'] })).not.toThrow()
      expect(() => validateCreateEventInput({ ...base, attendees: [] })).not.toThrow()
      expect(() => validateCreateEventInput({ ...base })).not.toThrow()
    })
  })

  describe('start and end must each carry exactly one of dateTime or date', () => {
    it('rejects a start with neither field', () => {
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start: {}, end: END }))).toEqual([
        { path: ['start'], message: EXACTLY_ONE('start') }
      ])
    })

    it('rejects an end with neither field', () => {
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start: START, end: {} }))).toEqual([
        { path: ['end'], message: EXACTLY_ONE('end') }
      ])
    })

    it('rejects a start with both fields', () => {
      const start = { dateTime: '2026-03-02T09:00:00Z', date: '2026-03-02' }
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start, end: END }))).toEqual([
        { path: ['start'], message: EXACTLY_ONE('start') }
      ])
    })

    it('rejects an end with both fields', () => {
      const end = { dateTime: '2026-03-02T10:00:00Z', date: '2026-03-02' }
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start: START, end }))).toEqual([
        { path: ['end'], message: EXACTLY_ONE('end') }
      ])
    })

    it('treats null and empty-string fields as missing', () => {
      const nulls = { dateTime: null, date: null } as any
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start: nulls, end: END }))).toEqual([
        { path: ['start'], message: EXACTLY_ONE('start') }
      ])
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start: { dateTime: '' }, end: END }))).toEqual([
        { path: ['start'], message: EXACTLY_ONE('start') }
      ])
    })

    it('reports the start problem before the end problem', () => {
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start: {}, end: {} }))[0].path).toEqual(['start'])
    })
  })

  describe('date and dateTime formats', () => {
    it.each([
      ['no timezone', '2026-03-02T09:00:00'],
      ['no seconds', '2026-03-02T09:00Z'],
      ['space instead of T', '2026-03-02 09:00:00Z'],
      ['two-digit milliseconds', '2026-03-02T09:00:00.12Z'],
      ['date only', '2026-03-02'],
      ['impossible month', '2026-13-45T09:00:00Z'],
      ['impossible hour', '2026-03-02T25:00:00Z']
    ])('rejects a dateTime with %s', (_label, dateTime) => {
      expect(issuesOf(() => validateCreateEventInput({ summary: 'X', start: { dateTime }, end: END }))).toEqual([
        { path: [], message: BAD_DATETIME }
      ])
    })

    it('rejects a malformed end dateTime', () => {
      expect(
        issuesOf(() => validateCreateEventInput({ summary: 'X', start: START, end: { dateTime: 'soon' } }))
      ).toEqual([{ path: [], message: BAD_DATETIME }])
    })

    it.each([
      ['single-digit month and day', '2026-3-2'],
      ['a time component', '2026-03-02T00:00:00Z'],
      ['month 13 (Date.parse gives NaN)', '2026-13-01'],
      ['month 00 (Date.parse gives NaN)', '2026-00-10'],
      ['day 32 (Date.parse gives NaN)', '2026-01-32'],
      ['a day that rolls into the next month (Feb 30)', '2026-02-30'],
      ['Feb 29 of a non-leap year', '2026-02-29'],
      ['April 31', '2026-04-31']
    ])('rejects an all-day date with %s', (_label, date) => {
      expect(
        issuesOf(() => validateCreateEventInput({ summary: 'X', start: { date }, end: { date: '2026-12-31' } }))
      ).toEqual([{ path: [], message: BAD_DATE }])
    })

    it('rejects a malformed all-day end date', () => {
      expect(
        issuesOf(() =>
          validateCreateEventInput({ summary: 'X', start: { date: '2026-03-02' }, end: { date: '2026-02-30' } })
        )
      ).toEqual([{ path: [], message: BAD_DATE }])
    })

    it('accepts the last day of a month and of a year', () => {
      expect(() =>
        validateCreateEventInput({ summary: 'X', start: { date: '2026-04-30' }, end: { date: '2026-12-31' } })
      ).not.toThrow()
    })

    it('checks the format before the summary', () => {
      const issues = issuesOf(() => validateCreateEventInput({ start: { dateTime: 'bad' }, end: END }))
      expect(issues).toEqual([{ path: [], message: BAD_DATETIME }])
    })
  })

  describe('summary', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['null', null]
    ])('is required for a regular event when it is %s', (_label, summary) => {
      expect(issuesOf(() => validateCreateEventInput({ summary: summary as any, start: START, end: END }))).toEqual([
        { path: ['summary'], message: 'summary is required for regular events' }
      ])
    })

    it('is required for an explicit default event', () => {
      expect(issuesOf(() => validateCreateEventInput({ eventType: 'default', start: START, end: END }))).toEqual([
        { path: ['summary'], message: 'summary is required for regular events' }
      ])
    })
  })

  describe('focus-time and out-of-office events', () => {
    it.each(['focusTime', 'outOfOffice'] as const)('%s cannot be all-day: both dates', (eventType) => {
      expect(
        issuesOf(() =>
          validateCreateEventInput({ eventType, start: { date: '2026-03-02' }, end: { date: '2026-03-03' } })
        )
      ).toEqual([
        {
          path: ['start', 'end'],
          message: `${eventType} events cannot be all-day events; use dateTime instead of date`
        }
      ])
    })

    it('rejects a timed start paired with an all-day end', () => {
      expect(
        issuesOf(() => validateCreateEventInput({ eventType: 'focusTime', start: START, end: { date: '2026-03-03' } }))
      ).toEqual([
        { path: ['start', 'end'], message: 'focusTime events cannot be all-day events; use dateTime instead of date' }
      ])
    })

    it('rejects an all-day start paired with a timed end', () => {
      expect(
        issuesOf(() => validateCreateEventInput({ eventType: 'outOfOffice', start: { date: '2026-03-02' }, end: END }))
      ).toEqual([
        { path: ['start', 'end'], message: 'outOfOffice events cannot be all-day events; use dateTime instead of date' }
      ])
    })
  })

  describe('working-location events', () => {
    const allDay = { start: { date: '2026-03-02' }, end: { date: '2026-03-03' } }

    it('requires workingLocationProperties', () => {
      const expected = [
        {
          path: ['workingLocationProperties'],
          message: 'workingLocationProperties is required when eventType is "workingLocation"'
        }
      ]
      expect(issuesOf(() => validateCreateEventInput({ eventType: 'workingLocation', ...allDay }))).toEqual(expected)
      expect(
        issuesOf(() =>
          validateCreateEventInput({ eventType: 'workingLocation', ...allDay, workingLocationProperties: null as any })
        )
      ).toEqual(expected)
    })

    it('requires officeLocation for an office working location', () => {
      expect(
        issuesOf(() =>
          validateCreateEventInput({
            eventType: 'workingLocation',
            ...allDay,
            workingLocationProperties: { type: 'officeLocation' }
          })
        )
      ).toEqual([
        {
          path: ['workingLocationProperties', 'officeLocation'],
          message: 'officeLocation is required when workingLocationProperties.type is "officeLocation"'
        }
      ])
    })

    it('requires customLocation for a custom working location', () => {
      expect(
        issuesOf(() =>
          validateCreateEventInput({
            eventType: 'workingLocation',
            ...allDay,
            workingLocationProperties: { type: 'customLocation' }
          })
        )
      ).toEqual([
        {
          path: ['workingLocationProperties', 'customLocation'],
          message: 'customLocation is required when workingLocationProperties.type is "customLocation"'
        }
      ])
    })

    it('accepts each working location type with its details', () => {
      const run = (workingLocationProperties: any) =>
        validateCreateEventInput({ eventType: 'workingLocation', ...allDay, workingLocationProperties })
      expect(() => run({ type: 'homeOffice' })).not.toThrow()
      expect(() => run({ type: 'officeLocation', officeLocation: { label: 'HQ' } })).not.toThrow()
      expect(() => run({ type: 'customLocation', customLocation: { label: 'Cafe' } })).not.toThrow()
    })

    it('accepts a timed working location without the one-day rule', () => {
      expect(() =>
        validateCreateEventInput({
          eventType: 'workingLocation',
          start: START,
          end: { dateTime: '2026-03-05T10:00:00Z' },
          workingLocationProperties: { type: 'homeOffice' }
        })
      ).not.toThrow()
    })

    it('skips the one-day rule when only one side is all-day', () => {
      expect(() =>
        validateCreateEventInput({
          eventType: 'workingLocation',
          start: { date: '2026-03-02' },
          end: END,
          workingLocationProperties: { type: 'homeOffice' }
        })
      ).not.toThrow()
    })

    it('rejects an all-day working location that ends before it starts', () => {
      expect(
        issuesOf(() =>
          validateCreateEventInput({
            eventType: 'workingLocation',
            start: { date: '2026-03-02' },
            end: { date: '2026-03-01' },
            workingLocationProperties: { type: 'homeOffice' }
          })
        )
      ).toEqual([{ path: ['start', 'end'], message: 'end.date must be on or after start.date' }])
    })

    it.each([
      ['ends the same day it starts', '2026-03-02', '2026-03-02'],
      ['spans two days', '2026-03-02', '2026-03-04']
    ])('rejects an all-day working location that %s', (_label, start, end) => {
      expect(
        issuesOf(() =>
          validateCreateEventInput({
            eventType: 'workingLocation',
            start: { date: start },
            end: { date: end },
            workingLocationProperties: { type: 'homeOffice' }
          })
        )
      ).toEqual([{ path: ['start', 'end'], message: 'all-day workingLocation events must span exactly one day' }])
    })

    it.each([
      ['a month boundary', '2026-03-31', '2026-04-01'],
      ['a year boundary', '2026-12-31', '2027-01-01'],
      ['a leap day', '2024-02-28', '2024-02-29'],
      ['the day after a leap day', '2024-02-29', '2024-03-01'],
      ['February in a non-leap year', '2026-02-28', '2026-03-01']
    ])('accepts a one-day all-day working location across %s', (_label, start, end) => {
      expect(() =>
        validateCreateEventInput({
          eventType: 'workingLocation',
          start: { date: start },
          end: { date: end },
          workingLocationProperties: { type: 'homeOffice' }
        })
      ).not.toThrow()
    })
  })

  describe('attendees', () => {
    it('rejects a malformed email and names the offending position', () => {
      expect(
        issuesOf(() =>
          validateCreateEventInput({ summary: 'X', start: START, end: END, attendees: ['a@x.com', 'not-an-email'] })
        )
      ).toEqual([{ path: [1], message: 'Invalid email format' }])
    })

    it('rejects an attendee value that is a bare invalid string', () => {
      expect(
        issuesOf(() => validateCreateEventInput({ summary: 'X', start: START, end: END, attendees: 'nope' as any }))
      ).toEqual([{ path: [], message: 'Invalid email format' }])
    })

    it('checks attendees after the date and summary rules', () => {
      const issues = issuesOf(() => validateCreateEventInput({ start: START, end: END, attendees: ['nope'] }))
      expect(issues).toEqual([{ path: ['summary'], message: 'summary is required for regular events' }])
    })
  })
})

describe('validateUpdateEventInput', () => {
  it('accepts an update that changes nothing about time or attendees', () => {
    expect(() => validateUpdateEventInput({ eventId: 'ev1' })).not.toThrow()
    expect(() => validateUpdateEventInput({ eventId: 'ev1', summary: '', description: 'x' })).not.toThrow()
  })

  it('accepts valid timed, all-day and attendee changes', () => {
    expect(() => validateUpdateEventInput({ eventId: 'ev1', start: START, end: END })).not.toThrow()
    expect(() =>
      validateUpdateEventInput({ eventId: 'ev1', start: { date: '2026-03-02' }, end: { date: '2026-03-03' } })
    ).not.toThrow()
    expect(() => validateUpdateEventInput({ eventId: 'ev1', attendees: ['a@x.com'] })).not.toThrow()
    expect(() => validateUpdateEventInput({ eventId: 'ev1', attendees: [] })).not.toThrow()
  })

  it('accepts changing only the start or only the end', () => {
    expect(() => validateUpdateEventInput({ eventId: 'ev1', start: START })).not.toThrow()
    expect(() => validateUpdateEventInput({ eventId: 'ev1', end: END })).not.toThrow()
  })

  it('rejects a start with neither field', () => {
    expect(issuesOf(() => validateUpdateEventInput({ eventId: 'ev1', start: {} }))).toEqual([
      { path: ['start'], message: EXACTLY_ONE('start') }
    ])
  })

  it('rejects an end with both fields', () => {
    expect(
      issuesOf(() =>
        validateUpdateEventInput({ eventId: 'ev1', end: { dateTime: '2026-03-02T10:00:00Z', date: '2026-03-02' } })
      )
    ).toEqual([{ path: ['end'], message: EXACTLY_ONE('end') }])
  })

  it('rejects a malformed start dateTime and a malformed end dateTime', () => {
    expect(issuesOf(() => validateUpdateEventInput({ eventId: 'ev1', start: { dateTime: '2026-03-02' } }))).toEqual([
      { path: [], message: BAD_DATETIME }
    ])
    expect(issuesOf(() => validateUpdateEventInput({ eventId: 'ev1', end: { dateTime: 'later' } }))).toEqual([
      { path: [], message: BAD_DATETIME }
    ])
  })

  it('rejects a malformed start date and a malformed end date', () => {
    expect(issuesOf(() => validateUpdateEventInput({ eventId: 'ev1', start: { date: '2026-02-30' } }))).toEqual([
      { path: [], message: BAD_DATE }
    ])
    expect(issuesOf(() => validateUpdateEventInput({ eventId: 'ev1', end: { date: '2026-13-01' } }))).toEqual([
      { path: [], message: BAD_DATE }
    ])
  })

  it('rejects a malformed attendee email', () => {
    expect(issuesOf(() => validateUpdateEventInput({ eventId: 'ev1', attendees: ['nope'] }))).toEqual([
      { path: [0], message: 'Invalid email format' }
    ])
  })
})
