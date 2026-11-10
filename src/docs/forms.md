# forms

Google Forms operations, dispatched by `action` to `FormsService`. That service is
ours rather than vendored upstream code -- `gemini-cli-extensions/workspace` has no
Forms coverage -- so it lives in `src/services/`, outside the vendored boundary
described in `NOTICE`.

## account

- account (optional): email of the Google account to use; defaults to the primary account.

List what is configured, and which one is primary, with
`config(action="account_list")`. Naming an account that is not configured is an
error -- the call is never silently rerouted to the primary.

### Scopes

Forms uses two scopes, both already on this server's consent screen: `forms.body`
(`create`, `get`, `batchUpdate`) and `forms.responses.readonly` (`listResponses`,
`getResponse`). Nothing new is requested here.

Google accepts `https://www.googleapis.com/auth/drive` in place of either one --
a form is a Drive file, and every Forms method this tool calls lists `drive` among
its alternatives. This server has requested full `drive` since its first release,
which is *before* the two Forms scopes were added, so an account authorized back
then should still work without re-consenting.

That matters because Google never widens a token it has already issued. If an
account's grant somehow covers neither `drive` nor the Forms scopes -- Google lets
a user withhold individual restricted scopes at the consent screen -- the first
Forms call returns HTTP 403, usually reading `Request had insufficient
authentication scopes`. That is not a bug in this tool, and retrying will not clear
it.

Fix it by re-authorizing that one account:

1. `config(action="account_add")`
2. Open the URL it returns and sign in as **the same account**.

The consent screen is forced (`prompt=consent`), so the new token carries the
current scope set, and the account's stored record is replaced in place -- it keeps
its position and stays primary if it was primary. There is no need to
`account_remove` first, and doing so would leave you with nothing if you then
abandoned the consent screen.

## Actions

| Action | Required params | Optional params | Description |
| --- | --- | --- | --- |
| `create` | `title` | `documentTitle` | Create a new, empty form. The API copies **only** the title and `documentTitle`; questions, description and settings are rejected on create and must follow in a `batchUpdate`. Returns `formId`, `title`, `responderUri`. |
| `get` | `formId` | -- | The full form definition: info, items, `responderUri`, `revisionId`, and `linkedSheetId` if responses are also collecting into a Sheet. |
| `batchUpdate` | `formId`, `requests` | -- | Apply Forms API update requests -- the only way to add or change questions, the description, or settings after creation. Returns the API's `replies`. |
| `listResponses` | `formId` | `pageSize`, `pageToken`, `filter` | Submitted responses, newest page first. `filter` supports `timestamp > <RFC3339>` and `timestamp >= <RFC3339>`, e.g. `timestamp > 2026-01-01T00:00:00Z`. Returns `{responses, nextPageToken?}`; `responses` is `[]` when there are none. |
| `getResponse` | `formId`, `responseId` | -- | One submitted response. |

## formId

Accepts the ID on its own, or the editor URL
`https://docs.google.com/forms/d/<formId>/edit`.

The public responder link, `https://docs.google.com/forms/d/e/<responderId>/viewform`,
carries a **different** identifier that the API does not accept. Passing one is
refused by name rather than sent on to fail as an opaque 404. A `forms.gle/...`
short link cannot be resolved without following it -- open the form and copy the
editor URL instead.

## What this tool cannot do

These are missing from the Google Forms API itself, not omitted here:

- **List your forms.** The API has no list method. Use the `drive` tool:
  `{"action": "search", "query": "mimeType='application/vnd.google-apps.form'"}`.
- **Delete a form.** Per the API's own description, "a form is created in Drive, and
  deleting a form or changing its access protections is done via the Drive API" --
  so trash it with `drive(action="trashFile", fileId="<id from the drive search>")`.
- **Rename the Drive file.** `documentTitle` can be set on `create` but cannot be
  changed by `batchUpdate`; renaming goes through `drive(action="renameFile")`.
  `batchUpdate` can still change the `title` respondents see.
- **Write, edit or delete a response.** `forms.responses` is read-only in the API;
  responses exist only because a respondent submitted the form. `forms.responses.readonly`
  is therefore the whole surface, not a restriction chosen here.
- **Subscribe to new responses** (`forms.watches`). It needs a Cloud Pub/Sub topic,
  which this server does not provision.
- **Publish or unpublish** (`forms.setPublishSettings`). Not exposed by this tool.
  Forms created here take the API default -- published, accepting responses.

If a form has a linked response Sheet, `get` returns its `linkedSheetId`, and the
`sheets` tool reads bulk responses from it more cheaply than paging `listResponses`.

## Bounds

A form definition and a submitted response both grow with the number of
questions, and `listResponses` returns whole submissions, so the reads are
bounded by default:

| Action | Default bound | Escape hatch |
| --- | --- | --- |
| `get` | 20,000 characters | raise `max_chars` (up to 100000), or `full: true` |
| `getResponse` | 20,000 characters | raise `max_chars`, or `full: true` |
| `listResponses` | 20,000 characters; pages of `pageSize` (default 20) | next `pageToken`, or `full: true` |

`listResponses` always returns its `nextPageToken`. Truncation is never silent: a
cut payload carries
`_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
with
`[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`,
and a JSON payload stays parseable.

## Result shape

Every action returns `{content: [{type: "text", text}]}` with `text` holding the
JSON payload. Failures are **not** returned as a successful-looking result: the
error propagates and the tool layer renders it as `isError: true` with a sanitized
message, so a caller can tell a failure from data.

## Examples

```json
{ "action": "create", "title": "Team retro" }
{ "action": "get", "formId": "https://docs.google.com/forms/d/1AbCdEf.../edit" }
{
  "action": "batchUpdate",
  "formId": "1AbCdEf...",
  "requests": [
    {
      "createItem": {
        "item": {
          "title": "What went well?",
          "questionItem": { "question": { "required": true, "textQuestion": { "paragraph": true } } }
        },
        "location": { "index": 0 }
      }
    }
  ]
}
{ "action": "listResponses", "formId": "1AbCdEf...", "filter": "timestamp > 2026-07-01T00:00:00Z" }
{ "action": "getResponse", "formId": "1AbCdEf...", "responseId": "ACYDBNi..." }
```
