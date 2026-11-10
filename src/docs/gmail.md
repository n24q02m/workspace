# Gmail Tool

## Actions
- search
- get
- downloadAttachment
- modify
- batchModify
- modifyThread
- send
- createDraft
- sendDraft
- listLabels
- createLabel

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- max_chars (get, modify, modifyThread, search, listLabels): maximum characters
  returned, integer 1–100000; defaults to 20000.
- full (get, modify, modifyThread, search, listLabels): `true` returns the
  complete payload and ignores `max_chars` and the item bound.
- maxResults (search): messages per page, default 20, clamped to 1–100.
- pageToken (search): continuation token from a previous `search` page.
- format (get): `minimal`, `full` (default), `raw`, or `metadata`.

## Bounds

A message body has no size limit, so the reads that can carry one are bounded by
default:

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `get` | 20,000 characters | raise `max_chars` (up to 100000), or `full: true` |
| `modify` | 20,000 characters | raise `max_chars`, or `full: true` |
| `modifyThread` | 20,000 characters | raise `max_chars`, or `full: true` |
| `search` | 20,000 characters; pages of `maxResults` (default 20) | next `pageToken`, or `full: true` |
| `listLabels` | 20,000 characters, 100 labels | `full: true` |

`format: "raw"` returns the base64 message, which is the largest payload this
tool can produce; it is bounded by `max_chars` too.

Truncation is never silent. A cut payload carries
`_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
with
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`,
and `search` always returns its `nextPageToken` so the caller can keep paging
instead of losing the rest of the result set. Labels and other short fields are
never the part that gets cut.

## Result shape

`get` returns the parsed message (`id`, `threadId`, `labelIds`, `snippet`,
`subject`, `from`, `to`, `date`, `body`, `attachments`) rather than the raw MIME
tree. `search` returns `{messages, nextPageToken, resultSizeEstimate}`.
