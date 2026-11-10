# Chat Tool

## Actions
- listSpaces
- sendMessage
- findSpaceByName
- getMessages
- sendDm
- findDmByEmail
- listThreads
- setUpSpace

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- pageSize (listSpaces, getMessages, listThreads): items per page, default 20,
  clamped to 1–100.
- pageToken (listSpaces, getMessages, listThreads): continuation token from a
  previous page.
- max_chars (listSpaces, getMessages, listThreads, findSpaceByName): maximum
  characters returned, integer 1–100000; defaults to 20000.
- full (listSpaces, getMessages, listThreads, findSpaceByName): `true` returns the
  complete payload and ignores `max_chars` and the item bound.
- unreadOnly (getMessages): return only unread messages.
- orderBy / filter (getMessages): Chat API ordering and filter expressions.

## Bounds

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `listSpaces` | 20,000 characters; pages of `pageSize` (default 20) | next `pageToken`, or `full: true` |
| `getMessages` | 20,000 characters; pages of `pageSize` (default 20) | next `pageToken`, or `full: true` |
| `listThreads` | 20,000 characters; pages of `pageSize` (default 20) | next `pageToken`, or `full: true` |
| `findSpaceByName` | 20,000 characters, 50 matches | `full: true` |

All three listings return `nextPageToken`, including `listSpaces` -- a listing
that dropped its cursor would make every space past the first page unreachable.

Truncation is never silent. A cut payload carries
`_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
with
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`.

## Result shape

`listSpaces` returns `{spaces, nextPageToken}`; `getMessages` and `listThreads`
return `{messages, nextPageToken}` and `{threads, nextPageToken}`;
`findSpaceByName` returns the matching spaces (it scans the space list locally,
because the Chat API cannot filter by display name).
