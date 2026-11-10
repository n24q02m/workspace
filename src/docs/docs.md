# docs

Google Docs operations, dispatched by `action` to the vendored `DocsService`.

## account

`account` is the email address of the Google account the call should act as.
Omit it and the call runs against the primary account. List what is configured,
and which one is primary, with `config(action="account_list")`. Naming an account
that is not configured is an error -- the call is never silently rerouted to the
primary.

## Actions

| Action | Required params | Optional params | Description |
| --- | --- | --- | --- |
| `getSuggestions` | `documentId` | `max_chars`, `full` | Suggested insertions, deletions and style changes, one entry per suggestion. Bounded at 20,000 characters and 100 suggestions by default; raise `max_chars` (1–100,000) or pass `full: true` for every entry. Truncated output carries a `_truncation` entry naming the true size. |
| `getText` | `documentId` | `tabId`, `limit`, `preview` | Read the document's text. Returns plain text for a single-tab document, or JSON with all tabs when the doc has more than one tab. Output defaults to 20,000 characters; `preview` uses 2,000 unless `limit` is supplied. `limit` accepts 1–100,000, and truncated output includes an explicit marker. |
| `create` | `title` | `content` | Create a new Google Doc, optionally seeded with initial text content. |
| `writeText` | `documentId`, `text` | `position` (default `"end"`), `tabId` | Insert text at `"beginning"`, `"end"`, or a positive integer character index. |
| `replaceText` | `documentId`, `findText`, `replaceText` | `tabId` | Find-and-replace all occurrences of `findText` with `replaceText`, across all tabs unless `tabId` is given. |
| `formatText` | `documentId`, `formats` | `tabId` | Apply one or more formatting operations. Each entry in `formats` is `{startIndex, endIndex, style, url?}`; `style` is a heading level (`heading1`..`heading6`, `normalText`), a text style (`bold`, `italic`, `underline`, `strikethrough`), `"code"`, or `"link"` (requires `url`). |

## Result shape

Every action returns the MCP `CallTool` result shape directly from
`DocsService` (`{content: [{type: "text", text}], isError?: true}`) -- the
`docs` tool does not re-wrap or transform it.

## Examples

```json
{ "action": "getText", "documentId": "1AbCdEf...", "preview": true }
{ "action": "writeText", "documentId": "1AbCdEf...", "text": "Hello", "position": "end" }
{ "action": "formatText", "documentId": "1AbCdEf...", "formats": [{ "startIndex": 1, "endIndex": 6, "style": "bold" }] }
```
