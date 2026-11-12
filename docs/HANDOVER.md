# workspace Handover

## Ownership and scope

`workspace` is a TypeScript MCP server for Google Workspace. The operational surface is this repository and its published package `@n24q02m/workspace` (formerly `@n24q02m/better-workspace-mcp`). OCI VM infrastructure, user-owned OMP profiles, scheduled synchronization, and stable-promotion decisions are outside this pack.

**Version: 0.6.0** -- the `version` field of `package.json`, which is the version of the published package. Re-read that field before relying on this line, because a release moves it.

The server supports two transports:

- **stdio**: one local user, loopback Desktop OAuth, encrypted local credential storage.
- **HTTP**: multiple callers, bearer tokens from a users file (`WORKSPACE_USERS_FILE`), credential storage isolated per user namespace; each caller can select one of that namespace's configured Google accounts.

## Current service/tool inventory

The MCP registry exposes one composite tool per domain plus `config` and `help`:

| Tool | Operations | Output/pagination controls |
|---|---|---|
| `docs` | getText, create, writeText, getSuggestions, replaceText, formatText | `getText` defaults to 20,000 characters; `preview` uses 2,000 unless `limit` is supplied; `limit` accepts 1–100,000 and marks truncation explicitly. `getSuggestions` is bounded at 20,000 characters and 100 suggestions (`max_chars`, `full: true`). Writes return bounded status/IDs. |
| `drive` | findFolder, createFolder, search, trashFile, renameFile, getComments, moveFile, downloadFile | `search` and `getComments` use `pageSize` and `pageToken` and return `nextPageToken`; `findFolder` caps at 50 name matches. Bounded reads: 20,000 characters by default, `max_chars` 1–100,000, `full: true` for the whole payload. Downloads write to an explicitly selected local path. |
| `calendar` | listCalendars, createEvent, listEvents, getEvent, deleteEvent, updateEvent, respondToEvent, findFreeTime | `listEvents` uses time windows, `maxResults`, and `pageToken`, and always returns `nextPageToken`; free-time uses an explicit time range and duration. Bounded reads: 20,000 characters by default, `max_chars` 1–100,000, `full: true`. |
| `gmail` | search, get, downloadAttachment, modify, batchModify, modifyThread, send, createDraft, sendDraft, listLabels, createLabel | Search defaults to a bounded `maxResults`; `pageToken` continues reads; message `format` selects payload size. `get`/`modify`/`modifyThread`/`search`/`listLabels` are bounded: 20,000 characters by default, `max_chars` 1–100,000, `full: true` for the whole body. |
| `sheets` | getText, getRange, getMetadata | Reads are range-scoped; `getText`/`getRange` default to 20,000 characters (`max_chars` 1–100,000, `full: true`) and mark truncation. |
| `slides` | presentation and slide/text/shape/image/table/notes operations | Metadata and range-like operations are resource-scoped; downloads require an explicit destination. `getText`/`getMetadata`/`getImages`/`getSpeakerNotes` are bounded: 20,000 characters by default, `max_chars` 1–100,000, `full: true`, and at most 100 slide or image entries; `getSlideThumbnail` returns one whole base64 image. |
| `tasks` | listTaskLists, listTasks, createTask, updateTask, completeTask, deleteTask | List calls support bounded `maxResults` and `pageToken`; both listings are bounded at 20,000 characters by default (`max_chars`, `full: true`). |
| `chat` | listSpaces, findSpaceByName, setUpSpace, getMessages, listThreads, sendMessage, sendDm, findDmByEmail | `listSpaces`, `getMessages`, and `listThreads` support `pageSize` and `pageToken` and always return `nextPageToken`; `findSpaceByName` scans locally and caps at 50 matches. All four are bounded at 20,000 characters by default (`max_chars`, `full: true`). |
| `people` | getMe, getUserProfile, getUserRelations | Profile lookups are resource-scoped. All three are bounded at 20,000 characters by default (`max_chars`, `full: true`); `getUserRelations` keeps at most 50 relations. |
| `forms` | create, get, batchUpdate, listResponses, getResponse | `listResponses` supports `pageSize`, `pageToken`, and `filter`. `get`/`getResponse`/`listResponses` are bounded at 20,000 characters by default (`max_chars`, `full: true`). |
| `time` | getCurrentTime, getTimeZone | Local-only; no Google account required. |
| `config` | status, setup_start, setup_reset, setup_complete, set, account_add, account_list, account_remove, account_set_default | Account lists are per caller and bounded by the configured credential store. |
| `help` | topic documentation | Reads one allowlisted Markdown topic at a time. |

The authoritative runtime registry is `src/tools/domains/index.ts`; `src/tools/registry.ts` derives tool definitions, help topics, and resources from that list, and `src/cli/tools.ts` derives one CLI subcommand per domain tool from it -- plus the `config-tool` alias for the infra `config` tool and the hand-written `help` spec. Both front doors call the same dispatch in `src/tools/dispatch.ts` (credential gate, domain validation, error wrapping), so a tool cannot behave differently over MCP and over the CLI. Do not add a second inventory or a second dispatch.

### CLI surface

