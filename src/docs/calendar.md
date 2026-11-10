# Calendar Tool

## Actions
- listCalendars
- createEvent
- listEvents
- getEvent
- deleteEvent
- updateEvent
- respondToEvent
- findFreeTime

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- maxResults (listEvents): events per page, default 20, clamped to 1–100.
- pageToken (listEvents): continuation token from a previous `listEvents` page.
- timeMin / timeMax (listEvents): RFC3339 window; defaults to now until 30 days out.
- max_chars (listEvents, getEvent, listCalendars, findFreeTime): maximum
  characters returned, integer 1–100000; defaults to 20000.
- full (listEvents, getEvent, listCalendars, findFreeTime): `true` returns the
  complete payload and ignores `max_chars` and the item bound.

## Bounds

An event description can be arbitrarily long, so every read is bounded:

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `listEvents` | 20,000 characters; pages of `maxResults` (default 20) | next `pageToken`, or `full: true` |
| `getEvent` | 20,000 characters | raise `max_chars` (up to 100000), or `full: true` |
| `listCalendars` | 20,000 characters, 100 calendars | `full: true` |
| `findFreeTime` | 20,000 characters, 50 slots | `full: true` |

`listEvents` returns `{events, nextPageToken}`, so a window with more events than
one page is still fully reachable. Cancelled events and events the caller has
declined are filtered out before the page is built.

Truncation is never silent. A cut payload carries
`_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
with
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`.
