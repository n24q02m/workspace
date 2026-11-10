# People Tool

## Actions
- getUserProfile
- getMe
- getUserRelations

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- resourceName (getUserProfile, getUserRelations): `people/me` or `people/<id>`.
- relationType (getUserRelations): filter relations by type, e.g. `spouse`.
- max_chars (all actions): maximum characters returned, integer 1–100000;
  defaults to 20000.
- full (all actions): `true` returns the complete payload and ignores `max_chars`
  and the item bound.

## Bounds

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `getUserProfile` | 20,000 characters | raise `max_chars` (up to 100000), or `full: true` |
| `getMe` | 20,000 characters | raise `max_chars`, or `full: true` |
| `getUserRelations` | 20,000 characters, 50 relations | `full: true` |

A person's relations list comes from one `people.get` call with no cursor, so it
is capped by item count as well as characters; `full: true` is the way to see
every relation.

Truncation is never silent: a cut payload carries
`_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
with
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`.
