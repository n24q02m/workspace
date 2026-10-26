<h1 align="center">workspace</h1>

<p align="center">
  <strong>Google Workspace MCP — Docs, Drive, Calendar, Gmail, Sheets, Slides, Tasks, Chat, People, Forms</strong>
</p>

> **ARCHIVED 2026-09-13** — This repository is no longer maintained. Use the official Google Workspace APIs instead of this MCP server. Existing installations keep working but receive no updates or support.

<p align="center">
  <a href="https://mcp.n24q02m.com/get-started/modes-overview/"><img alt="Mode: stdio · http remote oauth" src="https://img.shields.io/badge/mode-stdio_%C2%B7_http--remote--oauth-5C6BC0"></a>
  <a href="https://github.com/n24q02m/workspace/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/n24q02m/workspace/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/n24q02m/workspace/actions/workflows/cd.yml"><img alt="CD" src="https://github.com/n24q02m/workspace/actions/workflows/cd.yml/badge.svg"></a>
  <a href="https://codecov.io/gh/n24q02m/workspace"><img alt="codecov" src="https://codecov.io/gh/n24q02m/workspace/graph/badge.svg"></a>
  <a href="https://github.com/n24q02m/workspace/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/n24q02m/workspace?display_name=tag&sort=semver"></a>
  <a href="https://github.com/python-semantic-release/python-semantic-release"><img alt="semantic-release" src="https://img.shields.io/badge/semantic--release-e10079?logo=semantic-release&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/n24q02m/workspace"></a>
</p>

<p align="center">
  <a href="https://mcp.n24q02m.com">Docs</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="https://github.com/n24q02m/workspace/discussions">Community</a>
</p>

<!-- BEGIN: AUTO-GENERATED-CROSS-PROMO -->
<details>
  <summary><strong>Sister projects from n24q02m</strong> (click to expand)</summary>

