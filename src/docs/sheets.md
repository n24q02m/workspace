# Sheets Tool

## Actions
- getText
- getRange
- getMetadata

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- spreadsheetId: spreadsheet ID or URL (all actions).
- range: A1 range for getRange, e.g. `Sheet1!A1:D20`.
- format (getText): `text` (default), `csv`, or `json`.
- max_chars (getText, getRange): maximum characters returned, integer 1–100000; defaults to 20000.
- full (getText, getRange): `true` returns the complete payload and ignores `max_chars`.

## Bounds

`getText` concatenates every cell of every tab and `getRange` serializes every
cell of the requested range, so either can return megabytes. Both are bounded
by default at 20,000 characters, and a bounded response always reports the real
size of the full payload:

- `getText` appends `[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`
  to the returned text. With `format: "json"` the payload stays valid JSON:
  rows are kept in order until the budget is reached and a `_truncation` entry
  carries `total_characters`, `returned_characters`, `returned_rows`,
  `total_rows`, and the same note.
- `getRange` keeps whole rows (a sliced JSON string would not parse) and
  returns `truncated: true` with `total_characters`, `returned_characters`,
  `returned_rows`, `total_rows`, and `truncation_note`. Rows are dropped from
  the end of the range, so narrow the range to read the rest.

To read beyond the bound, raise `max_chars` up to 100000, ask for one tab or a
narrower range, or pass `full: true`.

`getMetadata` returns tab names and dimensions only, so it is not bounded.
