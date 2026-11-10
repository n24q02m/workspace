# Tasks Tool

## Actions
- listTaskLists
- listTasks
- createTask
- updateTask
- completeTask
- deleteTask

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- maxResults (listTaskLists, listTasks): items per page, default 20, clamped to 1–100.
- pageToken (listTaskLists, listTasks): continuation token from a previous page.
- max_chars (listTaskLists, listTasks): maximum characters returned, integer
  1–100000; defaults to 20000.
- full (listTaskLists, listTasks): `true` returns the complete payload and ignores
  `max_chars`.

## Bounds

A task's `notes` field has no length limit, so both listings are bounded at
20,000 characters by default; raise `max_chars` (up to 100000) or pass
`full: true` for the complete payload. The page size (`maxResults`, default 20,
max 100) and `nextPageToken` are what bound the number of items -- a page is
always returned with its cursor, so nothing past it is lost.

Truncation is never silent: a cut payload carries
`_truncation: {truncated, total_characters, returned_characters, note}` with
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`.
