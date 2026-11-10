/**
 * Per-action response bounds for every Google read whose payload can grow.
 *
 * Each entry names how much of a response the tool keeps by default. The
 * dispatch factory (`factory.ts`) applies them: the caller raises the
 * character budget with `max_chars` (1-100,000), removes both budgets with
 * `full: true`, and a truncated payload always carries a marker naming its
 * true size and the way to fetch the rest.
 *
 * Two shapes of bounded payload:
 *
 * - `textRead` -- a body of text or one large object (a document, a message, a
 *   presentation's text). Only characters are capped, because there is no list
 *   to page through.
 * - `listRead` -- a listing array with no pagination cursor (slide and notes
 *   arrays, calendars, labels, folder matches, a person's relations, free/busy
 *   slots). Characters and item count are both capped, and `full: true` is the
 *   only way to see every item.
 *
 * Listings that DO take a page token are not item-capped: `pageSize` already
 * bounds them (default 20, max 100) and the cursor lets the caller continue.
 * Their entry is only a character backstop for long message bodies.
 */
import type { ActionBound } from './factory.js'

/** How to fetch the rest when a body of text was cut. */
export const TEXT_HINT = 'Pass full: true for the complete payload, or raise max_chars up to 100000.'

/** How to fetch the rest when an unpaged listing was cut. */
export const LIST_HINT =
  'Pass full: true for every item, or narrow the request; this listing returns one response with no cursor.'

/** How to fetch the rest when a paged listing hit the character backstop. */
export const PAGE_HINT = 'Request another page with pageToken, or raise max_chars up to 100000.'

const textRead = (): ActionBound => ({ hint: TEXT_HINT })
const listRead = (items: number): ActionBound => ({ items, hint: LIST_HINT })
const pagedRead = (): ActionBound => ({ hint: PAGE_HINT })

/**
 * docs: `getText` is bounded inside the service by `limit`/`preview`, so the
 * tool-layer bound is only needed for `getSuggestions`, which returns one entry
 * per suggested edit -- a heavily commented document yields thousands.
 */
export const DOCS_BOUNDS: Record<string, ActionBound> = {
  getSuggestions: listRead(100)
}

/** slides: deck text, notes, and image lists are whole-presentation reads. */
export const SLIDES_BOUNDS: Record<string, ActionBound> = {
  getText: textRead(),
  getMetadata: listRead(100),
  getImages: listRead(100),
  getSpeakerNotes: listRead(100)
  // getSlideThumbnail is left whole on purpose: its payload is one base64 image,
  // so a character cap would return a corrupt image rather than a shorter list.
}

/** gmail: message bodies and threads; listings page, but bodies are long. */
export const GMAIL_BOUNDS: Record<string, ActionBound> = {
  get: textRead(),
  search: pagedRead(),
  listLabels: listRead(100),
  modify: textRead(),
  modifyThread: textRead()
}

/** drive: search and comment threads page; findFolder is an exact-name lookup. */
export const DRIVE_BOUNDS: Record<string, ActionBound> = {
  search: pagedRead(),
  getComments: pagedRead(),
  findFolder: listRead(50)
}

/** chat: spaces, messages and threads page; findSpaceByName scans locally. */
export const CHAT_BOUNDS: Record<string, ActionBound> = {
  listSpaces: pagedRead(),
  findSpaceByName: listRead(50),
  getMessages: pagedRead(),
  listThreads: pagedRead()
}

/** calendar: event lists, single events with descriptions, free/busy slots. */
export const CALENDAR_BOUNDS: Record<string, ActionBound> = {
  listCalendars: listRead(100),
  listEvents: pagedRead(),
  getEvent: textRead(),
  findFreeTime: listRead(50)
}

/** tasks: paged listings with long notes. */
export const TASKS_BOUNDS: Record<string, ActionBound> = {
  listTaskLists: pagedRead(),
  listTasks: pagedRead()
}

/** people: profiles and relations arrays. */
export const PEOPLE_BOUNDS: Record<string, ActionBound> = {
  getUserProfile: textRead(),
  getMe: textRead(),
  getUserRelations: listRead(50)
}

/** forms: the definition, its items, and response payloads. */
export const FORMS_BOUNDS: Record<string, ActionBound> = {
  get: textRead(),
  listResponses: pagedRead(),
  getResponse: textRead()
}
