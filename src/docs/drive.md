# Drive Tool

## Actions
- findFolder
- createFolder
- search
- trashFile
- renameFile
- getComments
- moveFile
- downloadFile

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- pageSize (search, getComments): items per page, default 20, clamped to 1–100.
- pageToken (search, getComments): continuation token from a previous page.
- query (search): a Drive query string or a Google Drive URL.
- max_chars (search, getComments, findFolder): maximum characters returned,
  integer 1–100000; defaults to 20000.
- full (search, getComments, findFolder): `true` returns the complete payload and
  ignores `max_chars` and the item bound.

## Bounds

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `search` | 20,000 characters; pages of `pageSize` (default 20) | next `pageToken`, or `full: true` |
| `getComments` | 20,000 characters; pages of `pageSize` (default 20) | next `pageToken`, or `full: true` |
| `findFolder` | 20,000 characters, 50 name matches | `full: true` |

Truncation is never silent. A cut payload carries
`_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
with
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`.
Both paged listings return their `nextPageToken`, so a caller continues with the
token rather than re-querying.

## Result shape

`search` returns `{files, nextPageToken}` and `getComments` returns
`{comments, nextPageToken}` -- a listing always carries the cursor of the page
it returned, even when a comment thread's replies make it long enough to be cut.
`findFolder` returns the matching folder array.
