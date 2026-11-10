import { CalendarService } from '../../vendored/services/CalendarService.js'
import { CALENDAR_BOUNDS } from './bounds.js'
import { makeDomainRun } from './factory.js'

export const CALENDAR_ACTIONS = [
  'listCalendars',
  'createEvent',
  'listEvents',
  'getEvent',
  'deleteEvent',
  'updateEvent',
  'respondToEvent',
  'findFreeTime'
] as const
export const calendar = makeDomainRun(CalendarService, CALENDAR_ACTIONS, {
  pagination: { listEvents: 'maxResults' },
  bounds: CALENDAR_BOUNDS
})