| Project | Tagline | Tag |
|---|---|---|
| [agent-chat-plugin](https://github.com/n24q02m/agent-chat-plugin) | Peer AI agents chat in a shared folder — no human relay, no orchestrator, wor... | Tooling |
| [better-code-review-graph](https://github.com/n24q02m/better-code-review-graph) | Knowledge graph for token-efficient code reviews -- semantic search and call-... | MCP |
| [better-drive](https://github.com/n24q02m/better-drive) | 2-way Google Drive sync with .driveignore filter — rclone engine, Windows tray | Tooling |
| [better-email-mcp](https://github.com/n24q02m/better-email-mcp) | IMAP/SMTP email for AI agents -- read, send, organize folders, and manage att... | MCP |
| [better-godot-mcp](https://github.com/n24q02m/better-godot-mcp) | Composite MCP server for Godot Engine -- 17 composite tools for AI-assisted g... | MCP |
| [better-notion-mcp](https://github.com/n24q02m/better-notion-mcp) | Markdown-first Notion for AI agents -- pages, databases, blocks, and comments... | MCP |
| [better-semantic-release](https://github.com/n24q02m/better-semantic-release) | Drop-in python-semantic-release fork with built-in release-safety guards (orp... | Tooling |
| [better-telegram-mcp](https://github.com/n24q02m/better-telegram-mcp) | Telegram for AI agents -- messages, chats, media, and contacts across both bo... | MCP |
| [better-workspace-mcp](https://github.com/n24q02m/better-workspace-mcp) | Google Workspace MCP server (Docs/Drive/Calendar/Gmail/Sheets/Slides/Tasks/Ch... | MCP |
| [claude-plugins](https://github.com/n24q02m/claude-plugins) | Claude Code plugin marketplace for the n24q02m MCP servers -- install web sea... | Marketplace |
| [imagine-mcp](https://github.com/n24q02m/imagine-mcp) | Image and video understanding + generation for AI agents -- across Gemini, Op... | MCP |
| [jules-task-archiver](https://github.com/n24q02m/jules-task-archiver) | Chrome Extension for bulk operations on Jules tasks via batchexecute API -- a... | Tooling |
| [mcp-core](https://github.com/n24q02m/mcp-core) | Shared foundation for building MCP servers -- Streamable HTTP transport, OAut... | MCP |
| [mnemo-mcp](https://github.com/n24q02m/mnemo-mcp) | Persistent AI memory with hybrid search and embedded sync. Open, free, unlimi... | MCP |
| [qwen3-embed](https://github.com/n24q02m/qwen3-embed) | Lightweight Qwen3 text embedding and reranking via ONNX Runtime and GGUF | Library |
| [skret](https://github.com/n24q02m/skret) | Secrets without the server. | CLI |
| [tacet](https://github.com/n24q02m/tacet) | A self-distilling neuro-symbolic cascade that amortises LLM cost across knowl... | Tooling |
| [web-core](https://github.com/n24q02m/web-core) | Shared web infrastructure package for search, scraping, HTTP security, and st... | Library |
| [wet-mcp](https://github.com/n24q02m/wet-mcp) | Open-source MCP server for AI agents: web search, content extraction, and lib... | MCP |

</details>
<!-- END: AUTO-GENERATED-CROSS-PROMO -->

## Table of contents

- [Install](#install)
- [Remote (HTTP mode)](#remote-http-mode)
- [Tools](#tools)
- [Quick start](#quick-start)
- [Multi-account](#multi-account)
- [Documentation](#documentation)
- [Deployment](#deployment)
- [Handover](docs/HANDOVER.md)
- [Contributing](#contributing)
- [License](#license)

## Install

The server runs in two modes: **stdio** (default, single-user, one Google OAuth
client of your own) and **HTTP** (multi-user, per-user bearer tokens). For
stdio, add it to your MCP client config:

```jsonc
{
  "mcpServers": {
    "workspace": {
      "command": "npx",
      "args": ["--yes", "@n24q02m/workspace@latest"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "<your-client-id>.apps.googleusercontent.com",
        "GOOGLE_OAUTH_CLIENT_SECRET": "<your-client-secret>"
      }
    }
  }
}
```

The package is `@n24q02m/workspace` (formerly `@n24q02m/better-workspace-mcp`;
old package receives one final release then freezes). The MCP Registry id stays
`io.github.n24q02m/better-workspace-mcp`, and the legacy `better-workspace-mcp`
command is kept as an alias of `workspace`.

Those two values come from an OAuth 2.0 client of type **Desktop app**, created in
the [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
under APIs & Services → Credentials. Desktop is the right type because the server
receives the consent redirect on a
[loopback address](https://developers.google.com/identity/protocols/oauth2/native-app),
not on a public URL. Enable the Workspace APIs you plan to call on the same
project, and add yourself as a test user while the consent screen is unpublished.

The first run opens the Google consent screen in your browser; the refresh token
is stored encrypted on your machine under `~/.better-workspace/` (a legacy
`~/.better-workspace-mcp/` is read as a fallback), so later runs start without asking again.

The same server can also serve several people over HTTP -- see
[Remote (HTTP mode)](#remote-http-mode).

**Install with an AI agent** -- paste this to your AI coding agent:

> Install MCP server `workspace` following the steps at
> https://raw.githubusercontent.com/n24q02m/claude-plugins/main/plugins/better-workspace-mcp/setup-with-agent.md

## Remote (HTTP mode)

Besides stdio, the server runs as a multi-user HTTP service. Each request carries a
bearer token from a users file (`WORKSPACE_USERS_FILE`), and each user's Google
credentials are kept in their own bucket, keyed by that user's namespace, so one
deployment serves several people without them sharing an account. Google consent for
an HTTP account runs on the host, with `workspace auth --user <namespace>`.

Point your MCP client at the host you deployed it on:

```jsonc
{
  "mcpServers": {
    "workspace": {
      "type": "http",
      "url": "https://<your-host>/mcp"
    }
  }
}
```

### Modes

Two, and only two. There is no proxy or daemon mode: stdio speaks the MCP stdio
transport directly, with no HTTP hop inside it.

| Mode | Selected by | Serves | Google OAuth client |
| --- | --- | --- | --- |
| `stdio` | the default | one user, on their own machine | **Desktop app** |
| `http` | `--http`, `MCP_TRANSPORT=http`, or `TRANSPORT_MODE=http` | several users, one credential bucket per user namespace | **Web application** |

### Two OAuth clients, not one

Google binds redirect URIs to the *type* of the OAuth client, so the two modes
cannot share one. stdio uses a **Desktop** client, which may redirect to any
loopback port. HTTP uses a **Web** client. Keep the two credentials under separate
names: pointing `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` at the Web client on a machine
that also runs stdio breaks every stdio install. That is why
`docker-compose.http.yml` reads the Web pair as `GOOGLE_OAUTH_WEB_CLIENT_ID`/`_SECRET`
and renames it on the way into the container.

### Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | yes | Web client id. The server refuses to start without it. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | yes | Web client secret. Same. |
| `CREDENTIAL_SECRET` | yes | Derives the encryption key of each user's credential store. The server refuses to start without it, rather than fail in the middle of a user's consent. |
| `WORKSPACE_USERS_FILE` | yes in HTTP | Users file that maps each bearer token to a user namespace (hull `multi` auth). Unset uses hull's default location. |
| `PORT` | no | Listen port. `0` (the default) asks the OS for a free one. |
| `HOST` | no | Bind address. Defaults to loopback, so a container needs `0.0.0.0`. |

Credentials are stored on local disk under `~/.better-workspace/`, which is the data volume in the container. A legacy `~/.better-workspace-mcp/` is read as a fallback.

`docker-compose.http.yml` in this repo is these variables written out as a
runnable overlay.

## Tools

One composite tool per Workspace domain, plus `config` and `help`:

| Tool | What it covers |
| --- | --- |
| `docs` | Google Docs -- `getText`, `create`, `writeText`, `getSuggestions`, `replaceText`, `formatText` |
| `drive` | Files and folders -- `search`, `findFolder`, `createFolder`, `moveFile`, `renameFile`, `trashFile`, `downloadFile`, `getComments` |
| `calendar` | Events -- `listCalendars`, `listEvents`, `getEvent`, `createEvent`, `updateEvent`, `deleteEvent`, `respondToEvent`, `findFreeTime` |
| `gmail` | Mail -- `search`, `get`, `send`, `createDraft`, `sendDraft`, `modify`, `batchModify`, `modifyThread`, `downloadAttachment`, `listLabels`, `createLabel` |
| `sheets` | Spreadsheets, read-only -- `getText`, `getRange`, `getMetadata` |
| `slides` | Presentations -- 19 actions covering slides, text, shapes, images, tables, and speaker notes |
| `tasks` | Task lists and tasks -- `listTaskLists`, `listTasks`, `createTask`, `updateTask`, `completeTask`, `deleteTask` |
| `chat` | Google Chat -- `listSpaces`, `findSpaceByName`, `setUpSpace`, `getMessages`, `listThreads`, `sendMessage`, `sendDm`, `findDmByEmail` |
| `people` | Profile lookups -- `getMe`, `getUserProfile`, `getUserRelations` |
| `forms` | Forms -- `create`, `get`, `batchUpdate`, `listResponses`, `getResponse` |
| `time` | Local date/time/timezone helpers (no Google account needed) |
| `config` | Credential state and account management |
| `help` | Full documentation for any tool |

Questions are added to a form with `forms(action="batchUpdate")`, not at `create`;
responses are read-only, because the Forms API cannot write one. Listing or
deleting forms goes through `drive`.

## Quick start

Check that the credentials landed, with the `config` tool. Before the first
consent this reports `awaiting_setup`; afterwards it names the account the server
is acting as:

```json
{ "action": "status" }
```

Then call a domain tool. On `docs`, `create` returns the new document's ID, which
`getText` reads back:

```json
{ "action": "create", "title": "Notes", "content": "First line." }
{ "action": "getText", "documentId": "<id-from-create>" }
```

`time`, `config`, and `help` need no Google account, so they answer even before
consent -- `time` is the quickest check that the server is wired up at all:

```json
{ "action": "getCurrentTime" }
```

To act as a second Google account, see [Multi-account](#multi-account).

## Multi-account

Every domain tool takes an `account` parameter -- the email of the Google account
the call acts as. Omit it and the call runs against the primary account.

```json
{ "action": "search", "query": "is:unread", "account": "work@example.com" }
{ "action": "search", "query": "is:unread" }
```

Those two `gmail` calls read two different mailboxes: the first `work@example.com`,
the second whichever account is primary.

Accounts are managed through the `config` tool:

| Call | Effect |
| --- | --- |
| `config(action="account_add")` | In stdio, returns a URL to open; completing the Google consent there adds one more account. Over HTTP it returns the `workspace auth --user <namespace>` command to run on the host. |
| `config(action="account_list")` | The configured accounts and which one is primary. |
| `config(action="account_remove", account="<email>")` | Forget one account. |
| `config(action="account_set_default", account="<email>")` | Make one account the primary. |

The first account authorized becomes the primary. Removing the primary promotes
one of the remaining accounts; removing the last one puts the server back to
awaiting setup. Naming an account that is not configured is an error that names
it -- the call is never rerouted to the primary, because a silent fallback would
act on the wrong mailbox.

`account_add` chooses its flow by transport. In stdio it starts a temporary loopback
consent server and returns the URL. Over HTTP it does not serve consent; it returns
the `workspace auth --user <namespace>` command for the host.

`value="primary"` is stdio only; remote callers change the default with
`account_set_default`.

### Coming from an earlier single-account build

Credentials stored by a build from before multi-account support are one flat blob
of tokens. The first run afterwards adopts that blob into the multi-account layout
under the account's email. The email comes from the stored `id_token` when it is
present -- no network needed, and that is the usual case. Otherwise the server asks
Google's userinfo endpoint, which needs network access and a token that is still
valid or refreshable.

If neither works, the server reports itself as awaiting setup and opens the browser
OAuth flow even though the stored token may still be fine. Completing that consent
works, and nothing is discarded: the account you just authorized is stored and
becomes the primary, while the old tokens are carried across under the key
`(unidentified)` rather than being overwritten. `config(action="account_list")` then
shows two entries:

```json
{ "accounts": ["(unidentified)", "you@example.com"], "primary": "you@example.com" }
```

Nothing routes to `(unidentified)`: it is never promoted to primary while a real
account remains, and no call reaches it unless you name it explicitly. It is there
so a credential whose owner could not be determined is not silently thrown away.
Remove it once the re-authorized account is working:

```json
{ "action": "account_remove", "account": "(unidentified)" }
```

After a successful adoption -- the usual case -- `config(action="account_list")`
shows exactly one account, and it is the primary.

### Forms scopes and re-consent

The consent screen has requested the Google Forms scopes since before the `forms`
tool existed, so it arrived without a second trip through consent.

Accounts authorized *before* those scopes were added are covered too, but by a
different route: Google accepts `https://www.googleapis.com/auth/drive` in place of
the Forms scopes for every Forms method this server calls, and full `drive` has
been on the consent screen since the first release. Google never widens a token it
has already issued, so if a grant covers neither -- a user may withhold individual
restricted scopes at the consent screen -- the first `forms` call returns a 403
(`Request had insufficient authentication scopes`). Re-authorize just that account
with `config(action="account_add")`, signing in as the same account; the record is
replaced in place, so nothing else changes.

## Documentation

Full docs at **[mcp.n24q02m.com/servers/better-workspace-mcp/](https://mcp.n24q02m.com/servers/better-workspace-mcp/)**:

- [Setup](https://mcp.n24q02m.com/servers/better-workspace-mcp/setup/) -- plugin install, Docker stdio, and Docker HTTP methods
- [Modes overview](https://mcp.n24q02m.com/get-started/modes-overview/) -- stdio (default) and HTTP (multi-user, bearer tokens)
- [Multi-user setup](https://mcp.n24q02m.com/get-started/multi-user/) -- the per-namespace credential model behind [Remote (HTTP mode)](#remote-http-mode)

Every tool also documents itself at runtime: call `help` for the full reference on
any of them, including the exact parameters each action takes.

## Deployment

No hosted endpoint is operated for this server. The supported paths are the
stdio install above and a self-hosted HTTP deployment of your own.

To self-host HTTP mode, run the compose overlay from this repository:

```sh
docker compose -f docker-compose.yml -f docker-compose.http.yml up
```

It builds the `http` image locally and publishes it on host loopback only, at
`GOOGLE_OAUTH_WEB_CLIENT_ID`, `GOOGLE_OAUTH_WEB_CLIENT_SECRET`,
`CREDENTIAL_SECRET`, and `WORKSPACE_USERS_FILE` through your shell or an
`.env` file (see [Environment](#environment)). The users file maps each
bearer token to a user namespace; accounts are added on the host with
`workspace auth --user <namespace>`. For use beyond the local machine, put
your own TLS reverse proxy on the same host in front of it.

Each release also publishes multi-arch container images to Docker Hub and
GHCR; their default stage is the `http` server.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © n24q02m