`workspace <tool> <action> [--param <value>]... [--json]` runs any of those tools from a terminal without an MCP client. `--json` prints `{"tool", "action", "result"}` on stdout; a tool failure goes to stderr with exit 1, unparseable argv with exit 2. Operator commands (`auth`, `config`, `status`, `logout`, `doctor`, `token`, and the removed `relay`) stay hull built-ins and are listed separately from the tool subcommands by `workspace --help`. `config` is the one tool name an operator command already owns, so the MCP `config` tool is reached as `config-tool` (`TOOL_ALIASES` in `src/cli/tools.ts`, whose spec is derived from the tool definition in `src/tools/registry.ts`); a parity test walks `TOOL_NAMES` and fails on any tool that is neither an operator command nor a subcommand. The CLI never starts a server for a tool call, and it resolves credentials through the same store (`STORE_PLUGIN`) the server uses.

## Build, test, and run

```sh
bun install
bun run check
bun run test
bun run build
```

`bun run type-check` checks the server TypeScript project. `bun run build` produces `build/` and `bin/cli.mjs`. CI is the authoritative source for hosted checks; local commands are source evidence only.

Smoke the CLI surface without Google credentials: `node bin/cli.mjs time getCurrentTime --json` (the `time` tool needs no account). `src/cli/tools.integration.test.ts` covers that path with the real dispatch, so the suite fails if the CLI ever stops reaching it.

For local stdio operation, provide `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` for a Desktop OAuth client. For HTTP operation, provide the Web client pair, `CREDENTIAL_SECRET`, and `WORKSPACE_USERS_FILE`; set `HOST=0.0.0.0` in a container. Never commit these values.

## Auth and isolation invariants

- HTTP credential storage is keyed by the user namespace from the users file, then contains that namespace's Google accounts.
- A requested account that is not configured is an error; it never silently falls back to the primary account.
- `account_add` uses a loopback consent in stdio; over HTTP it returns the `workspace auth --user <namespace>` command to run on the host.
- HTTP accounts are added only by the host CLI `workspace auth --user`; the server exposes no consent route.
- Tests use isolated temporary stores and hermetic protocol fixtures; real Google consent is a manual smoke scenario, not a CI test.

## Release and rollback

Releases are dispatched from `.github/workflows/cd.yml` with the repository's semantic-release workflow. Verify the exact source commit, workflow run/job conclusions, package version, tag OID, release asset, and published package metadata separately. A source merge or package asset alone is not runtime evidence. Stable promotion remains a separate group-wide decision.

Rollback is forward-only through a reviewed source change and a new release. Do not hand-create tags or rewrite published versions. If a release workflow fails after publication activity, preserve the exact run/job IDs and inspect provider state before retrying.

## Restructure and modernization map

1. Keep domain operations in the existing service/domain modules; adapters must not call each other or create a second credential store.
2. Preserve `src/tools/domains/index.ts` as the registry source of truth. Add a domain by extending its `DomainDef`, action list, input properties, and matching documentation.
3. Pagination controls for Drive (`search`, `getComments`), Gmail, Chat (`listSpaces`, `getMessages`, `listThreads`), Calendar (`listEvents`), Tasks, and Forms use a default of 20 and clamp caller values to 1–100; explicit continuation tokens remain available and every paged listing returns its `nextPageToken`. Docs `getText` uses an explicit 20,000-character default, 2,000-character preview, and 1–100,000 `limit` bound with truncation markers. Every other read whose payload can grow (slides, Gmail bodies, Drive comments, chat, calendar, tasks, people, forms) is bounded by `src/tools/helpers/bounds.ts`: 20,000 characters by default, `max_chars` 1–100,000, `full: true` to bypass, listings without a cursor capped at 50–100 items, and a `_truncation` marker that names the true size and never cuts a cursor.
4. Keep vendored service files aligned with upstream unless a local fork is recorded in `NOTICE` and covered by the sync test.
5. Treat package name, repository identity, MCP server ID, OAuth identity, data path, and endpoint as independent migration surfaces. The repository, npm package, container image, server name, and MCP Registry id are now `workspace`; the entry published under `io.github.n24q02m/better-workspace-mcp` stays on the registry as a frozen historical release, and the legacy `better-workspace-mcp` bin alias intentionally keeps the old name. The data path is now `~/.workspace` (hull keys it off the store plugin name, which is the short product name); a store an earlier release wrote under `~/.better-workspace` is copied forward on startup, and the older `~/.better-workspace-mcp` is read as a fallback.

### First week

- Run `bun run check`, `bun run test`, and `bun run build` from a clean worktree.
- Exercise the hermetic stdio and multi-account protocol tests.
- Review open PRs individually; reject duplicate bot proposals and keep assistant-authored narration out of product commits.
- For any auth change, rerun account isolation and namespace-isolation tests.

### Weeks 2–3

- Reverify the current published artifact against the exact source OID.
- Run the real supported domain round trip only with an isolated test account and explicit cleanup.
- Measure tool-list size and representative output sizes before changing caps; preserve page-token semantics.
- Review dependency and workflow updates with their exact CI conclusions.

### Months 1–3

- Pilot any domain API/CLI parity on one operation family before broader adapter work.
- Produce an exact file, caller, data-path, registry, OAuth, and rollback map before any identity migration.
- Keep provider spend, hosted deployment, and stable promotion behind their respective point-of-risk controls.
