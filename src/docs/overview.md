# workspace tools

One composite tool per Google Workspace service, plus two infra tools.

- **docs** -- Google Docs (get/write text, create, suggestions, replace, format).
- **drive** -- files and folders (find, create, search, trash, rename, move, comments, download).
- **calendar** -- calendars and events (list, create, update, delete, respond, find free time).
- **gmail** -- mail (search, read, send, drafts, labels, modify messages and threads).
- **sheets** -- spreadsheets (text, ranges, metadata).
- **slides** -- presentations (text, slides, shapes, images, tables, speaker notes).
- **tasks** -- task lists and tasks (list, create, update, complete, delete).
- **chat** -- Google Chat spaces, messages and DMs.
- **people** -- contacts and profiles (own profile, user profile, relations).
- **forms** -- Google Forms (create, read, edit questions, read responses).
- **time** -- local date/time/timezone helpers. Needs no Google account.
- **config** -- server configuration, credential state, and the Google accounts this server can act as.
- **help** -- full documentation for a topic.

`help(topic="<name>")` returns the full document for any domain tool above, for
`config`, or for `overview`. The same documents are exposed as MCP resources
under `workspace://docs/<name>`.

## Response size

A read can return megabytes from one call -- a document body, a mail message, a
deck's text, a response with hundreds of comments. Every action whose payload can
grow is bounded by default at 20,000 characters:

- raise it with `max_chars` (1–100,000), or pass `full: true` for the complete
  payload. `docs` spells the same envelope as `limit` (plus a 2,000-character
  `preview`);
- a paged listing keeps its page size (default 20, clamped to 1–100) and always
  returns its `nextPageToken`; a listing with no cursor also caps how many items
  one response carries (50–100);
- truncation is never silent. A cut JSON payload carries
  `_truncation: {truncated, total_characters, returned_characters, omitted_items?, note}`
  and stays parseable; a cut text payload ends with
  `[Content truncated: showing <kept> of <total> characters (<omitted> omitted). ...]`.
  A pagination cursor is never cut.

Each tool's page (`help(topic="<name>")`) lists its own bound and escape hatch.

## Multi-account

Every domain tool takes `account="<email>"`, choosing which Google account the
call acts as. Omit it and the call runs against the primary account. Manage the
set of accounts with `config`: `account_add`, `account_list`, `account_remove`,
`account_set_default` -- see `help(topic="config")`.

Naming an account that is not configured is an error that names it; the call is
never silently rerouted to the primary. `time` accepts `account` for signature
parity only -- it needs no Google account.

## Multi-user

Served over HTTP, the server separates callers as well as accounts. The two are
nested axes, not two words for one thing:

- **User** -- who is calling. Taken from the `sub` claim of the token that
  authenticated the request. Every `sub` gets its own credential store, encrypted
  under its own key, so one deployment serves several people without any of them
  reaching another's credentials.
- **Account** -- which Google account a call acts as, chosen with `account=`.
  Accounts live *inside* one user's store.

So `account_list` answers "which Google accounts have I connected", never "which
accounts does this deployment know about". Two users who each connect
`shared@example.com` end up with two independent records, and a `primary` set by
one is not a `primary` for the other.

In stdio there is one user by construction -- whoever is at the machine -- so only
the inner axis is visible. The account behaviour is identical in both.
